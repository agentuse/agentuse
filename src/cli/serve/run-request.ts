/**
 * The POST /run request and response shapes, their parsing, and how a run's
 * originating surface is reported to telemetry. Moved verbatim out of serve.ts.
 */
import type { WebUIClientSurface } from "../../telemetry";
import { readRequestBody } from "./http";
import { WorkerExecuteError, WorkerExecuteResult } from "./worker-types";
import { IncomingMessage } from "http";

export interface RunRequest {
  agent: string;
  project?: string;
  prompt?: string;
  model?: string;
  timeout?: number;
  maxSteps?: number;
  sessionId?: string;
  /**
   * Fire-and-forget: start the run, return its (pre-assigned) session id
   * immediately with 202, and let the run continue in the background. Used by
   * the web "Run" button so it can redirect straight to the live session view.
   */
  detach?: boolean;
  /** Best-effort caller report. It is intentionally not treated as auth. */
  reportedSurface?: 'web_ui';
}

export function webUIClientSurface(value: string | string[] | undefined): WebUIClientSurface {
  const header = Array.isArray(value) ? value[0] : value;
  return header === 'mac_app' || header === 'mac_setup' ? header : 'web';
}

export function reportedSurfaceForRun(body: RunRequest, clientSurface: WebUIClientSurface = 'web'): 'web_ui' | 'mac_app' | 'api' {
  if (body.reportedSurface !== 'web_ui') return 'api';
  return clientSurface === 'mac_app' ? 'mac_app' : 'web_ui';
}

export interface RunResponse {
  success: true;
  sessionId?: string;
  result: {
    text: string;
    finishReason?: string;
    duration: number;
    tokens?: { input: number; output: number };
    toolCalls: number;
  };
}

export function workerExecutionErrorResponse(error: WorkerExecuteError): {
  status: number;
  body: {
    success: false;
    status: 'incomplete' | 'error';
    error: WorkerExecuteError['error'];
    result?: WorkerExecuteResult['result'];
  };
} {
  const status = error.error.code === 'TIMEOUT'
    ? 504
    : error.error.code === 'ABORTED'
      ? 499
      : error.error.code === 'INCOMPLETE'
        ? 422
        : 500;
  return {
    status,
    body: {
      success: false,
      status: error.error.code === 'INCOMPLETE' ? 'incomplete' : 'error',
      error: error.error,
      ...(error.result && { result: error.result }),
    },
  };
}

export function parseRequestBody(req: IncomingMessage): Promise<RunRequest> {
  return new Promise((resolve, reject) => {
    readRequestBody(req).then((body) => {
      try {
        const parsed = JSON.parse(body);
        if (!parsed.agent || typeof parsed.agent !== "string") {
          reject(new Error("Missing required field: agent"));
          return;
        }
        resolve(parsed as RunRequest);
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    }, reject);
  });
}
