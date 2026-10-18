import { appendFileSync, mkdirSync, renameSync, rmSync, statSync } from 'node:fs';
import path from 'node:path';

/**
 * Every request AgentUse Cloud made to this computer, one JSON line each, so
 * "who reached my computer through Cloud, and when" has an answer. Written by
 * the tunnel (src/cloud/tunnel.ts), which sees every relayed request, and
 * kept only on this computer.
 *
 * Paths are logged without their query string: queries carry `?token=`
 * session links, file paths and search text. Bodies are never logged.
 */

export interface AccessEntry {
  at: string;
  /** `http` for a dashboard request, `mcp` for a chat's tool call. */
  kind: 'http' | 'mcp';
  /** For a live stream: `open` when it starts, `close` when it ends. Absent for an ordinary request. */
  stream?: 'open' | 'close';
  /** Cloud user id of the person, when Cloud named one. */
  user?: string;
  role?: string;
  ip?: string;
  userAgent?: string;
  method?: string;
  path?: string;
  /** MCP method and tool, e.g. `tools/call list_agents`. */
  mcp?: string;
  status?: number;
  durationMs?: number;
  bytes?: number;
  /** Set on requests that change something: decision, continue, resume, stop, reopen, run, test-run. */
  action?: string;
  sessionId?: string;
  error?: string;
}

export interface AccessLogOptions {
  /** Roll the file at this size. Default 10 MB. */
  maxBytes?: number;
  /** Rolled files to keep beside the current one. Default 4, so 5 files in all. */
  keep?: number;
}

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024;
const DEFAULT_KEEP = 4;

export class AccessLog {
  private readonly maxBytes: number;
  private readonly keep: number;

  constructor(readonly file: string, options: AccessLogOptions = {}) {
    this.maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.keep = options.keep ?? DEFAULT_KEEP;
  }

  /** Best effort: a full disk or a missing folder must never fail the request it records. */
  write(entry: AccessEntry): void {
    try {
      mkdirSync(path.dirname(this.file), { recursive: true });
      this.rollIfFull();
      appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    } catch {
      // Recording is secondary to the request.
    }
  }

  /** access.jsonl → access.1.jsonl → … → access.<keep>.jsonl, the oldest dropped. */
  private rollIfFull(): void {
    let size: number;
    try {
      size = statSync(this.file).size;
    } catch {
      return;
    }
    if (size < this.maxBytes) return;
    rmSync(this.rolled(this.keep), { force: true });
    for (let index = this.keep - 1; index >= 1; index -= 1) {
      try {
        renameSync(this.rolled(index), this.rolled(index + 1));
      } catch {
        // Not there yet.
      }
    }
    renameSync(this.file, this.rolled(1));
  }

  private rolled(index: number): string {
    const ext = path.extname(this.file);
    return `${this.file.slice(0, -ext.length)}.${index}${ext}`;
  }
}
