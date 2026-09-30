/**
 * Request/response plumbing shared by every serve route group.
 *
 * Extracted verbatim from serve.ts so the route modules under routes/ can send
 * responses without importing values back out of serve.ts (which would make the
 * import graph circular at runtime).
 */
import type { IncomingMessage, ServerResponse } from "http";

export class RequestBodyTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Request body too large; limit is ${limitBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

export const MAX_JSON_BODY_BYTES = 1_000_000;

export function readRequestBody(req: IncomingMessage, limitBytes = MAX_JSON_BODY_BYTES): Promise<string> {
  return new Promise((resolve, reject) => {
    // Buffer raw chunks and decode once at the end. `body += chunk` implicitly
    // utf8-decodes each Buffer separately, corrupting any multi-byte character
    // (emoji/CJK) that straddles a chunk boundary and can make JSON.parse throw
    // on an otherwise-valid body.
    const chunks: Buffer[] = [];
    let bytes = 0;
    let done = false;
    const fail = (error: Error) => {
      if (done) return;
      done = true;
      reject(error);
    };
    req.on("data", (chunk: Buffer) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > limitBytes) {
        fail(new RequestBodyTooLargeError(limitBytes));
      } else {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
    });
    req.on("end", () => {
      if (done) return;
      done = true;
      resolve(Buffer.concat(chunks).toString("utf8"));
    });
    req.on("error", (error) => {
      if (done && error.name === "AbortError") return;
      if (!done) fail(error);
    });
  });
}

export function parseJSONBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    readRequestBody(req).then((body) => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    }, reject);
  });
}

export function sendJSON(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export function sendError(res: ServerResponse, status: number, code: string, message: string) {
  sendJSON(res, status, { success: false, error: { code, message } });
}

export function sendRequestParseError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof RequestBodyTooLargeError) {
    sendError(res, 413, "REQUEST_TOO_LARGE", err.message);
    return true;
  }
  return false;
}

/**
 * A request whose URL cannot be parsed or percent-decoded. Route matchers call
 * `new URL()` and `decodeURIComponent()` on raw client input, and both throw on
 * malformed values like `//[` or `%E0`.
 */
function isMalformedRequestError(err: unknown): boolean {
  if (err instanceof URIError) return true;
  return err instanceof TypeError && (err as NodeJS.ErrnoException).code === "ERR_INVALID_URL";
}

/**
 * Wrap the async serve handler so a throw becomes an HTTP error instead of an
 * unhandled rejection. Without this, one malformed URL from an unauthenticated
 * client exits the whole daemon.
 */
export function guardRequestHandler(
  handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
  onUnexpectedError: (err: unknown, req: IncomingMessage) => void,
): (req: IncomingMessage, res: ServerResponse) => void {
  return (req, res) => {
    handler(req, res).catch((err: unknown) => {
      const malformed = isMalformedRequestError(err);
      if (!malformed) onUnexpectedError(err, req);
      if (res.headersSent) {
        res.destroy();
        return;
      }
      if (malformed) sendError(res, 400, "BAD_REQUEST", "Malformed request URL");
      else sendError(res, 500, "INTERNAL_ERROR", "Internal server error");
    });
  };
}

export function sendHTML(res: ServerResponse, status: number, html: string) {
  // These dashboard pages are dynamic and embed build-specific inline JS, so
  // never serve a stale copy from a tab that was open across a restart/upgrade.
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}
