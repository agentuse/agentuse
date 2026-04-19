/**
 * Tee the current process's stdout/stderr into a flat log file.
 *
 * Used by `agentuse serve` to persist what the user sees in the foreground
 * so it can be tailed after the fact (via `agentuse serve logs`). No
 * rotation: the file grows for the life of the process; stale files are
 * cleaned up when `listServers()` sweeps the dead PID.
 *
 * External rotation (logrotate, newsyslog) can be pointed at the files if
 * the operator wants it.
 */

import { createWriteStream, type WriteStream } from "fs";

// Strip CSI escape sequences (SGR colors and most cursor/erase sequences).
// Matches: ESC [ (params) final-byte
const CSI_RE = /\x1b\[[\d;?]*[@-~]/g;

function stripAnsi(text: string): string {
  return text.replace(CSI_RE, "");
}

type WriteFn = typeof process.stdout.write;

export interface LogFileHandle {
  path: string;
  close(): Promise<void>;
}

export interface StartLogFileOptions {
  path: string;
}

export function startLogFile(options: StartLogFileOptions): LogFileHandle {
  // Truncate on open: a fresh process owns this filename exclusively, and
  // listServers()'s stale sweep should have cleaned any prior PID's file.
  // Truncating guards against the rare case where the sweep didn't run.
  const stream: WriteStream = createWriteStream(options.path, { flags: "w" });
  stream.on("error", () => {
    // Swallow: logging failures must never crash the server.
  });

  const origStdout: WriteFn = process.stdout.write.bind(process.stdout);
  const origStderr: WriteFn = process.stderr.write.bind(process.stderr);

  function toText(chunk: unknown, encoding?: BufferEncoding): string {
    if (typeof chunk === "string") return chunk;
    if (chunk instanceof Uint8Array) return Buffer.from(chunk).toString(encoding ?? "utf8");
    return String(chunk);
  }

  function makeTee(orig: WriteFn): WriteFn {
    const tee = (chunk: unknown, encodingOrCb?: unknown, cb?: unknown): boolean => {
      const encoding = typeof encodingOrCb === "string" ? (encodingOrCb as BufferEncoding) : undefined;
      try {
        stream.write(stripAnsi(toText(chunk, encoding)));
      } catch {
        // ignore
      }
      // Forward with the exact original shape
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (orig as any)(chunk, encodingOrCb, cb);
    };
    return tee as WriteFn;
  }

  process.stdout.write = makeTee(origStdout);
  process.stderr.write = makeTee(origStderr);

  let closed = false;
  return {
    path: options.path,
    async close(): Promise<void> {
      if (closed) return;
      closed = true;
      process.stdout.write = origStdout;
      process.stderr.write = origStderr;
      await new Promise<void>((resolve) => {
        stream.end(() => resolve());
      });
    },
  };
}
