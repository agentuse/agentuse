import { Command } from "commander";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { WebClient } from "@slack/web-api";
import { timingSafeEqual } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { join, resolve, basename, relative, extname } from "path";
import { existsSync, realpathSync } from "fs";
import { readFile, stat } from "fs/promises";
import { glob } from "glob";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import chalk from "chalk";
import * as dotenv from "dotenv";
import { parseAgent } from "../parser";
import { type AgentChunk } from "../runner";
import { findProjectRoot, resolveProjectContext } from "../utils/project";
import { logger, LogLevel, executionLog, approvalLog } from "../utils/logger";
import { printLogo } from "../utils/branding";
import { initStorage } from "../storage/index.js";
import { Scheduler, type Schedule, type SerializedSchedule } from "../scheduler";
import { FileWatcher } from "../watcher";
import { telemetry, parseModel } from "../telemetry";
import { version as packageVersion } from "../../package.json";
import { registerServer, unregisterServer, updateServer, listServers, formatUptime, getDefaultLogFilePath, type ServerEntry, type ServerProjectEntry } from "../utils/server-registry";
import { startLogFile, type LogFileHandle } from "../utils/log-file";
import { loadGlobalConfig, expandHome, getGlobalConfigPath, getGlobalEnvPath, loadGlobalEnv, type GlobalConfig } from "../utils/global-config";
import { SlackApprovalSocket, updateSlackApprovalRequestStatus, type SlackApprovalDecision, type SlackApprovalThreadComment, type SlackApprovalThreadCommentResult, type SlackRunThreadCommentResult } from "../slack/approval";
import { homedir } from "os";
import type { StoreItem } from "../store/types";
import type { SessionTrigger } from "../session/types";
import { sessionViewToken, validateSessionToken } from "../utils/session-token";
import {
  approvalListThemeStyles,
  escapeHtml,
  renderMarkdownArtifact,
  normalizeApiPath
} from "./serve/ui";
import { FAVICON_SVG } from "./serve/brand";
import { WebAssets, renderWebAssetsMissingPage } from "./serve/static";
import { ApprovalEventHub, ApprovalListEventHub } from "./serve/sse";
import {
  findStoreItem,
  isSafeStoreName,
  listProjectStores,
  listStoreRows,
  type StoreBrowserRows,
  type StoreBrowserSummary
} from "./serve/stores";

const APPROVAL_LIST_SSE_INTERVAL_MS = 10_000;
const SESSION_LIST_SSE_INTERVAL_MS = 10_000;

interface RunRequest {
  agent: string;
  project?: string;
  prompt?: string;
  model?: string;
  timeout?: number;
  maxSteps?: number;
  sessionId?: string;
}

interface RunResponse {
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

interface WorkerExecuteOptions {
  agentPath?: string;
  projectRoot: string;
  prompt?: string | undefined;
  model?: string | undefined;
  timeout?: number | undefined;
  maxSteps?: number | undefined;
  debug?: boolean | undefined;
  sessionId?: string | undefined;
  toolResult?: unknown;
  resumeToken?: string | undefined;
  trigger?: SessionTrigger | undefined;
}

interface WorkerExecuteResult {
  success: true;
  result: {
    text: string;
    finishReason?: string;
    duration: number;
    tokens?: { input: number; output: number };
    toolCalls: number;
    sessionId?: string;
    approvalUrl?: string;
  };
}

interface WorkerExecuteError {
  success: false;
  error: {
    code: string;
    message: string;
  };
}

interface WorkerApprovalInfoResult {
  success: true;
  approval: ApprovalPageInfo;
}

interface WorkerSessionStatusResult {
  success: true;
  session: SessionStatusInfo;
}

interface ExpiredApproval {
  sessionId: string;
  agentId: string;
  agentName: string;
  prompt?: string;
  expiresAt: number;
  suspendedAt?: number;
  channelMessage?: { type?: string; channel?: string; ts?: string; actionTs?: string; url?: string };
}

interface WorkerSweepExpiredResult {
  success: true;
  expired: ExpiredApproval[];
}

type ApprovalSummaryStatus = 'pending' | 'approved' | 'rejected' | 'commented' | 'expired' | 'errored';
type ApprovalSessionFilter = 'pending' | 'completed' | 'errored';
type SessionStatusFilter = 'running' | 'suspended' | 'completed' | 'error';
type SessionWindowFilter = `${number}h` | `${number}d` | 'all';
const APPROVAL_LIST_DEFAULT_DAYS = 30;
const SESSION_LIST_DEFAULT_WINDOW: SessionWindowFilter = '24h';

interface ApprovalSummary {
  sessionId: string;
  agentId: string;
  agentName: string;
  agentDescription?: string;
  agentFilePath?: string;
  status: ApprovalSummaryStatus;
  sessionStatus: string;
  prompt?: string;
  summary?: string;
  risk?: string;
  suspendedAt?: number;
  expiresAt?: number;
  createdAt?: number;
  decisionAt?: number;
  decisionStatus?: string;
  decisionComment?: string;
  decisionReviewer?: string;
  resumeToken?: string;
  errorCode?: string;
  errorMessage?: string;
  channelMessage?: { type?: string; channel?: string; ts?: string; actionTs?: string; url?: string };
  channels?: {
    slack?: Array<{ channel: string; ts: string; channelId?: string; events: Array<'approval' | 'completion' | 'failure'> }>;
  };
}

interface WorkerListApprovalsResult {
  success: true;
  approvals: ApprovalSummary[];
}

type ApprovalRow = ApprovalSummary & { project: string };

interface ApprovalListPayload {
  success: true;
  multiProject: boolean;
  approvals: ApprovalRow[];
  buckets: {
    pending: ApprovalRow[];
    completed: ApprovalRow[];
    expired: ApprovalRow[];
  };
  window: { days: number | 'all'; createdAfter?: number };
  errors: Array<{ projectId: string; message: string }>;
}

interface SessionSummary {
  sessionId: string;
  parentSessionId?: string;
  agent: {
    id: string;
    name: string;
    description?: string;
    filePath?: string;
  };
  status: string;
  trigger: SessionTrigger;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
  errorMessage?: string;
}

type SessionRow = SessionSummary & { project: string };

interface SessionsPayload {
  success: true;
  sessions: SessionRow[];
  window: { value: string; days?: number | 'all'; hours?: number; createdAfter?: number };
  agent?: string;
  status?: string;
  trigger?: SessionTrigger;
  approval?: string;
  errors: Array<{ projectId: string; message: string }>;
}

interface SessionStatusInfo {
  sessionId: string;
  sessionStatus: string;
  createdAt?: number;
  updatedAt?: number;
  model?: string;
  agent: {
    id: string;
    name: string;
    description?: string;
    filePath?: string;
  };
  errorCode?: string;
  errorMessage?: string;
}

interface ChildSessionSummary {
  sessionId: string;
  agent: {
    id: string;
    name: string;
    description?: string;
    filePath?: string;
  };
  status: string;
  trigger: SessionTrigger;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
  errorMessage?: string;
}

interface WorkerListSessionsResult {
  success: true;
  sessions: SessionSummary[];
}

interface WorkerStopSessionResult {
  success: true;
  stopped: Array<{
    sessionId: string;
    agentId: string;
    agentName: string;
    wasStatus: string;
    stopped: boolean;
  }>;
}

interface ApprovalPageInfo {
  sessionId: string;
  sessionStatus: string;
  createdAt?: number;
  model?: string;
  agent: {
    id: string;
    name: string;
    filePath?: string;
    description?: string;
  };
  prompt?: string;
  summary?: string;
  draft?: string;
  draftUrl?: string;
  artifactUrl?: string;
  context?: string;
  risk?: string;
  surface?: string;
  approvalUrl?: string;
  currentResumeToken?: string;
  expiresAt?: number;
  suspendedAt?: number;
  channelMessage?: {
    type?: string;
    channel?: string;
    ts?: string;
    actionTs?: string;
    url?: string;
  };
  decision?: unknown;
  errorCode?: string;
  errorMessage?: string;
  childSessions?: ChildSessionSummary[];
  tokenUsage?: SessionTokenUsage;
  logs?: ApprovalLogEntry[];
}

interface SessionTokenUsage {
  input: number;
  cachedInput: number;
  output: number;
}

interface ApprovalLogEntry {
  id: string;
  type: string;
  tool?: string;
  status?: string;
  title: string;
  message?: string;
  time?: number;
  subagentSession?: LogSubagentSession;
  details?: ApprovalLogDetails;
}

interface LogSubagentSession extends ChildSessionSummary {
  href?: string;
  command: string;
  displayStatus: string;
}

interface ApprovalLogDetails {
  resumeToken?: string;
  prompt?: string;
  input?: string;
  output?: string;
  summary?: string;
  context?: string;
  risk?: string;
  draft?: string;
  draftUrl?: string;
  artifactUrl?: string;
  /** Project-root-relative paths to local file artifacts, viewable via /sessions/:id/artifacts/*. */
  artifactPaths?: string[];
  decisionStatus?: string;
  decisionComment?: string;
  decisionReviewer?: string;
  errorMessage?: string;
}

/**
 * Agent Worker Manager
 *
 * Spawns and manages a worker process for agent execution.
 * The worker is spawned at serve startup (sync context) where spawn works,
 * and stays alive to handle execution requests via stdin/stdout IPC.
 *
 * This works around the EBADF issue where spawn() fails in async callback
 * contexts (HTTP handlers, scheduler callbacks) in bundled Node.js code.
 */
class AgentWorker {
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private forceKillTimer: NodeJS.Timeout | null = null;
  private pendingRequests: Map<string, {
    resolve: (value: WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSessionStatusResult | WorkerSweepExpiredResult | WorkerListApprovalsResult | WorkerListSessionsResult | WorkerStopSessionResult) => void;
    timeoutId?: NodeJS.Timeout;
  }> = new Map();
  private requestCounter = 0;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;

  constructor(private envOverrides: NodeJS.ProcessEnv = {}) {}

  /**
   * Spawn the worker process. Must be called during server startup (sync context).
   */
  spawn(): Promise<void> {
    // Fork the same CLI with --internal-worker flag
    // This avoids needing a separate worker bundle - more elegant for npm package
    const cliPath = process.argv[1];

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;

      // Timeout if worker doesn't become ready within 10 seconds
      const startupTimeout = setTimeout(() => {
        if (!this.ready) {
          reject(new Error("Worker failed to start within 10 seconds"));
          this.shutdown();
        }
      }, 10000);

      // Clear timeout when ready
      const originalResolve = this.readyResolve;
      this.readyResolve = () => {
        clearTimeout(startupTimeout);
        originalResolve?.();
      };
    });

    this.process = spawn(process.execPath, [cliPath, "--internal-worker"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.envOverrides,
      },
    });

    this.readline = createInterface({
      input: this.process.stdout!,
      terminal: false,
    });

    this.readline.on("line", (line) => {
      this.handleWorkerMessage(line);
    });

    this.process.stderr?.on("data", (data) => {
      logger.debug(`[Worker stderr] ${data.toString().trim()}`);
    });

    this.process.on("error", (err) => {
      logger.error(`Worker process error: ${err.message}`);
      this.handleWorkerDeath();
    });

    this.process.on("exit", (code) => {
      logger.warn(`Worker process exited with code ${code}`);
      this.handleWorkerDeath();
    });

    return this.readyPromise;
  }

  private handleWorkerMessage(line: string) {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line);

      // Handle ready signal
      if (message.type === "ready") {
        this.ready = true;
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
        return;
      }

      // Handle response
      const pending = this.pendingRequests.get(message.id);
      if (pending) {
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }
        this.pendingRequests.delete(message.id);
        pending.resolve(message);
      }
    } catch (err) {
      logger.debug(`Failed to parse worker message: ${line}`);
    }
  }

  private handleWorkerDeath() {
    if (this.forceKillTimer) {
      clearTimeout(this.forceKillTimer);
      this.forceKillTimer = null;
    }
    this.ready = false;
    this.process = null;
    this.readline = null;

    // Reject all pending requests
    for (const pending of this.pendingRequests.values()) {
      if (pending.timeoutId) {
        clearTimeout(pending.timeoutId);
      }
      pending.resolve({
        success: false,
        error: { code: "WORKER_DIED", message: "Worker process died unexpectedly" },
      });
    }
    this.pendingRequests.clear();
  }

  /**
   * Execute an agent via the worker process.
   */
  execute(options: WorkerExecuteOptions): Promise<WorkerExecuteResult | WorkerExecuteError> {
    return this.request({
      type: options.sessionId && !options.agentPath ? "resume" : "execute",
      agentPath: options.agentPath,
      projectRoot: options.projectRoot,
      prompt: options.prompt,
      model: options.model,
      timeout: options.timeout,
      maxSteps: options.maxSteps,
      debug: options.debug,
      sessionId: options.sessionId,
      toolResult: options.toolResult,
      resumeToken: options.resumeToken,
      trigger: options.trigger,
    }) as Promise<WorkerExecuteResult | WorkerExecuteError>;
  }

  stopSession(options: {
    projectRoot: string;
    sessionId: string;
    reason?: string | undefined;
  }): Promise<WorkerStopSessionResult | WorkerExecuteError> {
    return this.request({
      type: "stop-session",
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      reason: options.reason,
      timeout: 30,
    }) as Promise<WorkerStopSessionResult | WorkerExecuteError>;
  }

  continueSession(options: {
    projectRoot: string;
    sessionId: string;
    prompt?: string | undefined;
    debug?: boolean | undefined;
    runChannelHandles?: Array<{ channel: string; ts: string; channelId?: string; events: Array<'approval' | 'completion' | 'failure'> }>;
  }): Promise<WorkerExecuteResult | WorkerExecuteError> {
    return this.request({
      type: "continue-session",
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      prompt: options.prompt,
      debug: options.debug,
      runChannelHandles: options.runChannelHandles,
    }) as Promise<WorkerExecuteResult | WorkerExecuteError>;
  }

  getApprovalInfo(options: {
    projectRoot: string;
    sessionId: string;
    resumeToken?: string;
    allowHistorical?: boolean;
    /**
     * Trusted, serve-set only: bypass the gate-token check and return full
     * approval info (including the current gate's resumeToken). Set this ONLY
     * after the serve process has already authorized the viewer.
     */
    trusted?: boolean;
  }): Promise<WorkerApprovalInfoResult | WorkerExecuteError> {
    return this.request({
      type: "approval-info",
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      resumeToken: options.resumeToken,
      allowHistorical: options.allowHistorical ?? false,
      skipTokenCheck: options.trusted ?? false,
      timeout: 30,
    }) as Promise<WorkerApprovalInfoResult | WorkerExecuteError>;
  }

  getSessionStatusInfo(options: {
    projectRoot: string;
    sessionId: string;
  }): Promise<WorkerSessionStatusResult | WorkerExecuteError> {
    return this.request({
      type: "session-status",
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      timeout: 30,
    }) as Promise<WorkerSessionStatusResult | WorkerExecuteError>;
  }

  sweepExpired(projectRoot: string): Promise<WorkerSweepExpiredResult | WorkerExecuteError> {
    return this.request({
      type: "sweep-expired",
      projectRoot,
      timeout: 30,
    }) as Promise<WorkerSweepExpiredResult | WorkerExecuteError>;
  }

  listApprovals(
    projectRoot: string,
    options: { createdAfter?: number } = {}
  ): Promise<WorkerListApprovalsResult | WorkerExecuteError> {
    return this.request({
      type: "list-approvals",
      projectRoot,
      approvalCreatedAfter: options.createdAfter,
      timeout: 30,
    }) as Promise<WorkerListApprovalsResult | WorkerExecuteError>;
  }

  listSessions(
    projectRoot: string,
    options: { createdAfter?: number; includeSubagents?: boolean } = {}
  ): Promise<WorkerListSessionsResult | WorkerExecuteError> {
    return this.request({
      type: "list-sessions",
      projectRoot,
      sessionsCreatedAfter: options.createdAfter,
      includeSubagents: options.includeSubagents,
      timeout: 30,
    }) as Promise<WorkerListSessionsResult | WorkerExecuteError>;
  }

  private request(options: Record<string, unknown> & { timeout?: number | undefined }): Promise<WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSessionStatusResult | WorkerSweepExpiredResult | WorkerListApprovalsResult | WorkerListSessionsResult | WorkerStopSessionResult> {
    return new Promise((resolve) => {
      if (!this.process || !this.ready) {
        resolve({
          success: false,
          error: { code: "WORKER_NOT_READY", message: "Worker process not ready" },
        });
        return;
      }

      const id = `req-${++this.requestCounter}`;
      const longRunningRequest = options.type === "execute" || options.type === "resume" || options.type === "continue-session";
      const requestTimeoutSeconds = options.timeout ?? (longRunningRequest ? 24 * 60 * 60 : 300);
      const timeoutMs = requestTimeoutSeconds * 1000 + 5000; // Add 5s buffer

      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          pending.resolve({
            success: false,
            error: { code: "TIMEOUT", message: `Request timed out after ${requestTimeoutSeconds}s` },
          });
        }
      }, timeoutMs);

      this.pendingRequests.set(id, { resolve, timeoutId });

      const request = {
        id,
        ...options,
      };

      this.process.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  /**
   * Shutdown the worker process.
   */
  shutdown() {
    const child = this.process;
    if (child) {
      child.stdin?.end();
      child.kill("SIGTERM");
      if (this.forceKillTimer) clearTimeout(this.forceKillTimer);
      this.forceKillTimer = setTimeout(() => {
        if (this.process === child) child.kill("SIGKILL");
      }, 2_000);
      this.forceKillTimer.unref?.();
    }
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    this.ready = false;
  }

  isReady(): boolean {
    return this.ready;
  }
}

function parseRequestBody(req: IncomingMessage): Promise<RunRequest> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
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
    });
    req.on("error", reject);
  });
}

function parseJSONBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => (body += chunk));
    req.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch {
        reject(new Error("Invalid JSON body"));
      }
    });
    req.on("error", reject);
  });
}

function sendJSON(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, code: string, message: string) {
  sendJSON(res, status, { success: false, error: { code, message } });
}

function sendHTML(res: ServerResponse, status: number, html: string) {
  // These dashboard pages are dynamic and embed build-specific inline JS, so
  // never serve a stale copy from a tab that was open across a restart/upgrade.
  res.writeHead(status, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  });
  res.end(html);
}

function approvalListCreatedAfter(requestUrl: URL, now = Date.now()): number | undefined {
  return listCreatedAfter(requestUrl, APPROVAL_LIST_DEFAULT_DAYS, now);
}

function sessionListCreatedAfter(requestUrl: URL, now = Date.now()): number | undefined {
  const filter = sessionWindowFilterValue(requestUrl);
  if (filter === 'all') return undefined;
  const amount = Number(filter.slice(0, -1));
  const unit = filter[filter.length - 1];
  const multiplier = unit === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return now - amount * multiplier;
}

function listCreatedAfter(requestUrl: URL, defaultDays: number, now = Date.now()): number | undefined {
  const daysParam = requestUrl.searchParams.get('days');
  if (daysParam === 'all') return undefined;

  const days = daysParam === null
    ? defaultDays
    : Number(daysParam);
  if (!Number.isFinite(days) || days <= 0) return now - defaultDays * 24 * 60 * 60 * 1000;

  return now - Math.floor(days) * 24 * 60 * 60 * 1000;
}

function sessionDaysFilterValue(requestUrl: URL): SessionWindowFilter {
  return sessionWindowFilterValue(requestUrl);
}

function sessionWindowFilterValue(requestUrl: URL): SessionWindowFilter {
  const windowParam = requestUrl.searchParams.get('window');
  if (windowParam && isSessionWindowFilter(windowParam)) return windowParam;

  const hoursParam = requestUrl.searchParams.get('hours');
  if (hoursParam === '1' || hoursParam === '6' || hoursParam === '24') return `${hoursParam}h`;

  const daysParam = requestUrl.searchParams.get('days');
  if (daysParam === 'all') return 'all';
  if (daysParam !== null) {
    const days = Number(daysParam);
    if (Number.isFinite(days) && days > 0) return `${Math.floor(days)}d`;
  }

  return SESSION_LIST_DEFAULT_WINDOW;
}

function isSessionWindowFilter(value: string): value is SessionWindowFilter {
  if (value === 'all') return true;
  if (value === '1h' || value === '6h' || value === '24h') return true;
  if (value === '7d' || value === '30d' || value === '90d') return true;
  return false;
}

function parseSessionStatusFilter(value: string | undefined): SessionStatusFilter | undefined {
  return value === 'running' || value === 'suspended' || value === 'completed' || value === 'error'
    ? value
    : undefined;
}

function parseApprovalSessionFilter(value: string | undefined): ApprovalSessionFilter | undefined {
  return value === 'pending' || value === 'completed' || value === 'errored'
    ? value
    : undefined;
}

function approvalMatchesSessionFilter(status: ApprovalSummaryStatus, filter: ApprovalSessionFilter): boolean {
  if (filter === 'pending') return status === 'pending';
  if (filter === 'completed') return status === 'approved' || status === 'rejected' || status === 'commented';
  return status === 'expired' || status === 'errored';
}

function sessionMatchesAgentFilter(session: SessionSummary, filter: string): boolean {
  const normalized = filter.trim().toLowerCase();
  if (!normalized) return true;
  return session.agent.id.toLowerCase().includes(normalized) ||
    session.agent.name.toLowerCase().includes(normalized);
}

const ARTIFACT_RAW_MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

/**
 * CSP for script-capable artifacts shown in the (allow-scripts, opaque-origin)
 * preview iframe. Inline script/style is permitted so self-contained dashboards
 * and charts render, but `connect-src 'none'` cuts every network egress path
 * (fetch/XHR/WebSocket/beacon), so a malicious artifact cannot exfiltrate data
 * or pull in remote code. No external script/style hosts: artifacts must inline
 * their own libraries. `base-uri`/`form-action 'none'` block relative-URL and
 * form-submission hijacks.
 */
const ARTIFACT_HTML_CSP =
  "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; " +
  "img-src 'self' data:; font-src 'self' data:; media-src 'self' data:; " +
  "connect-src 'none'; base-uri 'none'; form-action 'none'";

/**
 * CSP for SVG artifacts. SVG can carry inline <script>, and the preview iframe
 * now allows scripts, so block script execution entirely here (default-src
 * 'none' with no script-src) while still letting static SVG with inline styles
 * and embedded data: images render.
 */
const ARTIFACT_SVG_CSP =
  "default-src 'none'; style-src 'unsafe-inline'; img-src 'self' data:; connect-src 'none'";

/**
 * Wrap rendered artifact body (markdown/text/json) in a standalone themed HTML
 * document so it looks right inside the popup iframe. The iframe is sandboxed
 * with scripts disabled, so it cannot detect the theme client-side: the parent
 * page passes its resolved theme via `?theme=`, which we bake into `data-theme`
 * here. When no theme is supplied (e.g. opened directly), default to dark and
 * let the progressive-enhancement script follow prefers-color-scheme in a real
 * (non-sandboxed) tab.
 */
function renderArtifactDocument(title: string, bodyHtml: string, theme?: string): string {
  const resolved = theme === 'light' || theme === 'dark' ? theme : null;
  const themeScript = resolved
    ? ''
    : `<script>(function(){try{var m=window.matchMedia&&window.matchMedia('(prefers-color-scheme: light)').matches;document.documentElement.setAttribute('data-theme',m?'light':'dark');}catch(e){}})();</script>`;
  return `<!doctype html><html data-theme="${resolved ?? 'dark'}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="Content-Security-Policy" content="${ARTIFACT_HTML_CSP}">
<title>${escapeHtml(title)}</title>
<style>
${approvalListThemeStyles()}
html[data-theme] { background: var(--bg); color: var(--fg); }
body { margin: 0; padding: 20px; font-family: var(--sans); color: var(--fg); background: var(--bg); }
.content-markdown { padding: 0; color: var(--fg); font-size: 15px; line-height: 1.6; }
.content-markdown h1, .content-markdown h2, .content-markdown h3, .content-markdown h4 { color: var(--fg); }
.content-markdown code { font-family: var(--mono); background: var(--panel-hover); border: 1px solid var(--line); border-radius: 4px; padding: 1px 4px; }
.content-markdown pre.content-code { background: var(--panel); border: 1px solid var(--line); border-radius: 8px; padding: 12px; overflow: auto; }
.content-markdown pre.content-code code { background: transparent; border: 0; padding: 0; }
.content-frontmatter { border-collapse: collapse; margin: 0 0 24px; width: 100%; font-size: 13px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; overflow: hidden; }
.content-frontmatter th { text-align: left; vertical-align: top; padding: 7px 12px; color: var(--muted); font-weight: 600; white-space: nowrap; width: 1%; }
.content-frontmatter td { padding: 7px 12px; color: var(--fg); overflow-wrap: anywhere; }
.content-frontmatter tr + tr th, .content-frontmatter tr + tr td { border-top: 1px solid var(--line); }
.content-frontmatter td code { font-family: var(--mono); }
.fm-chip { display: inline-block; background: var(--panel-hover); border: 1px solid var(--line); border-radius: 999px; padding: 1px 9px; margin: 1px 2px; font-size: 12px; }
.fm-empty { color: var(--muted); }
pre.artifact-raw { font-family: var(--mono); font-size: 13px; line-height: 1.55; white-space: pre-wrap; overflow-wrap: anywhere; color: var(--fg); }
img { max-width: 100%; height: auto; }
</style>
${themeScript}
</head><body>${bodyHtml}</body></html>`;
}

/**
 * Resolve, authorize, and serve a local file artifact referenced by an
 * `await_human` gate. The path is interpreted relative to the project root and
 * must resolve inside it (no traversal), and a small denylist keeps secrets and
 * internal session state out of reach even if a prompt coaxed the agent into
 * pointing the gate at them. Text/markdown render to a themed doc; html/images/
 * pdf are streamed raw for the iframe to display; everything else downloads.
 */
async function serveSessionArtifact(res: ServerResponse, projectRoot: string, rawPath: string, theme?: string): Promise<void> {
  const decoded = (() => { try { return decodeURIComponent(rawPath); } catch { return rawPath; } })();
  const resolved = resolve(projectRoot, decoded);
  // Lexical containment first. Then, when the target exists, resolve symlinks on
  // both sides and re-check so a link inside the project cannot point the served
  // file at a target outside it. A non-existent path has no realpath to resolve
  // and falls through to the 404 below.
  const realRoot = (() => { try { return realpathSync(projectRoot); } catch { return projectRoot; } })();
  const realResolved = (() => { try { return realpathSync(resolved); } catch { return null; } })();
  if (!isPathInside(projectRoot, resolved) || (realResolved && !isPathInside(realRoot, realResolved))) {
    sendHTML(res, 403, '<!doctype html><title>Artifact</title><p>This artifact path is outside the project.</p>');
    return;
  }
  const rel = relative(projectRoot, resolved);
  const segments = rel.split(/[\\/]+/);
  const blockedRoots = new Set(['.git', 'node_modules']);
  const isBlocked = segments.some((seg) => seg.startsWith('.env'))
    || blockedRoots.has(segments[0])
    || (segments[0] === '.agentuse' && (segments[1] === 'store' || segments[1] === 'sessions' || segments[1] === 'env'));
  if (isBlocked) {
    sendHTML(res, 403, '<!doctype html><title>Artifact</title><p>This artifact path is not viewable.</p>');
    return;
  }
  let fileStat;
  try {
    fileStat = await stat(resolved);
  } catch {
    fileStat = null;
  }
  if (!fileStat || !fileStat.isFile()) {
    sendHTML(res, 404, '<!doctype html><title>Artifact</title><p>Artifact not found.</p>');
    return;
  }
  const MAX_BYTES = 10 * 1024 * 1024;
  if (fileStat.size > MAX_BYTES) {
    sendHTML(res, 413, '<!doctype html><title>Artifact</title><p>Artifact is too large to preview (over 10 MB).</p>');
    return;
  }

  const ext = extname(resolved).toLowerCase();
  const title = basename(resolved);
  const rawMime = ARTIFACT_RAW_MIME[ext];
  if (rawMime) {
    const headers: Record<string, string> = {
      'Content-Type': rawMime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
      // Block cross-origin framing of the token-bearing artifact URL.
      'X-Frame-Options': 'SAMEORIGIN',
    };
    // The in-page preview iframe sandboxes the artifact (allow-scripts, no
    // same-origin), but the "open in tab" link loads this same URL as a
    // top-level document where the iframe sandbox no longer applies. Deliver the
    // `sandbox` directive as an HTTP-header CSP (it is ignored via <meta>) so a
    // directly-opened HTML artifact still gets an opaque origin and cannot reach
    // the serve app's same-origin cookies/storage.
    if (rawMime.startsWith('text/html')) headers['Content-Security-Policy'] = `${ARTIFACT_HTML_CSP}; sandbox allow-scripts`;
    else if (rawMime === 'image/svg+xml') headers['Content-Security-Policy'] = ARTIFACT_SVG_CSP;
    res.writeHead(200, headers);
    res.end(await readFile(resolved));
    return;
  }
  if (ext === '.md' || ext === '.markdown') {
    sendHTML(res, 200, renderArtifactDocument(title, renderMarkdownArtifact(await readFile(resolved, 'utf8')), theme));
    return;
  }
  const textExts = new Set(['.txt', '.log', '.json', '.csv', '.yaml', '.yml', '.xml', '.ts', '.js', '.py', '.sh', '']);
  if (textExts.has(ext)) {
    const body = `<pre class="artifact-raw">${escapeHtml(await readFile(resolved, 'utf8'))}</pre>`;
    sendHTML(res, 200, renderArtifactDocument(title, body, theme));
    return;
  }
  // Unknown binary type: hand it to the browser as a download rather than guess.
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${title.replace(/["\\]/g, '')}"`
  });
  res.end(await readFile(resolved));
}

function compareStoreBrowserSummaries(a: StoreBrowserSummary, b: StoreBrowserSummary): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    || a.name.localeCompare(b.name)
    || a.projectId.localeCompare(b.projectId);
}

interface AgentSummary {
  projectId: string;
  /** Path relative to the project root, as accepted by POST /run. */
  path: string;
  name: string;
  description?: string;
  model: string;
  /** Raw schedule expression when the agent declares one. */
  schedule?: string;
}

interface CollectAgentsResult {
  agents: AgentSummary[];
  errors: Array<{ projectId: string; path: string; message: string }>;
}

/**
 * Parse every loaded agent file and summarize it for the /agents endpoint.
 * Parse errors are collected per-agent rather than failing the whole request.
 */
async function collectAgents(projects: Project[]): Promise<CollectAgentsResult> {
  const agents: AgentSummary[] = [];
  const errors: CollectAgentsResult['errors'] = [];
  for (const project of projects) {
    for (const agentFile of project.agentFiles) {
      try {
        const parsed = await parseAgent(resolveScopedAgentPath(project, agentFile));
        agents.push({
          projectId: project.id,
          path: toProjectRelativeAgentPath(project, agentFile),
          name: parsed.name,
          ...(parsed.config.description && { description: parsed.config.description }),
          model: parsed.config.model,
          ...(parsed.config.schedule && { schedule: parsed.config.schedule }),
        });
      } catch (err) {
        errors.push({ projectId: project.id, path: agentFile, message: (err as Error).message });
      }
    }
  }
  agents.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.path.localeCompare(b.path));
  return { agents, errors };
}

function normalizeSubagentName(value: string): string {
  const fileBase = value.split('/').pop() || value;
  return fileBase
    .replace(/\.agentuse$/i, '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]/g, '_')
    .replace(/-/g, '_');
}

function subagentNameTokens(value: string): string[] {
  return normalizeSubagentName(value)
    .split('_')
    .filter((part) => part.length > 0);
}

function childSessionLogMatchScore(child: ChildSessionSummary, entry: ApprovalLogEntry): number {
  if (!entry.tool?.startsWith('subagent__')) return 0;
  const toolName = normalizeSubagentName(entry.tool.slice('subagent__'.length));
  const candidates = [
    normalizeSubagentName(child.agent.id),
    normalizeSubagentName(child.agent.name || ''),
  ];
  if (candidates.includes(toolName)) return 100;
  if (candidates.some((candidate) => candidate.includes(toolName) || toolName.includes(candidate))) return 80;

  const toolTokens = subagentNameTokens(entry.tool.slice('subagent__'.length));
  if (toolTokens.length > 0) {
    const candidateTokens = new Set([
      ...subagentNameTokens(child.agent.id),
      ...subagentNameTokens(child.agent.name || ''),
    ]);
    const matched = toolTokens.filter((token) => candidateTokens.has(token));
    if (matched.length === toolTokens.length) return 70;
    if (matched.length > 0 && matched.length / toolTokens.length >= 0.5) return 40;
  }

  const timeDelta = typeof entry.time === 'number'
    ? Math.abs(child.createdAt - entry.time)
    : Number.POSITIVE_INFINITY;
  return timeDelta <= 5_000 ? 10 : 0;
}

function renderChildSessionStatus(child: ChildSessionSummary): string {
  if (child.status === 'error' && child.errorCode === 'USER_STOPPED') return 'stopped';
  if (child.status === 'error' && child.errorCode === 'TIMEOUT') return 'timeout';
  return child.status;
}

function enrichChildSessionForLog(
  child: ChildSessionSummary,
  childSessionHref?: (sessionId: string) => string
): LogSubagentSession {
  return {
    ...child,
    displayStatus: renderChildSessionStatus(child),
    command: `agentuse sessions show ${child.sessionId.substring(0, 12)} --all-search`,
    ...(childSessionHref && { href: childSessionHref(child.sessionId) }),
  };
}

function childSessionLogEntry(
  child: ChildSessionSummary,
  childSessionHref?: (sessionId: string) => string
): ApprovalLogEntry {
  const session = enrichChildSessionForLog(child, childSessionHref);
  return {
    id: `subagent-session-${child.sessionId}`,
    type: 'subagent',
    status: session.displayStatus,
    title: `${child.agent.name || child.agent.id} ${session.displayStatus}`,
    time: child.createdAt,
    subagentSession: session,
  };
}

function logsWithChildSessions(
  logs: ApprovalLogEntry[] = [],
  childSessions: ChildSessionSummary[] = [],
  childSessionHref?: (sessionId: string) => string
): ApprovalLogEntry[] {
  if (childSessions.length === 0) return logs;

  const matchedChildIds = new Set<string>();
  const enrichedLogs = logs.map((entry) => {
    if (entry.subagentSession) {
      matchedChildIds.add(entry.subagentSession.sessionId);
      return entry;
    }
    const child = childSessions
      .filter((candidate) => !matchedChildIds.has(candidate.sessionId))
      .map((candidate) => ({
        child: candidate,
        score: childSessionLogMatchScore(candidate, entry),
        timeDelta: typeof entry.time === 'number'
          ? Math.abs(candidate.createdAt - entry.time)
          : Number.POSITIVE_INFINITY,
      }))
      .filter((candidate) => candidate.score > 0)
      .sort((a, b) => b.score - a.score || a.timeDelta - b.timeDelta || a.child.sessionId.localeCompare(b.child.sessionId))[0]?.child;
    if (!child) return entry;
    matchedChildIds.add(child.sessionId);
    return {
      ...entry,
      subagentSession: enrichChildSessionForLog(child, childSessionHref),
    };
  });

  for (const child of childSessions) {
    if (!matchedChildIds.has(child.sessionId)) {
      enrichedLogs.push(childSessionLogEntry(child, childSessionHref));
    }
  }

  return enrichedLogs.sort((a, b) => (a.time ?? 0) - (b.time ?? 0) || a.id.localeCompare(b.id));
}

function isEndedSessionStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'error';
}

/**
 * Whether a request bypasses the global `Authorization: Bearer` header gate.
 *
 * Exempt: any `/approvals/*` route (legacy, token-authenticated) and, only on
 * the non-API surface, the unified session page `/sessions/:id`, its action
 * subroutes `/sessions/:id/{decision,continue,status,stop}`, and the artifact
 * viewer subpath `/sessions/:id/artifacts/*`. These carry their own capability
 * auth (session token / api key / local); the artifact handler validates the
 * `?token=` session token via `sessionAuthorized` before serving any file.
 *
 * NOT exempt (stays header-gated): `/sessions` (the list page), and every
 * `/api/*` route including `/api/sessions` and `/api/sessions/:id`. The `isApi`
 * qualifier on the session branch is the security boundary that keeps the JSON
 * session endpoints authenticated on an exposed host.
 */
function isHeaderGateExemptRoute(routePath: string, isApi: boolean): boolean {
  const legacyApprovalRoute = routePath.match(/^\/approvals\/([^/?#]+)(?:\/(requested|status|decision|continue))?$/);
  if (legacyApprovalRoute && legacyApprovalRoute[1] !== 'events') return true;
  if (isApi) return false;
  if (routePath === '/sessions/events') return false;
  return /^\/sessions\/[^/?#]+(?:\/(?:decision|continue|status|stop|events|artifacts\/.+))?$/.test(routePath);
}

/**
 * GET routes that render a browser page and therefore serve the SPA shell
 * (the client routes by URL and fetches its own data). Mirrors the set of
 * server-rendered pages: home, agents, schedules, stores (+item/detail),
 * sessions, and the approvals list. `/approvals/:id` is excluded so it keeps
 * 302-redirecting; `/sessions/:id` is excluded too because it needs a dedicated
 * branch that converts a legacy gate token into a session-view token before
 * serving the shell (see sessionPageMatch).
 */
function isSpaPageRoute(routePath: string): boolean {
  switch (routePath) {
    case '/':
    case '/agents':
    case '/schedules':
    case '/stores':
    case '/sessions':
    case '/approvals':
      return true;
  }
  if (/^\/stores\/[^/?#]+(?:\/[^/?#]+)?$/.test(routePath)) return true; // /stores/:s and /stores/:s/:item
  return false;
}

function canContinueApprovalSession(options: {
  approval: ApprovalPageInfo;
  resuming?: boolean | undefined;
  continuing?: boolean | undefined;
  error?: string | undefined;
}): boolean {
  const { approval, resuming, continuing, error } = options;
  return isEndedSessionStatus(approval.sessionStatus) &&
    !resuming &&
    !continuing &&
    !error &&
    Boolean(approval.agent.filePath);
}

function isExposedHost(host: string): boolean {
  return host !== "127.0.0.1" && host !== "localhost";
}

function validateApiKey(req: IncomingMessage, expectedKey: string | undefined): boolean {
  if (!expectedKey) return true;

  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith("Bearer ")) return false;

  const providedKey = authHeader.slice(7);
  if (!providedKey) return false;

  // Constant-time comparison to prevent timing attacks
  try {
    const expected = Buffer.from(expectedKey);
    const provided = Buffer.from(providedKey);
    return expected.length === provided.length && timingSafeEqual(expected, provided);
  } catch {
    return false;
  }
}

interface Project {
  id: string;
  /** Detected project/state root. Owns .agentuse/store, sessions, env, plugins. */
  root: string;
  /** Directory used for agent discovery and relative API agent paths. */
  scopeRoot: string;
  envFile: string;
  agentFiles: string[];
}

function resolveScopedAgentPath(project: Project | Omit<Project, 'agentFiles'>, agentPath: string): string {
  return resolve(project.scopeRoot, agentPath);
}

function toProjectRelativeAgentPath(project: Project | Omit<Project, 'agentFiles'>, agentPath: string): string {
  return relative(project.root, resolveScopedAgentPath(project, agentPath));
}

function isPathInside(parent: string, child: string): boolean {
  const rel = relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !rel.startsWith('/'));
}

function collectDir(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function resolveProjectFromPath(rawPath: string, idOverride?: string): Omit<Project, 'agentFiles'> {
  const scopeRoot = resolve(expandHome(rawPath));
  if (!existsSync(scopeRoot)) {
    throw new Error(`Directory not found: ${scopeRoot}`);
  }
  const root = findProjectRoot(scopeRoot);
  const envLocal = resolve(root, '.env.local');
  const envFile = existsSync(envLocal) ? envLocal : resolve(root, '.env');
  const id = idOverride ?? basename(scopeRoot);
  return { id, root, scopeRoot, envFile };
}

function loadServeProjectEnvironment(projectSeeds: Array<Omit<Project, 'agentFiles'>>): string[] {
  const loaded: string[] = [];
  if (projectSeeds.length === 1 && existsSync(projectSeeds[0].envFile)) {
    dotenv.config({ path: projectSeeds[0].envFile, override: false, quiet: true });
    loaded.push(projectSeeds[0].envFile);
  }

  return loaded;
}

export function createServeCommand(): Command {
  const serveCmd = new Command("serve")
    .description("Start an HTTP server to run agents via API")
    .option("-p, --port <number>", "Port to listen on (default: 12233 or config.serve.port)")
    .option("-H, --host <string>", "Host to bind to (default: 127.0.0.1 or config.serve.host)")
    .option("--public-url <url>", "Externally reachable base URL used in approval review links (or config.serve.publicUrl)")
    .option("-C, --directory <path>", "Serve agent files from this directory; project state is detected upward (repeat for multi-project). Overrides config.serve.projects.", collectDir, [] as string[])
    .option("--default <id>", "In multi-project mode, the project id to route POST /run when no `project` field is supplied")
    .option("-d, --debug", "Enable debug mode")
    .option("--no-auth", "Disable API key requirement for exposed hosts (dangerous)")
    .option("--no-log-file", "Disable the per-server log file (stdout/stderr tee)")
    .action(async (options: { port?: string; host?: string; publicUrl?: string; directory: string[]; default?: string; debug?: boolean; auth: boolean; logFile: boolean }) => {
      // Load global config once; hard-fail on malformed config so users don't silently get defaults.
      let globalConfig: GlobalConfig | null = null;
      try {
        globalConfig = loadGlobalConfig();
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
      const serveCfg = globalConfig?.serve;
      if (serveCfg && options.debug) {
        logger.debug(`Loaded global config from ${getGlobalConfigPath()}`);
      }
      const loadedServeEnvFiles: string[] = [];
      const loadedGlobalEnv = loadGlobalEnv();
      if (loadedGlobalEnv) {
        loadedServeEnvFiles.push(loadedGlobalEnv);
      }

      // Precedence: explicit CLI flag > config > built-in default.
      const effectivePortRaw = options.port ?? (serveCfg?.port !== undefined ? String(serveCfg.port) : "12233");
      const port = parseInt(effectivePortRaw, 10);
      if (isNaN(port) || port <= 0 || port > 65535) {
        console.error("Invalid port number");
        process.exit(1);
      }
      const effectiveHost = options.host ?? serveCfg?.host ?? "127.0.0.1";
      const serverUrl = `http://${effectiveHost}:${port}`;
      const effectivePublicUrl = (options.publicUrl ?? serveCfg?.publicUrl ?? process.env.AGENTUSE_RESUME_PUBLIC_URL ?? serverUrl).replace(/\/$/, '');
      try {
        const parsedPublicUrl = new URL(effectivePublicUrl);
        if (parsedPublicUrl.protocol !== 'http:' && parsedPublicUrl.protocol !== 'https:') {
          throw new Error('invalid protocol');
        }
      } catch {
        console.error(chalk.red("Invalid public URL"));
        console.error(chalk.dim("Use --public-url with an http:// or https:// URL, e.g. https://agentuse.example.com"));
        process.exit(1);
      }

      // Commander boolean flags have no "unset" signal for defaults, so:
      // CLI --no-auth forces false; otherwise config value wins if set; default true.
      const effectiveAuth = options.auth === false ? false : (serveCfg?.auth ?? true);
      const effectiveLogFile = options.logFile === false ? false : (serveCfg?.logFile ?? true);

      // Check API key requirement for exposed hosts
      const apiKey = process.env.AGENTUSE_API_KEY;

      if (isExposedHost(effectiveHost) && !apiKey && effectiveAuth) {
        console.error(chalk.red("Error: API key required when binding to exposed host"));
        console.error(chalk.dim("Set AGENTUSE_API_KEY environment variable or use --no-auth / serve.auth=false to bypass (dangerous)"));
        process.exit(1);
      }

      // Configure logging
      if (options.debug) {
        logger.configure({ level: LogLevel.DEBUG, enableDebug: true });
        process.env.AGENTUSE_DEBUG = "true";
      }

      // Resolve projects: CLI -C > config.serve.projects > cwd fallback.
      const dirFlags = options.directory ?? [];
      const projectSeeds: Array<Omit<Project, 'agentFiles'>> = [];
      if (dirFlags.length > 0) {
        for (const dir of dirFlags) {
          try {
            projectSeeds.push(resolveProjectFromPath(dir));
          } catch (err) {
            console.error(chalk.red((err as Error).message));
            process.exit(1);
          }
        }
      } else if (serveCfg?.projects && serveCfg.projects.length > 0) {
        for (const p of serveCfg.projects) {
          try {
            projectSeeds.push(resolveProjectFromPath(p.path, p.id));
          } catch (err) {
            console.error(chalk.red(`Config project ${p.id ?? p.path}: ${(err as Error).message}`));
            process.exit(1);
          }
        }
      } else {
        const ctx = resolveProjectContext(process.cwd());
        const envLocal = resolve(ctx.projectRoot, '.env.local');
        projectSeeds.push({
          id: basename(ctx.projectRoot),
          root: ctx.projectRoot,
          scopeRoot: ctx.projectRoot,
          envFile: existsSync(envLocal) ? envLocal : ctx.envFile,
        });
      }

      loadedServeEnvFiles.push(...loadServeProjectEnvironment(projectSeeds));

      // Reject duplicate absolute paths
      const pathSeen = new Map<string, string>();
      for (const p of projectSeeds) {
        const prev = pathSeen.get(p.root);
        if (prev) {
          console.error(chalk.red(`\nError: duplicate project path: ${p.root}`));
          console.error(chalk.dim(`Each -C must point to a distinct directory.`));
          process.exit(1);
        }
        pathSeen.set(p.root, p.id);
      }

      // Reject duplicate ids (same basename from different parents)
      const idSeen = new Map<string, string>();
      for (const p of projectSeeds) {
        const prev = idSeen.get(p.id);
        if (prev) {
          console.error(chalk.red(`\nError: duplicate project id "${p.id}": both "${prev}" and "${p.root}" resolve to the same basename.`));
          console.error(chalk.dim(`Rename one directory or serve them separately.`));
          process.exit(1);
        }
        idSeen.set(p.id, p.root);
      }

      const multiProject = projectSeeds.length > 1;

      // CLI --default > config.serve.default.
      const effectiveDefault = options.default ?? serveCfg?.default;

      // Validate effective default
      if (effectiveDefault !== undefined) {
        if (!multiProject) {
          const from = options.default !== undefined ? '--default' : 'config.serve.default';
          console.error(chalk.red(`\nError: ${from} is only meaningful with multiple projects.`));
          process.exit(1);
        }
        if (!idSeen.has(effectiveDefault)) {
          const known = projectSeeds.map((p) => p.id).join(', ');
          const from = options.default !== undefined ? '--default' : 'config.serve.default';
          console.error(chalk.red(`\nError: ${from} "${effectiveDefault}" is not a known project id.`));
          console.error(chalk.dim(`Known ids: ${known}`));
          process.exit(1);
        }
      }

      const existingServers = listServers();
      if (existingServers.length > 0) {
        const current = existingServers[0];
        console.error(chalk.red(`\nError: agentuse serve is already running.`));
        console.error(chalk.dim(`\nAgentUse uses one serve daemon for approvals, Slack, sessions, and API traffic.`));
        console.error(chalk.dim(`Add projects to the existing daemon configuration, or stop it before starting another one.`));
        console.error(chalk.dim(`\n  PID:      ${current.pid}`));
        console.error(chalk.dim(`  Address:  http://${current.host}:${current.port}`));
        console.error(chalk.dim(`  Projects: ${summarizeServerProjects(current)}`));
        if (current.logFile) {
          console.error(chalk.dim(`  Log:      ${current.logFile}`));
        }
        if (existingServers.length > 1) {
          console.error(chalk.yellow(`\nWarning: ${existingServers.length} serve daemons are registered. Stop the extras; only one should remain.`));
        }
        console.error(chalk.dim(`\nInspect the daemon with: agentuse serve ps`));
        process.exit(1);
      }

      // Initialize storage per project (non-blocking if one fails)
      for (const p of projectSeeds) {
        try {
          await initStorage(p.root);
        } catch (err) {
          logger.warn(`Failed to initialize session storage for ${p.id}: ${(err as Error).message}`);
        }
      }

      for (const p of projectSeeds) {
        logger.info(`Project ${p.id}: ${p.root}`);
      }

      // Initialize telemetry
      await telemetry.init(packageVersion);

      // Spawn one worker per project. Each worker loads its own project's
      // .env / .env.local on each execute request, so per-project env stays
      // isolated from the parent process and from sibling projects.
      const workers = new Map<string, AgentWorker>();
      for (const p of projectSeeds) {
        const w = new AgentWorker({
          AGENTUSE_RESUME_PUBLIC_URL: effectivePublicUrl,
          AGENTUSE_PROJECT_ID: p.id,
        });
        try {
          await w.spawn();
        } catch (err) {
          console.error(chalk.red(`Failed to spawn worker for ${p.id}: ${(err as Error).message}`));
          for (const live of workers.values()) live.shutdown();
          process.exit(1);
        }
        workers.set(p.id, w);
      }
      logger.debug(`Spawned ${workers.size} agent worker(s)`);

      // Execution stats tracking
      const serverStartTime = Date.now();
      let totalExecutions = 0;
      let successfulExecutions = 0;
      let failedExecutions = 0;
      let logHandle: LogFileHandle | null = null;

      // Helper function to execute an agent (used by scheduler)
      // Uses subprocess to work around EBADF issue when spawning from async callbacks
      const executeScheduledAgent = async (
        schedule: Schedule
      ): Promise<{ success: boolean; duration: number; error?: string; sessionId?: string }> => {
        const startTime = Date.now();
        const project = projectsById.get(schedule.projectId);
        if (!project) {
          totalExecutions++;
          failedExecutions++;
          return {
            success: false,
            duration: 0,
            error: `Unknown project for schedule: ${schedule.projectId}`,
          };
        }
        const agentPath = resolveScopedAgentPath(project, schedule.agentPath);

        // Parse agent for telemetry (env validation happens in the worker,
        // which loads the project's .env before checking process.env)
        let agent: Awaited<ReturnType<typeof parseAgent>> | undefined;
        try {
          agent = await parseAgent(agentPath);
        } catch (parseError) {
          const duration = Date.now() - startTime;
          totalExecutions++;
          failedExecutions++;
          return {
            success: false,
            duration,
            error: (parseError as Error).message,
          };
        }

        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          totalExecutions++;
          failedExecutions++;
          return {
            success: false,
            duration: 0,
            error: `Worker not available for project ${project.id}`,
          };
        }

        // Execute via worker process to work around EBADF issue in async callbacks
        const spawnResult = await projectWorker.execute({
          agentPath: toProjectRelativeAgentPath(project, schedule.agentPath),
          projectRoot: project.root,
          timeout: agent.config.timeout,
          maxSteps: agent.config.maxSteps,
          debug: options.debug,
          trigger: 'scheduled',
        });

        const duration = Date.now() - startTime;

        if (spawnResult.success) {
          totalExecutions++;
          successfulExecutions++;

          // Capture telemetry for scheduled execution
          telemetry.captureExecution({
            ...parseModel(agent.config.model),
            durationMs: duration,
            inputTokens: spawnResult.result.tokens?.input ?? 0,
            outputTokens: spawnResult.result.tokens?.output ?? 0,
            success: true,
            features: {
              mcpServersCount: Object.keys(agent.config.mcpServers || {}).length,
              subagentsConfigured: agent.config.subagents?.length ?? 0,
              skillsUsed: false,
              mode: 'schedule',
            },
            config: {
              timeoutCustom: agent.config.timeout !== undefined,
              maxStepsCustom: agent.config.maxSteps !== undefined,
              quietMode: true,
              debugMode: options.debug ?? false,
            },
          });

          return {
            success: true,
            duration,
            ...(spawnResult.result.sessionId && { sessionId: spawnResult.result.sessionId }),
          };
        } else {
          totalExecutions++;
          failedExecutions++;

          // Capture telemetry for failed scheduled execution
          telemetry.captureExecution({
            ...parseModel(agent.config.model),
            durationMs: duration,
            inputTokens: 0,
            outputTokens: 0,
            success: false,
            errorType: spawnResult.error.code === 'TIMEOUT' ? 'timeout' : 'unknown',
            features: {
              mcpServersCount: Object.keys(agent.config.mcpServers || {}).length,
              subagentsConfigured: agent.config.subagents?.length ?? 0,
              skillsUsed: false,
              mode: 'schedule',
            },
          });

          return {
            success: false,
            duration,
            error: spawnResult.error.message,
          };
        }
      };

      // Initialize scheduler
      const scheduler = new Scheduler({
        onExecute: executeScheduledAgent,
      });

      // Build projects with agent files and scan for schedules
      const projects: Project[] = [];
      for (const seed of projectSeeds) {
        const agentFiles = await glob("**/*.agentuse", {
          cwd: seed.scopeRoot,
          ignore: ["node_modules/**", "tmp/**", ".git/**"],
        });
        projects.push({ ...seed, agentFiles });

        for (const agentFile of agentFiles) {
          try {
            const agentPath = resolveScopedAgentPath(seed, agentFile);
            const agent = await parseAgent(agentPath);
            if (agent.config.schedule) {
              scheduler.add(seed.id, agentFile, agent.config.schedule);
              logger.debug(`Loaded schedule for ${seed.id}: ${agentFile}`);
            }
          } catch (err) {
            logger.warn(`Failed to load agent ${seed.id}/${agentFile}: ${(err as Error).message}`);
          }
        }
      }

      const projectsById = new Map<string, Project>(projects.map((p) => [p.id, p]));

      // Mutable per-project agent counts (updated by hot reload)
      const agentCounts = new Map<string, number>(projects.map((p) => [p.id, p.agentFiles.length]));

      const updateRegistryCounts = () => {
        const entries: ServerProjectEntry[] = projects.map((p) => ({
          id: p.id,
          root: p.root,
          ...(p.scopeRoot !== p.root && { scopeRoot: p.scopeRoot }),
          agentCount: agentCounts.get(p.id) ?? 0,
          scheduleCount: scheduler.list().filter((s) => s.projectId === p.id).length,
        }));
        updateServer({
          agentCount: entries.reduce((a, b) => a + b.agentCount, 0),
          scheduleCount: entries.reduce((a, b) => a + b.scheduleCount, 0),
          projects: entries,
        });
      };

      // Helper to print hot reload messages
      const printHotReload = (projectId: string, action: "added" | "changed" | "removed", path: string, schedule?: Schedule) => {
        const actionColor = action === "added" ? chalk.green : action === "removed" ? chalk.red : chalk.yellow;
        const label = multiProject ? `${projectId}/${path}` : path;
        console.log(`  ${chalk.cyan("Hot reload")} Agent ${actionColor(action)}: ${chalk.dim(label)}`);
        if (schedule) {
          const nextRun = schedule.nextRun?.toLocaleString("en-US", {
            month: "short",
            day: "2-digit",
            hour: "2-digit",
            minute: "2-digit",
            hour12: false,
          }) || "N/A";
          console.log(`             Schedule: ${chalk.dim(schedule.expression)} ${chalk.dim(`(next: ${nextRun})`)}`);
        }
      };

      // One file watcher per project
      const fileWatchers: FileWatcher[] = [];
      for (const project of projects) {
        const watcher = new FileWatcher({
          projectRoot: project.root,
          ...(project.scopeRoot !== project.root && { agentRoot: project.scopeRoot }),
          envFile: project.envFile,

          onAgentAdded: async (relativePath: string) => {
            try {
              const agentPath = resolveScopedAgentPath(project, relativePath);
              const agent = await parseAgent(agentPath);

              const schedule = agent.config.schedule
                ? scheduler.add(project.id, relativePath, agent.config.schedule)
                : undefined;
              printHotReload(project.id, "added", relativePath, schedule);

              agentCounts.set(project.id, (agentCounts.get(project.id) ?? 0) + 1);
              updateRegistryCounts();
            } catch (err) {
              logger.warn(`Hot reload: Failed to parse new agent ${project.id}/${relativePath}: ${(err as Error).message}`);
            }
          },

          onAgentChanged: async (relativePath: string) => {
            try {
              const agentPath = resolveScopedAgentPath(project, relativePath);
              const agent = await parseAgent(agentPath);

              const schedule = scheduler.update(project.id, relativePath, agent.config.schedule);
              printHotReload(project.id, "changed", relativePath, schedule);

              updateRegistryCounts();
            } catch (err) {
              logger.warn(`Hot reload: Failed to parse changed agent ${project.id}/${relativePath}: ${(err as Error).message}`);
            }
          },

          onAgentRemoved: (relativePath: string) => {
            const hadSchedule = scheduler.removeByAgentPath(project.id, relativePath);
            printHotReload(project.id, "removed", relativePath);
            if (hadSchedule) {
              logger.debug(`Hot reload: Unregistered schedule for ${project.id}/${relativePath}`);
            }

            agentCounts.set(project.id, Math.max(0, (agentCounts.get(project.id) ?? 0) - 1));
            updateRegistryCounts();
          },

          onEnvReloaded: () => {
            // Env changes are picked up by the worker on its next execute,
            // which re-reads the project's .env / .env.local before each run.
          },
        });

        watcher.start();
        fileWatchers.push(watcher);
      }

      const resolveRequestProject = (body: RunRequest): { project: Project } | { error: { status: number; code: string; message: string; extra?: Record<string, unknown> } } => {
        if (body.project !== undefined) {
          const proj = projectsById.get(body.project);
          if (!proj) {
            return {
              error: {
                status: 404,
                code: "PROJECT_NOT_FOUND",
                message: `Unknown project id: "${body.project}". Known ids: ${[...projectsById.keys()].join(', ')}`,
              },
            };
          }
          return { project: proj };
        }

        if (!multiProject) {
          return { project: projects[0] };
        }

        if (effectiveDefault) {
          return { project: projectsById.get(effectiveDefault)! };
        }

        return {
          error: {
            status: 400,
            code: "PROJECT_REQUIRED",
            message: `Multiple projects are served. Add "project" to the request body. Available ids: ${[...projectsById.keys()].join(', ')}`,
            extra: { availableProjects: [...projectsById.keys()] },
          },
        };
      };

      const findApprovalInfo = async (options: {
        projectId?: string;
        sessionId: string;
        resumeToken: string;
        allowHistorical?: boolean;
      }): Promise<
        | { success: true; project: Project; info: WorkerApprovalInfoResult }
        | { success: false; status: number; code: string; message: string }
      > => {
        // A session lives in exactly one project, so locate it by searching
        // every served project (session ids are globally-unique ULIDs). Do not
        // collapse to `effectiveDefault` here: that preference is for routing
        // *new* runs, and applying it to an existing-session lookup makes
        // approvals for non-default projects fail with SESSION_NOT_FOUND.
        const selectedProjects = options.projectId
          ? projects.filter((project) => project.id === options.projectId)
          : projects;

        if (selectedProjects.length === 0) {
          return {
            success: false,
            status: 404,
            code: "PROJECT_NOT_FOUND",
            message: options.projectId
              ? `Project not found: ${options.projectId}`
              : "Project not found for approval request",
          };
        }

        const nonSessionErrors: Array<{ status: number; code: string; message: string }> = [];
        for (const project of selectedProjects) {
          const projectWorker = workers.get(project.id);
          if (!projectWorker) {
            nonSessionErrors.push({
              status: 500,
              code: "WORKER_UNAVAILABLE",
              message: `No worker for project ${project.id}`,
            });
            continue;
          }

          const info = await projectWorker.getApprovalInfo({
            projectRoot: project.root,
            sessionId: options.sessionId,
            resumeToken: options.resumeToken,
            allowHistorical: options.allowHistorical ?? false,
          });
          if (info.success) {
            return { success: true, project, info };
          }

          if (info.error.code !== 'SESSION_NOT_FOUND') {
            nonSessionErrors.push({
              status: info.error.code === 'RESUME_TOKEN_INVALID' ? 401 : 404,
              code: info.error.code,
              message: info.error.message,
            });
          }
        }

        if (nonSessionErrors.length > 0) {
          return { success: false, ...nonSessionErrors[0] };
        }
        return {
          success: false,
          status: 404,
          code: "SESSION_NOT_FOUND",
          message: `Session not found: ${options.sessionId}`,
        };
      };

      // Resolve full session/approval info for an already-authorized viewer of
      // the unified /sessions/:id page. Unlike findApprovalInfo this needs no
      // gate resumeToken (the serve process authorized via session token / api
      // key / local), and uses the trusted worker path so the current gate's
      // resumeToken comes back for server-side resume.
      const findSessionInfo = async (
        sessionId: string,
        projectId?: string
      ): Promise<
        | { success: true; project: Project; info: WorkerApprovalInfoResult }
        | { success: false; status: number; code: string; message: string }
      > => {
        const selectedProjects = projectId
          ? projects.filter((project) => project.id === projectId)
          : projects;

        if (selectedProjects.length === 0) {
          return {
            success: false,
            status: 404,
            code: "PROJECT_NOT_FOUND",
            message: projectId ? `Project not found: ${projectId}` : "Project not found for session request",
          };
        }

        const nonSessionErrors: Array<{ status: number; code: string; message: string }> = [];
        for (const project of selectedProjects) {
          const projectWorker = workers.get(project.id);
          if (!projectWorker) {
            nonSessionErrors.push({ status: 500, code: "WORKER_UNAVAILABLE", message: `No worker for project ${project.id}` });
            continue;
          }
          const info = await projectWorker.getApprovalInfo({
            projectRoot: project.root,
            sessionId,
            trusted: true,
          });
          if (info.success) {
            return { success: true, project, info };
          }
          if (info.error.code !== 'SESSION_NOT_FOUND') {
            // Corruption is a terminal, non-retryable condition for this
            // session: 422 so the client stops polling and shows the error,
            // versus 500 which the live view treats as a transient blip.
            const status = info.error.code === 'SESSION_CORRUPTED' ? 422 : 500;
            nonSessionErrors.push({ status, code: info.error.code, message: info.error.message });
          }
        }

        if (nonSessionErrors.length > 0) {
          return { success: false, ...nonSessionErrors[0] };
        }
        return { success: false, status: 404, code: "SESSION_NOT_FOUND", message: `Session not found: ${sessionId}` };
      };

      const findSessionStatusInfo = async (
        sessionId: string,
        projectId?: string
      ): Promise<
        | { success: true; project: Project; session: SessionStatusInfo }
        | { success: false; status: number; code: string; message: string }
      > => {
        const selectedProjects = projectId
          ? projects.filter((project) => project.id === projectId)
          : projects;

        if (selectedProjects.length === 0) {
          return {
            success: false,
            status: 404,
            code: "PROJECT_NOT_FOUND",
            message: projectId ? `Project not found: ${projectId}` : "Project not found for session request",
          };
        }

        const nonSessionErrors: Array<{ status: number; code: string; message: string }> = [];
        for (const project of selectedProjects) {
          const projectWorker = workers.get(project.id);
          if (!projectWorker) {
            nonSessionErrors.push({ status: 500, code: "WORKER_UNAVAILABLE", message: `No worker for project ${project.id}` });
            continue;
          }
          const info = await projectWorker.getSessionStatusInfo({
            projectRoot: project.root,
            sessionId,
          });
          if (info.success) {
            return { success: true, project, session: info.session };
          }
          if (info.error.code !== 'SESSION_NOT_FOUND') {
            const status = info.error.code === 'SESSION_CORRUPTED' ? 422 : 500;
            nonSessionErrors.push({ status, code: info.error.code, message: info.error.message });
          }
        }

        if (nonSessionErrors.length > 0) {
          return { success: false, ...nonSessionErrors[0] };
        }
        return { success: false, status: 404, code: "SESSION_NOT_FOUND", message: `Session not found: ${sessionId}` };
      };

      const activeApprovalResumes = new Map<string, Promise<unknown>>();
      const activeSessionContinuations = new Map<string, Promise<unknown>>();
      const loggedApprovalRequests = new Set<string>();
      const slackBotToken = process.env.SLACK_BOT_TOKEN;
      const slackAppToken = process.env.SLACK_APP_TOKEN;

      // Shared resume kickoff for both /approvals/:id/decision and the unified
      // /sessions/:id/decision. The caller validates auth + state, then hands us
      // the resolved gate resumeToken; we run the worker resume, update any
      // Slack thread, track the in-flight promise, and write the 202.
      const startApprovalResume = (
        res: ServerResponse,
        params: { project: Project; sessionId: string; info: WorkerApprovalInfoResult; resumeToken: string; status: string; comment?: string | undefined }
      ): void => {
        const { project, sessionId, info, resumeToken, status, comment } = params;
        const projectWorker = workers.get(project.id)!;
        const activeKey = `${project.id}:${sessionId}`;
        approvalLog.received('web', status, sessionId, 'web');
        const resumeStart = Date.now();
        approvalLog.resumeStarted(sessionId);
        const slackChannelMessage = info.approval.channelMessage?.type === 'slack-message' &&
          info.approval.channelMessage.channel &&
          info.approval.channelMessage.ts &&
          slackBotToken
          ? {
            channelId: info.approval.channelMessage.channel,
            ts: info.approval.channelMessage.ts,
            actionTs: info.approval.channelMessage.actionTs,
            approvalUrl: info.approval.channelMessage.url
          }
          : undefined;
        if (slackChannelMessage && info.approval.prompt) {
          void updateSlackApprovalRequestStatus({
            botToken: slackBotToken!,
            channelId: slackChannelMessage.channelId,
            ts: slackChannelMessage.ts,
            ...(slackChannelMessage.actionTs && { actionTs: slackChannelMessage.actionTs }),
            prompt: info.approval.prompt,
            sessionId,
            projectId: project.id,
            agentName: info.approval.agent.name,
            ...(slackChannelMessage.approvalUrl && { approvalUrl: slackChannelMessage.approvalUrl }),
            ...(info.approval.expiresAt && { expiresAt: new Date(info.approval.expiresAt).toISOString() }),
            status: 'resuming',
            decision: status
          }).catch((err) => logger.warn(`Slack approval status update failed: ${(err as Error).message}`));
        }
        const resumePromise = Promise.resolve().then(() => projectWorker.execute({
          projectRoot: project.root,
          sessionId,
          toolResult: {
            status,
            ...(comment && { comment }),
            reviewer: { username: 'web' }
          },
          resumeToken,
          debug: options.debug,
        })).then(result => {
          if (!result.success) {
            const alreadyCompleted = /SESSION_NOT_SUSPENDED:\s*completed/i.test(result.error.message);
            if (alreadyCompleted) {
              approvalLog.resumeCompleted(sessionId, Date.now() - resumeStart);
              return;
            }
            approvalLog.resumeFailed(sessionId, Date.now() - resumeStart, result.error.message);
            logger.warn(`Approval resume ${sessionId} failed: ${result.error.message}`);
            if (slackChannelMessage && info.approval.prompt) {
              void updateSlackApprovalRequestStatus({
                botToken: slackBotToken!,
                channelId: slackChannelMessage.channelId,
                ts: slackChannelMessage.ts,
                ...(slackChannelMessage.actionTs && { actionTs: slackChannelMessage.actionTs }),
                prompt: info.approval.prompt,
                sessionId,
                projectId: project.id,
                agentName: info.approval.agent.name,
                ...(slackChannelMessage.approvalUrl && { approvalUrl: slackChannelMessage.approvalUrl }),
                ...(info.approval.expiresAt && { expiresAt: new Date(info.approval.expiresAt).toISOString() }),
                status: 'failed',
                decision: status,
                error: result.error.message
              }).catch((err) => logger.warn(`Slack approval status update failed: ${(err as Error).message}`));
            }
          } else {
            approvalLog.resumeCompleted(sessionId, Date.now() - resumeStart);
            if (slackChannelMessage && info.approval.prompt) {
              void updateSlackApprovalRequestStatus({
                botToken: slackBotToken!,
                channelId: slackChannelMessage.channelId,
                ts: slackChannelMessage.ts,
                ...(slackChannelMessage.actionTs && { actionTs: slackChannelMessage.actionTs }),
                prompt: info.approval.prompt,
                sessionId,
                projectId: project.id,
                agentName: info.approval.agent.name,
                ...(slackChannelMessage.approvalUrl && { approvalUrl: slackChannelMessage.approvalUrl }),
                ...(info.approval.expiresAt && { expiresAt: new Date(info.approval.expiresAt).toISOString() }),
                status: 'completed',
                decision: status
              }).catch((err) => logger.warn(`Slack approval status update failed: ${(err as Error).message}`));
            }
          }
        }).finally(() => {
          if (activeApprovalResumes.get(activeKey) === resumePromise) {
            activeApprovalResumes.delete(activeKey);
          }
        });
        activeApprovalResumes.set(activeKey, resumePromise);

        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessionId, status: "resuming" }));
      };

      // Shared continue kickoff for both /approvals/:id/continue and
      // /sessions/:id/continue.
      const startSessionContinue = (
        res: ServerResponse,
        params: { project: Project; sessionId: string; prompt: string }
      ): void => {
        const { project, sessionId, prompt } = params;
        const projectWorker = workers.get(project.id)!;
        const activeKey = `${project.id}:${sessionId}`;
        const continueStart = Date.now();
        approvalLog.continueStarted(sessionId);
        const continuePromise = Promise.resolve()
          .then(() => projectWorker.continueSession({
            projectRoot: project.root,
            sessionId,
            prompt,
            debug: options.debug,
          }))
          .then(result => {
            if (!result.success) {
              approvalLog.continueFailed(sessionId, Date.now() - continueStart, result.error.message);
              logger.warn(`Session continue ${sessionId} failed: ${result.error.message}`);
              return;
            }
            approvalLog.continueCompleted(sessionId, Date.now() - continueStart);
          })
          .finally(() => {
            if (activeSessionContinuations.get(activeKey) === continuePromise) {
              activeSessionContinuations.delete(activeKey);
            }
          });
        activeSessionContinuations.set(activeKey, continuePromise);

        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessionId, status: "continuing" }));
      };

      const resumeSuspendedSession = async (decision: SlackApprovalDecision): Promise<void> => {
        const reviewer = decision.toolResult.reviewer?.id
          ? `<@${decision.toolResult.reviewer.id}>`
          : decision.toolResult.reviewer?.username;
        approvalLog.received('slack', decision.toolResult.status, decision.sessionId, reviewer);

        // A Slack approval posted by a standalone `agentuse run` carries no
        // projectId (only serve workers set AGENTUSE_PROJECT_ID). Locate the
        // project that actually owns the session by searching every served
        // project, instead of falling back to the default project and resuming
        // against the wrong storage (which fails with SESSION_NOT_FOUND).
        const located = await findApprovalInfo({
          ...(decision.projectId && { projectId: decision.projectId }),
          sessionId: decision.sessionId,
          resumeToken: decision.resumeToken,
          allowHistorical: true,
        });
        if (!located.success) {
          throw new Error(located.message);
        }
        const { project, info } = located;
        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          throw new Error(`No worker for project ${project.id}`);
        }

        if (info.success && info.approval.sessionStatus === 'completed') {
          approvalLog.resumeCompleted(decision.sessionId, 0);
          return;
        }

        const activeKey = `${project.id}:${decision.sessionId}`;
        const existingResume = activeApprovalResumes.get(activeKey);
        if (existingResume) {
          await existingResume;
          return;
        }

        const resumePromise = Promise.resolve().then(async () => {
          const resumeStart = Date.now();
          approvalLog.resumeStarted(decision.sessionId);
          const result = await projectWorker.execute({
            projectRoot: project.root,
            sessionId: decision.sessionId,
            toolResult: decision.toolResult,
            resumeToken: decision.resumeToken,
            debug: options.debug,
          });

          if (!result.success) {
            const alreadyCompleted = /SESSION_NOT_SUSPENDED:\s*completed/i.test(result.error.message);
            if (alreadyCompleted) {
              approvalLog.resumeCompleted(decision.sessionId, Date.now() - resumeStart);
              return;
            }
            approvalLog.resumeFailed(decision.sessionId, Date.now() - resumeStart, result.error.message);
            throw new Error(result.error.message);
          }
          approvalLog.resumeCompleted(decision.sessionId, Date.now() - resumeStart);
        }).finally(() => {
          if (activeApprovalResumes.get(activeKey) === resumePromise) {
            activeApprovalResumes.delete(activeKey);
          }
        });

        activeApprovalResumes.set(activeKey, resumePromise);
        await resumePromise;
      };

      const updateSlackThreadApprovalStatus = (
        project: Project,
        approval: ApprovalSummary,
        status: 'waiting' | 'resuming' | 'completed' | 'failed',
        decision: string,
        error?: unknown
      ): void => {
        if (
          !slackBotToken ||
          approval.channelMessage?.type !== 'slack-message' ||
          !approval.channelMessage.channel ||
          !approval.channelMessage.ts ||
          !approval.prompt
        ) {
          return;
        }

        void updateSlackApprovalRequestStatus({
          botToken: slackBotToken,
          channelId: approval.channelMessage.channel,
          ts: approval.channelMessage.ts,
          ...(approval.channelMessage.actionTs && { actionTs: approval.channelMessage.actionTs }),
          prompt: approval.prompt,
          sessionId: approval.sessionId,
          projectId: project.id,
          agentName: approval.agentName,
          ...(approval.channelMessage.url && { approvalUrl: approval.channelMessage.url }),
          ...(approval.expiresAt && { expiresAt: new Date(approval.expiresAt).toISOString() }),
          status,
          decision,
          ...(error !== undefined && { error })
        }).catch((err) => logger.warn(`Slack approval status update failed: ${(err as Error).message}`));
      };

      const postSlackApprovalThreadNote = (
        approval: ApprovalSummary,
        message: string
      ): void => {
        if (
          !slackBotToken ||
          approval.channelMessage?.type !== 'slack-message' ||
          !approval.channelMessage.channel ||
          !approval.channelMessage.ts
        ) {
          return;
        }

        const web = new WebClient(slackBotToken);
        void web.chat.postMessage({
          channel: approval.channelMessage.channel,
          thread_ts: approval.channelMessage.ts,
          text: message,
          blocks: [
            {
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*AgentUse processed your comment.*\nThe agent continued after receiving the feedback.`
              }
            }
          ] as any[]
        }).catch((err) => logger.warn(`Slack approval thread note failed: ${(err as Error).message}`));
      };

      const sessionIdForLocalApprovalThread = async (comment: SlackApprovalThreadComment): Promise<string | undefined> => {
        for (const project of projects) {
          const projectWorker = workers.get(project.id);
          if (!projectWorker) continue;
          const result = await projectWorker.listApprovals(project.root);
          if (!result.success) {
            logger.debug(`Slack approval thread lookup failed for ${project.id}: ${result.error.message}`);
            continue;
          }
          const approval = result.approvals.find((item) =>
            (
              item.channelMessage?.type === 'slack-message' &&
              item.channelMessage.channel === comment.channel &&
              item.channelMessage.ts === comment.threadTs
            ) ||
            item.channels?.slack?.some((handle) =>
              handle.channel === comment.channel &&
              handle.ts === comment.threadTs
            )
          );
          if (approval) return approval.sessionId;
        }
        return undefined;
      };

      const postSlackRunThreadNote = (
        comment: SlackApprovalThreadComment,
        text: string,
        blocks: any[]
      ): void => {
        if (!slackBotToken) return;
        const web = new WebClient(slackBotToken);
        void web.chat.postMessage({
          channel: comment.channel,
          thread_ts: comment.threadTs,
          text,
          blocks
        }).catch((err) => logger.warn(`Slack run thread note failed: ${(err as Error).message}`));
      };

      const continueSlackRunThread = async (comment: SlackApprovalThreadComment): Promise<SlackRunThreadCommentResult> => {
        let sessionId: string | undefined;
        try {
          sessionId = await sessionIdForLocalApprovalThread(comment);
        } catch (err) {
          logger.warn(`Slack run thread lookup failed: ${(err as Error).message}`);
          return { handled: false };
        }
        if (!sessionId) return { handled: false };

        const done = (async () => {
          for (const project of projects) {
            const projectWorker = workers.get(project.id);
            if (!projectWorker) continue;

            const result = await projectWorker.continueSession({
              projectRoot: project.root,
              sessionId,
              prompt: comment.text,
              debug: options.debug,
              runChannelHandles: [{
                channel: comment.channel,
                ts: comment.threadTs,
                events: ['approval', 'completion', 'failure']
              }]
            });
            if (!result.success && result.error.code === 'SESSION_NOT_FOUND') {
              continue;
            }
            if (!result.success) {
              throw new Error(result.error.message);
            }

            postSlackRunThreadNote(comment, 'AgentUse continued the session', [{
              type: 'section',
              text: {
                type: 'mrkdwn',
                text: `*AgentUse resumed the session.*\nContinued \`${sessionId}\` with your follow-up.`
              }
            }]);
            return;
          }

          throw new Error(`Session ${sessionId} was not found in this serve daemon`);
        })();

        return { handled: true, done };
      };

      const resumeSlackThreadComment = async (comment: SlackApprovalThreadComment): Promise<SlackApprovalThreadCommentResult> => {
        for (const project of projects) {
          const projectWorker = workers.get(project.id);
          if (!projectWorker) continue;

          const result = await projectWorker.listApprovals(project.root);
          if (!result.success) {
            logger.debug(`Slack approval comment lookup failed for ${project.id}: ${result.error.message}`);
            continue;
          }

          const approval = result.approvals.find((item) =>
            item.status === 'pending' &&
            item.sessionStatus === 'suspended' &&
            item.resumeToken &&
            item.channelMessage?.type === 'slack-message' &&
            item.channelMessage.channel === comment.channel &&
            item.channelMessage.ts === comment.threadTs
          );
          if (!approval?.resumeToken) continue;

          const activeKey = `${project.id}:${approval.sessionId}`;
          if (activeApprovalResumes.has(activeKey)) {
            throw new Error(`Approval decision has already been submitted and session ${approval.sessionId} is resuming`);
          }

          const reviewer = comment.userId ? `<@${comment.userId}>` : comment.username ?? 'slack';
          approvalLog.received('slack', 'comment', approval.sessionId, reviewer);
          const resumeStart = Date.now();
          approvalLog.resumeStarted(approval.sessionId);
          updateSlackThreadApprovalStatus(project, approval, 'resuming', 'comment');

          const done = Promise.resolve().then(async () => {
            try {
              const resumeResult = await projectWorker.execute({
                projectRoot: project.root,
                sessionId: approval.sessionId,
                toolResult: {
                  status: 'comment',
                  comment: comment.text,
                  reviewer: {
                    ...(comment.userId && { id: comment.userId }),
                    ...(comment.username && { username: comment.username }),
                    ...(comment.teamId && { teamId: comment.teamId })
                  }
                },
                resumeToken: approval.resumeToken,
                debug: options.debug,
              });

              if (!resumeResult.success) {
                approvalLog.resumeFailed(approval.sessionId, Date.now() - resumeStart, resumeResult.error.message);
                logger.warn(`Approval resume ${approval.sessionId} failed: ${resumeResult.error.message}`);
                updateSlackThreadApprovalStatus(project, approval, 'failed', 'comment', resumeResult.error.message);
                throw new Error(resumeResult.error.message);
              }

              approvalLog.resumeCompleted(approval.sessionId, Date.now() - resumeStart);
              if (resumeResult.result.finishReason === 'suspended' || resumeResult.result.approvalUrl) {
                const refreshed = await projectWorker.listApprovals(project.root);
                const nextApproval = refreshed.success
                  ? refreshed.approvals.find((item) =>
                    item.sessionId === approval.sessionId &&
                    item.status === 'pending' &&
                    item.resumeToken &&
                    item.resumeToken !== approval.resumeToken
                  )
                  : undefined;
                const nextApprovalUrl = nextApproval?.channelMessage?.url ?? resumeResult.result.approvalUrl;
                updateSlackThreadApprovalStatus(project, approval, 'completed', 'comment');
                // When another approval was requested, its Decision message has
                // already been posted to this thread and should stay the last,
                // actionable item — don't bury it under a status note. Only
                // note the outcome when the agent continued without a new gate.
                if (!nextApprovalUrl) {
                  postSlackApprovalThreadNote(
                    approval,
                    'AgentUse processed your comment and continued the session.'
                  );
                }
                return;
              }

              updateSlackThreadApprovalStatus(project, approval, 'completed', 'comment');
            } finally {
              if (activeApprovalResumes.get(activeKey) === done) {
                activeApprovalResumes.delete(activeKey);
              }
            }
          });
          activeApprovalResumes.set(activeKey, done);
          return { handled: true, done };
        }

        logger.debug(`Slack thread comment matched no pending approval (reply in ${comment.channel}/${comment.threadTs})`);
        return { handled: false };
      };

      let slackApprovalSocket: SlackApprovalSocket | null = null;
      if (slackBotToken && slackAppToken) {
        slackApprovalSocket = new SlackApprovalSocket({
          botToken: slackBotToken,
          appToken: slackAppToken,
          onDecision: resumeSuspendedSession,
          onThreadComment: resumeSlackThreadComment,
          onRunThreadComment: continueSlackRunThread,
          ...(options.debug !== undefined && { debug: options.debug })
        });
        slackApprovalSocket.start()
          .then(() => logger.info('Slack approval socket connected'))
          .catch((err) => logger.warn(`Slack approval socket failed to start: ${(err as Error).message}`));
      } else if (slackAppToken && !slackBotToken) {
        logger.warn('Slack Socket Mode requires SLACK_BOT_TOKEN when SLACK_APP_TOKEN is set; listener not started.');
      } else if (loadedServeEnvFiles.length === 0) {
        logger.debug(`No server-level env file found at ${getGlobalEnvPath()}`);
      }

      const APPROVAL_SWEEP_INTERVAL_MS = 5 * 60_000;
      let approvalSweepTimer: NodeJS.Timeout | null = null;
      let approvalSweepRunning = false;

      const runApprovalSweep = async (): Promise<void> => {
        if (approvalSweepRunning) return;
        approvalSweepRunning = true;
        try {
          for (const project of projects) {
            const projectWorker = workers.get(project.id);
            if (!projectWorker) continue;
            const result = await projectWorker.sweepExpired(project.root);
            if (!result.success) {
              logger.debug(`Approval sweep failed for ${project.id}: ${result.error.message}`);
              continue;
            }
            for (const item of result.expired) {
              const label = multiProject ? `${project.id}/${item.agentName}` : item.agentName;
              approvalLog.expired(label, item.sessionId, item.expiresAt);

              if (
                slackBotToken &&
                item.channelMessage?.type === 'slack-message' &&
                item.channelMessage.channel &&
                item.channelMessage.ts &&
                item.prompt
              ) {
                void updateSlackApprovalRequestStatus({
                  botToken: slackBotToken,
                  channelId: item.channelMessage.channel,
                  ts: item.channelMessage.ts,
                  ...(item.channelMessage.actionTs && { actionTs: item.channelMessage.actionTs }),
                  prompt: item.prompt,
                  sessionId: item.sessionId,
                  projectId: project.id,
                  agentName: item.agentName,
                  ...(item.channelMessage.url && { approvalUrl: item.channelMessage.url }),
                  expiresAt: new Date(item.expiresAt).toISOString(),
                  status: 'failed',
                  decision: 'expired',
                  error: 'Approval timed out'
                }).catch((err) => logger.debug(`Slack expired update failed: ${(err as Error).message}`));
              }
            }
          }
        } finally {
          approvalSweepRunning = false;
        }
      };

      // Serve the built SPA (dist/web): hashed immutable assets at /assets/*,
      // and the tiny no-store HTML shell at every page route. All page data is
      // fetched client-side from the existing /api/* and /sessions/:id/* JSON.
      const staticAssets = new WebAssets();
      // Push session/approval state to the SPA over SSE (one worker poll per
      // session, fanned to all subscribed tabs), replacing in-page polling.
      const approvalHub = new ApprovalEventHub();
      const approvalListHub = new ApprovalListEventHub<ApprovalListPayload>({
        intervalMs: APPROVAL_LIST_SSE_INTERVAL_MS,
      });
      const sessionListHub = new ApprovalListEventHub<SessionsPayload>({
        eventName: 'sessions',
        intervalMs: SESSION_LIST_SSE_INTERVAL_MS,
      });

      const buildSessionsPayload = async (
        requestUrl: URL
      ): Promise<
        | { success: true; payload: SessionsPayload }
        | { success: false; status: number; code: string; message: string }
      > => {
        const agentFilter = requestUrl.searchParams.get('agent') ?? undefined;
        const statusFilter = parseSessionStatusFilter(requestUrl.searchParams.get('status') ?? undefined);
        const triggerFilterRaw = requestUrl.searchParams.get('trigger') ?? undefined;
        const triggerFilter: SessionTrigger | undefined =
          triggerFilterRaw === 'scheduled' || triggerFilterRaw === 'manual' || triggerFilterRaw === 'slack' || triggerFilterRaw === 'api'
            ? triggerFilterRaw
            : undefined;
        const approvalFilter = parseApprovalSessionFilter(requestUrl.searchParams.get('approval') ?? undefined);
        const createdAfter = sessionListCreatedAfter(requestUrl);
        const daysFilter = sessionDaysFilterValue(requestUrl);

        type ProjectSessionRow = { projectId: string; session: SessionSummary };
        const rows: ProjectSessionRow[] = [];
        const errors: Array<{ projectId: string; message: string }> = [];
        const approvalSessionIdsByProject = new Map<string, Set<string>>();

        const projectResults = await Promise.all(projects.map(async (project) => {
          const projectWorker = workers.get(project.id);
          if (!projectWorker) {
            return { project, error: 'Worker unavailable' };
          }
          const result = await projectWorker.listSessions(
            project.root,
            {
              ...(createdAfter !== undefined && { createdAfter }),
              ...(approvalFilter && { includeSubagents: true })
            }
          );
          if (!result.success) {
            return { project, error: result.error.message };
          }
          return { project, sessions: result.sessions };
        }));

        if (approvalFilter) {
          const approvalResults = await Promise.all(projects.map(async (project) => {
            const projectWorker = workers.get(project.id);
            if (!projectWorker) {
              return { project, error: 'Worker unavailable' };
            }
            const result = await projectWorker.listApprovals(
              project.root,
              createdAfter === undefined ? {} : { createdAfter }
            );
            if (!result.success) {
              return { project, error: result.error.message };
            }
            return { project, approvals: result.approvals };
          }));

          for (const result of approvalResults) {
            if (result.error) {
              errors.push({ projectId: result.project.id, message: result.error });
              continue;
            }
            const matchingSessionIds = new Set<string>();
            for (const approval of result.approvals ?? []) {
              if (approvalMatchesSessionFilter(approval.status, approvalFilter)) {
                matchingSessionIds.add(approval.sessionId);
              }
            }
            approvalSessionIdsByProject.set(result.project.id, matchingSessionIds);
          }
        }

        for (const result of projectResults) {
          if (result.error) {
            errors.push({ projectId: result.project.id, message: result.error });
            continue;
          }
          for (const session of result.sessions ?? []) {
            if (statusFilter && session.status !== statusFilter) continue;
            if (triggerFilter && session.trigger !== triggerFilter) continue;
            if (approvalFilter && !approvalSessionIdsByProject.get(result.project.id)?.has(session.sessionId)) continue;
            if (agentFilter && !sessionMatchesAgentFilter(session, agentFilter)) continue;
            rows.push({ projectId: result.project.id, session });
          }
        }

        rows.sort((a, b) => b.session.createdAt - a.session.createdAt);

        return {
          success: true,
          payload: {
            success: true,
            sessions: rows.map((row) => ({ project: row.projectId, ...row.session })),
            window: {
              value: daysFilter,
              ...(daysFilter === 'all'
                ? { days: 'all' as const }
                : daysFilter.endsWith('h')
                  ? { hours: Number(daysFilter.slice(0, -1)) }
                  : { days: Number(daysFilter.slice(0, -1)) }),
              ...(createdAfter !== undefined && { createdAfter })
            },
            ...(agentFilter && { agent: agentFilter }),
            ...(statusFilter && { status: statusFilter }),
            ...(triggerFilter && { trigger: triggerFilter }),
            ...(approvalFilter && { approval: approvalFilter }),
            errors
          }
        };
      };

      const buildApprovalListPayload = async (
        requestUrl: URL
      ): Promise<
        | { success: true; payload: ApprovalListPayload }
        | { success: false; status: number; code: string; message: string }
      > => {
        type ProjectRow = { projectId: string; approval: ApprovalSummary };
        const rows: ProjectRow[] = [];
        const errors: Array<{ projectId: string; message: string }> = [];
        const createdAfter = approvalListCreatedAfter(requestUrl);
        const requestedProject = requestUrl.searchParams.get('project') ?? undefined;
        const selectedProjects = requestedProject
          ? projects.filter((project) => project.id === requestedProject)
          : projects;

        if (requestedProject && selectedProjects.length === 0) {
          return {
            success: false,
            status: 404,
            code: "PROJECT_NOT_FOUND",
            message: `Project not found: ${requestedProject}`,
          };
        }

        const projectResults = await Promise.all(selectedProjects.map(async (project) => {
          const projectWorker = workers.get(project.id);
          if (!projectWorker) {
            return { project, error: 'Worker unavailable' };
          }
          const result = await projectWorker.listApprovals(
            project.root,
            createdAfter === undefined ? {} : { createdAfter }
          );
          if (!result.success) {
            return { project, error: result.error.message };
          }
          return { project, approvals: result.approvals };
        }));

        for (const result of projectResults) {
          if (result.error) {
            errors.push({ projectId: result.project.id, message: result.error });
            continue;
          }
          for (const approval of result.approvals ?? []) {
            rows.push({ projectId: result.project.id, approval });
          }
        }

        const serializeRow = (row: ProjectRow): ApprovalRow => ({
          project: row.projectId,
          ...row.approval
        });
        const pending = rows
          .filter((r) => r.approval.status === 'pending')
          .sort((a, b) => (b.approval.suspendedAt ?? b.approval.createdAt ?? 0) - (a.approval.suspendedAt ?? a.approval.createdAt ?? 0))
          .map(serializeRow);
        const completed = rows
          .filter((r) => r.approval.status === 'approved' || r.approval.status === 'rejected' || r.approval.status === 'commented')
          .sort((a, b) => (b.approval.decisionAt ?? b.approval.suspendedAt ?? b.approval.createdAt ?? 0) - (a.approval.decisionAt ?? a.approval.suspendedAt ?? a.approval.createdAt ?? 0))
          .map(serializeRow);
        const expired = rows
          .filter((r) => r.approval.status === 'expired' || r.approval.status === 'errored')
          .sort((a, b) => (b.approval.decisionAt ?? b.approval.expiresAt ?? 0) - (a.approval.decisionAt ?? a.approval.expiresAt ?? 0))
          .map(serializeRow);
        const days = requestUrl.searchParams.get('days') === 'all'
          ? 'all' as const
          : Math.floor((Date.now() - createdAfter!) / (24 * 60 * 60 * 1000));

        return {
          success: true,
          payload: {
            success: true,
            multiProject: selectedProjects.length > 1,
            approvals: rows.map(serializeRow),
            buckets: { pending, completed, expired },
            window: {
              days,
              ...(createdAfter !== undefined && { createdAfter })
            },
            errors
          }
        };
      };

      const server = createServer(async (req, res) => {
        const requestUrl = new URL(req.url || '/', serverUrl);
        // Canonical data/action endpoints live under `/api/*`; HTML pages live at
        // root. `routePath` is the path with any `/api` prefix stripped so a single
        // set of matchers serves both surfaces, and `isApi` decides JSON vs HTML.
        const { isApi, routePath } = normalizeApiPath(requestUrl.pathname);
        // The unified session page + its action subroutes carry their own
        // capability auth (session token / api key / local), so they are exempt
        // from the global header gate. Crucially the session exemption is
        // `!isApi`-qualified inside isCapabilityRoute: the JSON twins
        // `/api/sessions` (list) and `/api/sessions/:id` stay under the header
        // gate, and the `/sessions` LIST page stays gated too. Only
        // `/sessions/:id` and `/sessions/:id/{decision,continue,status}` open up.
        const isCapabilityRoute = isHeaderGateExemptRoute(routePath, isApi);

        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Favicon: public (served before the auth gate so browsers get the tab
        // icon on every page without a key). One theme-aware SVG, served at both
        // the auto-requested `/favicon.ico` and the canonical `/favicon.svg`.
        if (req.method === "GET" && (routePath === "/favicon.ico" || routePath === "/favicon.svg")) {
          res.writeHead(200, { "Content-Type": "image/svg+xml", "Cache-Control": "public, max-age=86400" });
          res.end(FAVICON_SVG);
          return;
        }

        // SPA static assets (hashed, immutable) — public, served before the auth
        // gate so the browser can load the bundle on token-only deep links.
        if (staticAssets.serveAsset(req, res, requestUrl.pathname)) return;

        // Auth check
        if (apiKey && !isCapabilityRoute && !validateApiKey(req, apiKey)) {
          sendError(res, 401, "UNAUTHORIZED", "Invalid or missing Authorization header. Use: Authorization: Bearer <key>");
          return;
        }

        // Capability auth for the unified session page + its action subroutes:
        // local (no api key) is open; otherwise either a Bearer api key header
        // OR a valid per-session `?token=` (sessionViewToken) authorizes.
        const sessionAuthorized = (sessionId: string, token?: string): boolean =>
          !apiKey || validateApiKey(req, apiKey) || validateSessionToken(token, sessionId, apiKey);

        // SPA page routes: serve the tiny no-store HTML shell; the client fetches
        // its data from the /api/* and /sessions/:id/* JSON endpoints below. This
        // runs after the auth gate, so operator pages stay header-gated and
        // /sessions/:id stays capability-exempt, exactly as the server-rendered
        // pages did. /approvals/:id is deliberately excluded so it still 302s.
        if (req.method === "GET" && !isApi && isSpaPageRoute(routePath)) {
          const shell = staticAssets.renderShell();
          if (!shell) {
            sendHTML(res, 503, renderWebAssetsMissingPage());
            return;
          }
          sendHTML(res, 200, shell);
          return;
        }

        // GET /api returns server-info JSON; GET / serves the HTML dashboard.
        // Both share the same project rollup so the two surfaces never drift.
        if (req.method === "GET" && routePath === "/") {
          const defaultProject = effectiveDefault ?? (multiProject ? null : projects[0].id);
          const projectInfo = projects.map((p) => ({
            id: p.id,
            path: p.root,
            ...(p.scopeRoot !== p.root && { scope: p.scopeRoot }),
            agentCount: agentCounts.get(p.id) ?? 0,
            scheduleCount: scheduler.list().filter((s) => s.projectId === p.id).length,
          }));

          if (isApi) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ version: packageVersion, default: defaultProject, projects: projectInfo }));
            return;
          }
        }

        if (req.method === "GET" && routePath === '/agents') {
          const { agents, errors } = await collectAgents(projects);
          if (isApi) {
            sendJSON(res, 200, { success: true, agents, errors });
            return;
          }
        }

        if (req.method === "GET" && routePath === '/schedules') {
          const schedules = scheduler.listSerialized();
          if (isApi) {
            sendJSON(res, 200, { success: true, schedules });
            return;
          }
        }

        if (req.method === "GET" && routePath === '/stores') {
          const requestedProject = requestUrl.searchParams.get('project') ?? undefined;
          const selectedProjects = requestedProject
            ? projects.filter((project) => project.id === requestedProject)
            : projects;
          if (requestedProject && selectedProjects.length === 0) {
            sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${requestedProject}`);
            return;
          }

          const stores: StoreBrowserSummary[] = [];
          const errors: Array<{ projectId: string; storeName?: string; message: string }> = [];
          for (const project of selectedProjects) {
            const result = await listProjectStores(project);
            stores.push(...result.stores);
            errors.push(...result.errors.map((error) => ({ projectId: project.id, ...error })));
          }
          stores.sort(compareStoreBrowserSummaries);

          if (isApi) {
            sendJSON(res, 200, { success: true, stores, errors });
            return;
          }
        }

        const storePageMatch = req.method === "GET" ? routePath.match(/^\/stores\/([^/?#]+)$/) : null;
        if (storePageMatch) {
          const storeName = decodeURIComponent(storePageMatch[1]);
          if (!isSafeStoreName(storeName)) {
            sendError(res, 400, "INVALID_STORE_NAME", "Invalid store name");
            return;
          }

          const requestedProject = requestUrl.searchParams.get('project') ?? undefined;
          const selectedProjects = requestedProject
            ? projects.filter((project) => project.id === requestedProject)
            : projects;
          if (requestedProject && selectedProjects.length === 0) {
            sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${requestedProject}`);
            return;
          }

          const rows: StoreBrowserRows[] = [];
          const errors: Array<{ projectId: string; message: string }> = [];
          for (const project of selectedProjects) {
            try {
              const row = await listStoreRows(project, storeName);
              rows.push(row);
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== 'ENOENT') {
                errors.push({ projectId: project.id, message: (err as Error).message });
              }
            }
          }

          if (rows.length === 0 && errors.length === 0) {
            sendError(res, 404, "STORE_NOT_FOUND", `Store not found: ${storeName}`);
            return;
          }

          if (isApi) {
            sendJSON(res, 200, { success: true, store: storeName, rows, errors });
            return;
          }
        }

        const storeItemPageMatch = req.method === "GET" ? routePath.match(/^\/stores\/([^/?#]+)\/([^/?#]+)$/) : null;
        if (storeItemPageMatch) {
          const storeName = decodeURIComponent(storeItemPageMatch[1]);
          const itemId = decodeURIComponent(storeItemPageMatch[2]);
          if (!isSafeStoreName(storeName)) {
            sendError(res, 400, "INVALID_STORE_NAME", "Invalid store name");
            return;
          }

          const requestedProject = requestUrl.searchParams.get('project') ?? undefined;
          const selectedProjects = requestedProject
            ? projects.filter((project) => project.id === requestedProject)
            : projects;
          if (requestedProject && selectedProjects.length === 0) {
            sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${requestedProject}`);
            return;
          }

          const errors: Array<{ projectId: string; message: string }> = [];
          let found: { projectId: string; item: StoreItem } | undefined;
          for (const project of selectedProjects) {
            try {
              const item = await findStoreItem(project, storeName, itemId);
              if (item) {
                found = { projectId: project.id, item };
                break;
              }
            } catch (err) {
              const code = (err as NodeJS.ErrnoException).code;
              if (code !== 'ENOENT') {
                errors.push({ projectId: project.id, message: (err as Error).message });
              }
            }
          }

          if (!found) {
            if (errors.length > 0) {
              sendError(res, 500, "STORE_ITEM_LOOKUP_FAILED", errors.map((err) => `${err.projectId}: ${err.message}`).join('; '));
              return;
            }
            sendError(res, 404, "STORE_ITEM_NOT_FOUND", `Store item not found: ${itemId}`);
            return;
          }

          if (isApi) {
            sendJSON(res, 200, { success: true, store: storeName, project: found.projectId, item: found.item });
            return;
          }
        }

        // GET /sessions (+ /api/sessions): operator surface listing every run.
        // API-key gated (not a capability route). Filters: ?agent= ?status=
        // ?trigger= ?approval=
        // ?window=<1h|6h|24h|7d|30d|90d|all> (default: 24h).
        // Legacy ?days=<n|all> and ?hours=<n> still work.
        if (req.method === "GET" && routePath === '/sessions') {
          if (isApi) {
            const result = await buildSessionsPayload(requestUrl);
            if (!result.success) {
              sendError(res, result.status, result.code, result.message);
              return;
            }
            sendJSON(res, 200, result.payload);
            return;
          }
        }

        const sessionListEventsMatch = req.method === "GET" ? routePath.match(/^\/sessions\/events$/) : null;
        if (sessionListEventsMatch) {
          const streamKey = [
            'sessions',
            requestUrl.searchParams.get('window') ?? '',
            requestUrl.searchParams.get('days') ?? '',
            requestUrl.searchParams.get('hours') ?? '',
            requestUrl.searchParams.get('status') ?? '',
            requestUrl.searchParams.get('trigger') ?? '',
            requestUrl.searchParams.get('agent') ?? '',
            requestUrl.searchParams.get('approval') ?? ''
          ].join(':');
          const poll: import("./serve/sse").ApprovalListPoll<SessionsPayload> = async () => {
            const result = await buildSessionsPayload(requestUrl);
            return result.success
              ? { ok: true, snapshot: result.payload }
              : { ok: false, error: { code: result.code, message: result.message } };
          };
          if (!sessionListHub.subscribe({ key: streamKey, poll, req, res })) {
            sendError(res, 503, "TOO_MANY_SUBSCRIBERS", "Too many live session-list connections");
          }
          return;
        }

        // GET /api/sessions/:id: JSON twin of the session page. Header-gated
        // (handled by the global gate above, since this is an `/api/*` route).
        const sessionApiMatch = (req.method === "GET" && isApi) ? routePath.match(/^\/sessions\/([^/?#]+)$/) : null;
        if (sessionApiMatch) {
          const sessionId = decodeURIComponent(sessionApiMatch[1]);
          const projectId = requestUrl.searchParams.get('project') ?? undefined;
          const found = await findSessionInfo(sessionId, projectId);
          if (!found.success) {
            sendError(res, found.status, found.code, found.message);
            return;
          }
          const activeKey = `${found.project.id}:${sessionId}`;
          const sessionStatus = activeApprovalResumes.has(activeKey)
            ? 'resuming'
            : activeSessionContinuations.has(activeKey)
              ? 'continuing'
              : found.info.approval.sessionStatus === 'suspended'
                ? 'waiting'
                : found.info.approval.sessionStatus;
          sendJSON(res, 200, {
            success: true,
            session: {
              ...found.info.approval,
              status: sessionStatus,
              project: found.project.id,
            }
          });
          return;
        }

        // GET /sessions/:id (HTML): the unified view + approve page. Exempt from
        // the global header gate; authorized via session token / api key / local.
        // GET /sessions/:id (HTML): serve the SPA shell. The SPA fetches its
        // data from /sessions/:id/{status,events} authorized via ?token=. When
        // the caller arrives with a legacy gate resumeToken (old Slack links) or
        // an api-key header (which the browser will not resend on later fetches),
        // mint the canonical session-view token and 302 to a tokenized URL so the
        // client's own fetches authorize. On local (no api key) the token is
        // empty and links omit it; nothing to convert.
        const sessionPageMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)$/) : null;
        if (sessionPageMatch) {
          const sessionId = decodeURIComponent(sessionPageMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;

          if (apiKey && !validateSessionToken(token, sessionId, apiKey)) {
            let allow = validateApiKey(req, apiKey);
            if (!allow && token) {
              // Not an escalation: the legacy /approvals/:id?token=<resumeToken>
              // page already granted approve to the same holder.
              const legacy = await findApprovalInfo({ ...(projectId && { projectId }), sessionId, resumeToken: token, allowHistorical: true });
              allow = legacy.success;
            }
            if (allow) {
              const minted = sessionViewToken(sessionId, apiKey);
              const target = new URL(`/sessions/${encodeURIComponent(sessionId)}`, serverUrl);
              if (minted) target.searchParams.set('token', minted);
              if (projectId) target.searchParams.set('project', projectId);
              res.writeHead(302, { Location: `${target.pathname}${target.search}` });
              res.end();
              return;
            }
            // Otherwise fall through and serve the shell anyway; the client's
            // /status fetch surfaces the 401 in the SPA's auth-error UI.
          }

          const shell = staticAssets.renderShell();
          if (!shell) {
            sendHTML(res, 503, renderWebAssetsMissingPage());
            return;
          }
          sendHTML(res, 200, shell);
          return;
        }

        // GET /sessions/:id/events: SSE stream of session status + log deltas.
        // Same capability auth as the page; the hub runs one shared worker poll
        // per session and pushes only changes. The poll closure reproduces the
        // /status?logs=1 body exactly, so the stream and the polling fallback are
        // equivalent.
        const sessionEventsMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/events$/) : null;
        if (sessionEventsMatch) {
          const sessionId = decodeURIComponent(sessionEventsMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;
          if (!sessionAuthorized(sessionId, token)) {
            sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
            return;
          }
          const poll: import("./serve/sse").SessionPoll = async () => {
            const found = await findSessionInfo(sessionId, projectId);
            if (!found.success) {
              return { ok: false, error: { code: found.code, message: found.message } };
            }
            const activeKey = `${found.project.id}:${sessionId}`;
            const status = activeApprovalResumes.has(activeKey)
              ? 'resuming'
              : activeSessionContinuations.has(activeKey)
                ? 'continuing'
                : found.info.approval.sessionStatus === 'suspended'
                  ? 'waiting'
                  : found.info.approval.sessionStatus;
            const logs = logsWithChildSessions(
              found.info.approval.logs ?? [],
              found.info.approval.childSessions ?? [],
              (childSessionId) => {
                const params = new URLSearchParams();
                const childToken = sessionViewToken(childSessionId, apiKey);
                if (childToken) params.set('token', childToken);
                params.set('project', found.project.id);
                return `/sessions/${encodeURIComponent(childSessionId)}?${params.toString()}`;
              }
            );
            const approval = { ...found.info.approval };
            delete approval.logs;
            return { ok: true, snapshot: { status, approval, logs } };
          };
          if (!approvalHub.subscribe({ key: sessionId, sessionId, poll, req, res })) {
            sendError(res, 503, "TOO_MANY_SUBSCRIBERS", "Too many live connections for this session");
          }
          return;
        }

        // GET /sessions/:id/status: live status poll for the session page.
        const sessionStatusMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/status$/) : null;
        if (sessionStatusMatch) {
          const sessionId = decodeURIComponent(sessionStatusMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;
          const includeLogs = requestUrl.searchParams.get('logs') === '1';
          if (!sessionAuthorized(sessionId, token)) {
            sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
            return;
          }
          if (!includeLogs) {
            const found = await findSessionStatusInfo(sessionId, projectId);
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }
            const activeKey = `${found.project.id}:${sessionId}`;
            const status = activeApprovalResumes.has(activeKey)
              ? 'resuming'
              : activeSessionContinuations.has(activeKey)
                ? 'continuing'
                : found.session.sessionStatus === 'suspended'
                  ? 'waiting'
                  : found.session.sessionStatus;
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              success: true,
              sessionId,
              status,
              project: found.project.id,
              approval: found.session
            }));
            return;
          }

          const found = await findSessionInfo(sessionId, projectId);
          if (!found.success) {
            sendError(res, found.status, found.code, found.message);
            return;
          }
          const activeKey = `${found.project.id}:${sessionId}`;
          const status = activeApprovalResumes.has(activeKey)
            ? 'resuming'
            : activeSessionContinuations.has(activeKey)
              ? 'continuing'
              : found.info.approval.sessionStatus === 'suspended'
                ? 'waiting'
                : found.info.approval.sessionStatus;
          const logs = logsWithChildSessions(
            found.info.approval.logs ?? [],
            found.info.approval.childSessions ?? [],
            (childSessionId) => {
              const params = new URLSearchParams();
              const childToken = sessionViewToken(childSessionId, apiKey);
              if (childToken) params.set('token', childToken);
              params.set('project', found.project.id);
              return `/sessions/${encodeURIComponent(childSessionId)}?${params.toString()}`;
            }
          );
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            sessionId,
            status,
            approval: {
              ...found.info.approval,
              logs,
            },
            logs,
            decision: found.info.approval.decision
          }));
          return;
        }

        // GET /sessions/:id/artifacts/*: serve a local file artifact referenced
        // by an await_human gate, for the in-page popup viewer. Same session auth
        // as the page; the file is resolved against the project root with a
        // traversal + secrets guard.
        const sessionArtifactMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/artifacts\/(.+)$/) : null;
        if (sessionArtifactMatch) {
          const sessionId = decodeURIComponent(sessionArtifactMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;
          if (!sessionAuthorized(sessionId, token)) {
            sendHTML(res, 401, '<!doctype html><title>Artifact</title><p>Not authorized for this session.</p>');
            return;
          }
          const found = await findSessionInfo(sessionId, projectId);
          if (!found.success) {
            sendHTML(res, found.status, `<!doctype html><title>Artifact</title><p>${escapeHtml(found.message)}</p>`);
            return;
          }
          await serveSessionArtifact(res, found.project.root, sessionArtifactMatch[2], requestUrl.searchParams.get('theme') ?? undefined);
          return;
        }

        // POST /sessions/:id/decision: approve / reject / comment on the current
        // pending gate. Authorized via session token / api key / local; the gate
        // resumeToken is resolved server-side from session state.
        const sessionDecisionMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/decision$/) : null;
        if (sessionDecisionMatch) {
          try {
            const sessionId = decodeURIComponent(sessionDecisionMatch[1]);
            const token = requestUrl.searchParams.get('token') ?? undefined;
            const body = await parseJSONBody(req);
            const status = typeof body.status === 'string' ? body.status : undefined;
            const comment = typeof body.comment === 'string' && body.comment.length > 0 ? body.comment : undefined;
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

            if (!sessionAuthorized(sessionId, token)) {
              sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
              return;
            }
            if (!status) {
              sendError(res, 400, "STATUS_REQUIRED", "Missing approval status");
              return;
            }

            const found = await findSessionInfo(sessionId, projectId);
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }

            const project = found.project;
            const activeKey = `${project.id}:${sessionId}`;
            if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
              sendError(res, 409, "APPROVAL_RESUMING", "Approval decision has already been submitted and the session is resuming");
              return;
            }
            const info = found.info;
            if (info.approval.sessionStatus !== 'suspended') {
              sendError(res, 409, "SESSION_NOT_SUSPENDED", `Session is ${info.approval.sessionStatus}`);
              return;
            }
            const resumeToken = info.approval.currentResumeToken;
            if (!resumeToken) {
              sendError(res, 404, "APPROVAL_NOT_FOUND", `No pending approval gate for session ${sessionId}`);
              return;
            }
            if (info.approval.expiresAt !== undefined && info.approval.expiresAt <= Date.now()) {
              sendError(res, 410, "APPROVAL_EXPIRED", "Approval request has expired");
              return;
            }

            startApprovalResume(res, { project, sessionId, info, resumeToken, status, comment });
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /sessions/:id/continue: send a follow-up instruction to an ended
        // session, continuing it with its existing context.
        const sessionContinueMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/continue$/) : null;
        if (sessionContinueMatch) {
          try {
            const sessionId = decodeURIComponent(sessionContinueMatch[1]);
            const token = requestUrl.searchParams.get('token') ?? undefined;
            const body = await parseJSONBody(req);
            const prompt = typeof body.prompt === 'string' && body.prompt.trim().length > 0 ? body.prompt.trim() : undefined;
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

            if (!sessionAuthorized(sessionId, token)) {
              sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
              return;
            }
            if (!prompt) {
              sendError(res, 400, "PROMPT_REQUIRED", "Missing continuation prompt");
              return;
            }

            const found = await findSessionInfo(sessionId, projectId);
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }

            const project = found.project;
            const activeKey = `${project.id}:${sessionId}`;
            if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
              sendError(res, 409, "SESSION_ACTIVE", `Session ${sessionId} is already being resumed`);
              return;
            }

            const sessionStatus = found.info.approval.sessionStatus;
            if (sessionStatus === 'suspended') {
              sendError(res, 409, "SESSION_SUSPENDED", "Session is suspended; submit an approval decision instead");
              return;
            }
            if (sessionStatus === 'running') {
              sendError(res, 409, "SESSION_RUNNING", `Session ${sessionId} is already running`);
              return;
            }
            if (!isEndedSessionStatus(sessionStatus)) {
              sendError(res, 409, "SESSION_NOT_ENDED", `Session is ${sessionStatus}`);
              return;
            }

            startSessionContinue(res, { project, sessionId, prompt });
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /sessions/:id/stop: abort a live session and mark it plus its
        // subagent children as stopped. Authorized the same way as the session
        // page: local, session token, or API key.
        const sessionStopMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/stop$/) : null;
        if (sessionStopMatch) {
          try {
            const sessionId = decodeURIComponent(sessionStopMatch[1]);
            const token = requestUrl.searchParams.get('token') ?? undefined;
            const body = await parseJSONBody(req);
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;
            const reason = typeof body.reason === 'string' && body.reason.trim().length > 0
              ? body.reason.trim()
              : undefined;

            if (!sessionAuthorized(sessionId, token)) {
              sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
              return;
            }

            const found = await findSessionInfo(sessionId, projectId);
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }

            const project = found.project;
            const projectWorker = workers.get(project.id);
            if (!projectWorker) {
              sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
              return;
            }

            const activeKey = `${project.id}:${sessionId}`;
            activeApprovalResumes.delete(activeKey);
            activeSessionContinuations.delete(activeKey);

            const result = await projectWorker.stopSession({
              projectRoot: project.root,
              sessionId,
              reason,
            });
            if (!result.success) {
              sendError(res, 500, result.error.code, result.error.message);
              return;
            }
            sendJSON(res, 200, { success: true, sessionId, stopped: result.stopped });
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        if (req.method === "GET" && routePath === '/approvals') {
          if (isApi) {
            const result = await buildApprovalListPayload(requestUrl);
            if (!result.success) {
              sendError(res, result.status, result.code, result.message);
              return;
            }
            sendJSON(res, 200, result.payload);
            return;
          }
        }

        const approvalListEventsMatch = req.method === "GET" ? routePath.match(/^\/approvals\/events$/) : null;
        if (approvalListEventsMatch) {
          const streamKey = [
            'approvals',
            requestUrl.searchParams.get('days') ?? '',
            requestUrl.searchParams.get('project') ?? ''
          ].join(':');
          const poll: import("./serve/sse").ApprovalListPoll<ApprovalListPayload> = async () => {
            const result = await buildApprovalListPayload(requestUrl);
            return result.success
              ? { ok: true, snapshot: result.payload }
              : { ok: false, error: { code: result.code, message: result.message } };
          };
          if (!approvalListHub.subscribe({ key: streamKey, poll, req, res })) {
            sendError(res, 503, "TOO_MANY_SUBSCRIBERS", "Too many live approval-list connections");
          }
          return;
        }

        // The single-approval view is an HTML page (embedded in Slack); it has no
        // JSON twin, so it only matches at root, never under `/api/*`.
        // The approval detail page is now the unified session page. Redirect
        // GET /approvals/:id -> /sessions/:id, carrying any token through. Old
        // Slack links carry a gate resumeToken; the session page accepts it as a
        // view credential during the transition window (see sessionPageMatch).
        const approvalPageMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/approvals\/([^/?#]+)$/) : null;
        if (approvalPageMatch) {
          const sessionId = decodeURIComponent(approvalPageMatch[1]);
          const target = new URL(`/sessions/${encodeURIComponent(sessionId)}`, serverUrl);
          const token = requestUrl.searchParams.get('token');
          const projectId = requestUrl.searchParams.get('project');
          if (token) target.searchParams.set('token', token);
          if (projectId) target.searchParams.set('project', projectId);
          res.writeHead(302, { Location: `${target.pathname}${target.search}` });
          res.end();
          return;
        }

        const approvalRequestedMatch = req.method === "POST" ? routePath.match(/^\/approvals\/([^/?#]+)\/requested$/) : null;
        if (approvalRequestedMatch) {
          try {
            const sessionId = decodeURIComponent(approvalRequestedMatch[1]);
            const body = await parseJSONBody(req);
            const token = typeof body.resumeToken === 'string' ? body.resumeToken : undefined;
            const approvalUrl = typeof body.approvalUrl === 'string' ? body.approvalUrl : undefined;
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

            if (!token) {
              sendError(res, 401, "RESUME_TOKEN_REQUIRED", "Missing approval token");
              return;
            }

            const found = await findApprovalInfo({
              ...(projectId && { projectId }),
              sessionId,
              resumeToken: token,
            });
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }

            const logKey = `${found.project.id}:${sessionId}:${token}`;
            if (!loggedApprovalRequests.has(logKey)) {
              loggedApprovalRequests.add(logKey);
              const filePath = found.info.approval.agent.filePath;
              const agentLabel = filePath
                ? relative(found.project.root, filePath)
                : found.info.approval.agent.name;
              approvalLog.sent(
                multiProject ? `${found.project.id}/${agentLabel}` : agentLabel,
                found.info.approval.approvalUrl ?? approvalUrl,
                sessionId
              );
            }

            sendJSON(res, 200, { success: true, status: "logged", sessionId });
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        const approvalStatusMatch = req.method === "GET" ? routePath.match(/^\/approvals\/([^/?#]+)\/status$/) : null;
        if (approvalStatusMatch) {
          const sessionId = decodeURIComponent(approvalStatusMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;
          if (!token) {
            sendError(res, 401, "RESUME_TOKEN_REQUIRED", "Missing approval token");
            return;
          }

          const found = await findApprovalInfo({
            ...(projectId && { projectId }),
            sessionId,
            resumeToken: token,
            allowHistorical: true,
          });
          if (!found.success) {
            sendError(res, found.status, found.code, found.message);
            return;
          }

          const activeKey = `${found.project.id}:${sessionId}`;
          const status = activeApprovalResumes.has(activeKey)
            ? 'resuming'
            : activeSessionContinuations.has(activeKey)
              ? 'continuing'
            : found.info.approval.sessionStatus === 'suspended'
              ? 'waiting'
              : found.info.approval.sessionStatus;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            sessionId,
            status,
            approval: found.info.approval,
            logs: found.info.approval.logs ?? [],
            decision: found.info.approval.decision
          }));
          return;
        }

        const approvalDecisionMatch = req.method === "POST" ? routePath.match(/^\/approvals\/([^/?#]+)\/decision$/) : null;
        if (approvalDecisionMatch) {
          try {
            const sessionId = decodeURIComponent(approvalDecisionMatch[1]);
            const body = await parseJSONBody(req);
            const token = typeof body.resumeToken === 'string' ? body.resumeToken : undefined;
            const status = typeof body.status === 'string' ? body.status : undefined;
            const comment = typeof body.comment === 'string' && body.comment.length > 0 ? body.comment : undefined;
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

            if (!token) {
              sendError(res, 401, "RESUME_TOKEN_REQUIRED", "Missing approval token");
              return;
            }
            if (!status) {
              sendError(res, 400, "STATUS_REQUIRED", "Missing approval status");
              return;
            }

            const found = await findApprovalInfo({
              ...(projectId && { projectId }),
              sessionId,
              resumeToken: token
            });
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }
            if (
              !found.info.approval.currentResumeToken &&
              !found.info.approval.approvalUrl &&
              found.info.approval.decision === undefined
            ) {
              sendError(res, 404, "APPROVAL_NOT_FOUND", `Approval request not found for session ${sessionId}`);
              return;
            }

            const project = found.project;
            const projectWorker = workers.get(project.id);
            if (!projectWorker) {
              sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
              return;
            }

            const activeKey = `${project.id}:${sessionId}`;
            if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
              sendError(res, 409, "APPROVAL_RESUMING", "Approval decision has already been submitted and the session is resuming");
              return;
            }
            const info = found.info;
            if (info.approval.sessionStatus !== 'suspended') {
              sendError(res, 409, "SESSION_NOT_SUSPENDED", `Session is ${info.approval.sessionStatus}`);
              return;
            }
            if (info.approval.expiresAt !== undefined && info.approval.expiresAt <= Date.now()) {
              sendError(res, 410, "APPROVAL_EXPIRED", "Approval request has expired");
              return;
            }

            startApprovalResume(res, { project, sessionId, info, resumeToken: token, status, comment });
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        const approvalContinueMatch = req.method === "POST" ? routePath.match(/^\/approvals\/([^/?#]+)\/continue$/) : null;
        if (approvalContinueMatch) {
          try {
            const sessionId = decodeURIComponent(approvalContinueMatch[1]);
            const body = await parseJSONBody(req);
            const token = typeof body.resumeToken === 'string' ? body.resumeToken : undefined;
            const prompt = typeof body.prompt === 'string' && body.prompt.trim().length > 0 ? body.prompt.trim() : undefined;
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

            if (!token) {
              sendError(res, 401, "RESUME_TOKEN_REQUIRED", "Missing approval token");
              return;
            }
            if (!prompt) {
              sendError(res, 400, "PROMPT_REQUIRED", "Missing continuation prompt");
              return;
            }

            const found = await findApprovalInfo({
              ...(projectId && { projectId }),
              sessionId,
              resumeToken: token,
              allowHistorical: true
            });
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }
            if (
              !found.info.approval.currentResumeToken &&
              !found.info.approval.approvalUrl &&
              found.info.approval.decision === undefined
            ) {
              sendError(res, 404, "APPROVAL_NOT_FOUND", `Approval request not found for session ${sessionId}`);
              return;
            }

            const project = found.project;
            const projectWorker = workers.get(project.id);
            if (!projectWorker) {
              sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
              return;
            }

            const activeKey = `${project.id}:${sessionId}`;
            if (activeApprovalResumes.has(activeKey) || activeSessionContinuations.has(activeKey)) {
              sendError(res, 409, "SESSION_ACTIVE", `Session ${sessionId} is already being resumed`);
              return;
            }

            const sessionStatus = found.info.approval.sessionStatus;
            if (sessionStatus === 'suspended') {
              sendError(res, 409, "SESSION_SUSPENDED", "Session is suspended; submit an approval decision instead");
              return;
            }
            if (sessionStatus === 'running') {
              sendError(res, 409, "SESSION_RUNNING", `Session ${sessionId} is already running`);
              return;
            }
            if (!isEndedSessionStatus(sessionStatus)) {
              sendError(res, 409, "SESSION_NOT_ENDED", `Session is ${sessionStatus}`);
              return;
            }

            startSessionContinue(res, { project, sessionId, prompt });
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        const resumeMatch = req.method === "POST" ? routePath.match(/^\/resume\/([^/?#]+)/) : null;
        if (resumeMatch) {
          try {
            const body = await parseJSONBody(req);
            const sessionId = decodeURIComponent(resumeMatch[1]);
            const projectId = typeof body.project === 'string' ? body.project : undefined;
            const located = await findSessionStatusInfo(sessionId, projectId);

            if (!located.success) {
              sendError(res, located.status, located.code, located.message);
              return;
            }

            const project = located.project;
            const projectWorker = workers.get(project.id);
            if (!projectWorker) {
              sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
              return;
            }

            projectWorker.execute({
              projectRoot: project.root,
              sessionId,
              toolResult: body.toolResult,
              resumeToken: typeof body.resumeToken === 'string'
                ? body.resumeToken
                : req.headers.authorization?.startsWith('Bearer ')
                  ? req.headers.authorization.slice(7)
                  : undefined,
              debug: options.debug,
            }).then(result => {
              if (!result.success) {
                logger.warn(`Resume ${sessionId} failed: ${result.error.message}`);
              }
            });

            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessionId, status: "running" }));
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        if (req.method !== "POST" || routePath !== "/run") {
          sendError(res, 404, "NOT_FOUND", "Endpoint not found. Use POST /api/run or GET /api");
          return;
        }

        const startTime = Date.now();

        try {
          // Parse request
          const body = await parseRequestBody(req);
          const wantsStream = req.headers.accept?.includes("application/x-ndjson");

          // Resolve project
          const resolved = resolveRequestProject(body);
          if ('error' in resolved) {
            const { status, code, message, extra } = resolved.error;
            if (extra) {
              res.writeHead(status, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ success: false, error: { code, message }, ...extra }));
            } else {
              sendError(res, status, code, message);
            }
            return;
          }
          const project = resolved.project;

          // Resolve agent path
          const agentPath = resolveScopedAgentPath(project, body.agent);
          if (!existsSync(agentPath)) {
            sendError(res, 404, "AGENT_NOT_FOUND", `Agent file not found: ${body.agent}`);
            return;
          }

          // Security: ensure API agent paths stay within the served scope.
          if (!isPathInside(project.scopeRoot, agentPath)) {
            sendError(res, 400, "INVALID_PATH", "Agent path must be within served directory");
            return;
          }

          executionLog.start(multiProject ? `${project.id}/${body.agent}` : body.agent);

          // Parse agent for telemetry (env validation happens in the worker,
          // which loads the project's .env before checking process.env)
          const agent = await parseAgent(agentPath);

          // Create abort controller for timeout
          const timeoutSeconds = body.timeout ?? agent.config.timeout ?? 300;
          const abortController = new AbortController();
          const timeoutId = setTimeout(() => abortController.abort(), timeoutSeconds * 1000);

          // Handle client disconnect
          req.on("close", () => {
            abortController.abort();
          });

          const projectWorker = workers.get(project.id);
          if (!projectWorker) {
            clearTimeout(timeoutId);
            sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
            return;
          }

          // Execute via worker process to work around EBADF issue in async callbacks
          // MCP server spawning fails in HTTP handlers due to bundler/Node.js fd issues
          const spawnResult = await projectWorker.execute({
            agentPath: toProjectRelativeAgentPath(project, body.agent),
            projectRoot: project.root,
            prompt: body.prompt,
            model: body.model,
            timeout: timeoutSeconds,
            maxSteps: body.maxSteps,
            debug: options.debug,
            sessionId: body.sessionId,
            trigger: 'api',
          });

          clearTimeout(timeoutId);
          const duration = Date.now() - startTime;

          if (spawnResult.success) {
            totalExecutions++;
            successfulExecutions++;

            // Capture telemetry
            telemetry.captureExecution({
              ...parseModel(body.model || agent.config.model),
              durationMs: duration,
              inputTokens: spawnResult.result.tokens?.input ?? 0,
              outputTokens: spawnResult.result.tokens?.output ?? 0,
              success: true,
              features: {
                mcpServersCount: Object.keys(agent.config.mcpServers || {}).length,
                subagentsConfigured: agent.config.subagents?.length ?? 0,
                skillsUsed: false,
                mode: 'webhook',
              },
              config: {
                timeoutCustom: body.timeout !== undefined || agent.config.timeout !== undefined,
                maxStepsCustom: body.maxSteps !== undefined || agent.config.maxSteps !== undefined,
                quietMode: true,
                debugMode: options.debug ?? false,
              },
            });

            if (spawnResult.result.finishReason !== 'suspended') {
              executionLog.complete(body.agent, duration);
            }

            if (wantsStream) {
              // NDJSON streaming response - send result as text chunk then finish
              res.writeHead(200, {
                "Content-Type": "application/x-ndjson",
                "Transfer-Encoding": "chunked",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });

              // Send text chunk
              const textChunk: AgentChunk = {
                type: "text",
                text: spawnResult.result.text,
              };
              res.write(JSON.stringify(textChunk) + "\n");

              // Send finish chunk
              const finishChunk: AgentChunk = {
                type: "finish",
                finishReason: spawnResult.result.finishReason || "end-turn",
              };
              res.write(JSON.stringify({ ...finishChunk, duration }) + "\n");
              res.end();
            } else {
              // JSON response
              const response: RunResponse = {
                success: true,
                result: {
                  text: spawnResult.result.text,
                  ...(spawnResult.result.finishReason && { finishReason: spawnResult.result.finishReason }),
                  duration,
                  ...(spawnResult.result.tokens && { tokens: spawnResult.result.tokens }),
                  toolCalls: spawnResult.result.toolCalls,
                },
              };
              sendJSON(res, 200, response);
            }
          } else {
            totalExecutions++;
            failedExecutions++;

            const errorCode = spawnResult.error.code;
            const errorMessage = spawnResult.error.message;

            // Capture telemetry
            telemetry.captureExecution({
              ...parseModel(body.model || agent.config.model),
              durationMs: duration,
              inputTokens: 0,
              outputTokens: 0,
              success: false,
              errorType: errorCode === 'TIMEOUT' ? 'timeout' : 'unknown',
              features: {
                mcpServersCount: Object.keys(agent.config.mcpServers || {}).length,
                subagentsConfigured: agent.config.subagents?.length ?? 0,
                skillsUsed: false,
                mode: 'webhook',
              },
            });

            if (errorCode === 'TIMEOUT') {
              executionLog.timeout(body.agent, duration);
            } else {
              executionLog.failed(body.agent, duration, errorMessage);
            }

            if (wantsStream) {
              // NDJSON streaming response - send error chunk
              res.writeHead(200, {
                "Content-Type": "application/x-ndjson",
                "Transfer-Encoding": "chunked",
                "Cache-Control": "no-cache",
                "Connection": "keep-alive",
              });

              const errorChunk: AgentChunk = {
                type: "error",
                error: errorMessage,
              };
              res.write(JSON.stringify(errorChunk) + "\n");
              res.end();
            } else {
              // JSON error response
              const httpStatus = errorCode === 'TIMEOUT' ? 504 : 500;
              sendError(res, httpStatus, errorCode, errorMessage);
            }
          }
        } catch (err) {
          const message = (err as Error).message;

          if (message.includes("Invalid JSON")) {
            sendError(res, 400, "INVALID_REQUEST", message);
          } else if (message.includes("Missing required")) {
            sendError(res, 400, "MISSING_FIELD", message);
          } else if (message.includes("not found")) {
            sendError(res, 404, "AGENT_NOT_FOUND", message);
          } else {
            sendError(res, 500, "INTERNAL_ERROR", message);
          }
        }
      });

      // Graceful shutdown
      const shutdown = async () => {
        console.log("\nShutting down...");

        // Unregister from process registry
        unregisterServer();

        scheduler.shutdown();
        approvalHub.shutdown();
        approvalListHub.shutdown();
        sessionListHub.shutdown();
        if (approvalSweepTimer) {
          clearInterval(approvalSweepTimer);
          approvalSweepTimer = null;
        }
        if (slackApprovalSocket) {
          await slackApprovalSocket.stop().catch(() => {/* ignore */});
        }
        for (const w of workers.values()) w.shutdown();
        for (const fw of fileWatchers) fw.close().catch(() => {/* ignore */});

        // Capture server shutdown telemetry
        telemetry.captureServerShutdown({
          uptimeMs: Date.now() - serverStartTime,
          totalExecutions,
          successfulExecutions,
          failedExecutions,
        });
        await telemetry.shutdown();

        server.close(() => {
          console.log("Server closed");
          const done = logHandle ? logHandle.close() : Promise.resolve();
          done.finally(() => process.exit(0));
        });
      };

      process.on("SIGINT", shutdown);
      process.on("SIGTERM", shutdown);

      // Handle server errors (e.g., port already in use)
      server.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          console.error(chalk.red(`\nError: Port ${port} is already in use.`));
          console.error(chalk.dim(`\nTry one of these:`));
          console.error(chalk.dim(`  • Use a different port: agentuse serve --port ${port + 1}`));
          console.error(chalk.dim(`  • See the running daemon: agentuse serve ps`));
          process.exit(1);
        }
        // Re-throw other errors
        throw err;
      });

      // Approval expiration is a housekeeping task; keep it off the startup and
      // dashboard refresh hot path.
      approvalSweepTimer = setInterval(() => {
        void runApprovalSweep();
      }, APPROVAL_SWEEP_INTERVAL_MS);

      server.listen(port, effectiveHost, () => {
        const schedules = scheduler.list();
        const totalAgents = projects.reduce((a, p) => a + p.agentFiles.length, 0);
        const registryProjects: ServerProjectEntry[] = projects.map((p) => ({
          id: p.id,
          root: p.root,
          ...(p.scopeRoot !== p.root && { scopeRoot: p.scopeRoot }),
          agentCount: p.agentFiles.length,
          scheduleCount: schedules.filter((s) => s.projectId === p.id).length,
        }));

        // Start the flat log file before the banner so startup output is captured.
        let logFilePath: string | undefined;
        if (effectiveLogFile) {
          try {
            logHandle = startLogFile({ path: getDefaultLogFilePath(process.pid) });
            logFilePath = logHandle.path;
          } catch (err) {
            logger.warn(`Could not open server log file: ${(err as Error).message}`);
          }
        }

        // Register server in the process registry
        registerServer({
          port,
          host: effectiveHost,
          publicUrl: effectivePublicUrl,
          projectRoot: projects[0].root,
          startTime: serverStartTime,
          agentCount: totalAgents,
          scheduleCount: schedules.length,
          version: packageVersion,
          projects: registryProjects,
          ...(logFilePath && { logFile: logFilePath }),
        });

        printLogo();

        // Server info
        console.log(`  ${chalk.dim("Server")}    ${chalk.cyan(serverUrl)}`);
        console.log(`  ${chalk.dim("Public")}    ${chalk.cyan(effectivePublicUrl)}`);
        if (!multiProject) {
          console.log(`  ${chalk.dim("AgentUse data")}`);
          console.log(`    ${chalk.dim("Global")}  ${chalk.dim("~/.agentuse")}`);
          console.log(`    ${chalk.dim("Project")} ${chalk.dim(join(projects[0].root, '.agentuse'))}`);
          console.log(`  ${chalk.dim("Scope")}     ${projects[0].scopeRoot}`);
        } else {
          console.log(`  ${chalk.dim("Projects")}  ${projects.length}`);
          for (const p of projects) {
            const scheduleN = schedules.filter((s) => s.projectId === p.id).length;
            const marker = effectiveDefault === p.id ? chalk.green(' (default)') : '';
            const scopeLabel = p.scopeRoot !== p.root ? ` scope ${relative(p.root, p.scopeRoot)}` : '';
            console.log(`    ${chalk.cyan(p.id.padEnd(20))} ${chalk.dim(p.root)}  ${chalk.dim(`${p.agentFiles.length} agents, ${scheduleN} scheduled${scopeLabel}`)}${marker}`);
          }
        }
        if (apiKey) {
          console.log(`  ${chalk.dim("Auth")}      ${chalk.green("API key required")}`);
        } else if (isExposedHost(effectiveHost)) {
          console.log(`  ${chalk.dim("Auth")}      ${chalk.yellow("No API key (--no-auth)")}`);
        } else {
          console.log(`  ${chalk.dim("Auth")}      ${chalk.dim("None (localhost)")}`);
        }
        console.log(`  ${chalk.dim("Hot reload")} ${chalk.green("enabled")}`);
        console.log(`  ${chalk.dim("Slack")}     ${slackApprovalSocket ? chalk.green("Socket Mode enabled") : chalk.dim("disabled")}`);
        if (loadedServeEnvFiles.length > 0) {
          console.log(`  ${chalk.dim("Env")}       ${chalk.dim(loadedServeEnvFiles.join(', '))}`);
        }

        // Webhooks
        console.log(`\n  ${chalk.dim("Webhooks")}`);
        const authHeader = apiKey ? ` -H "Authorization: Bearer $AGENTUSE_API_KEY"` : "";
        const firstProject = projects[0];
        const firstAgent = firstProject.agentFiles[0] || "path/to/agent.agentuse";
        if (!multiProject) {
          console.log(`    curl -X POST ${serverUrl}/run${authHeader} -H "Content-Type: application/json" -d '{"agent": "${firstAgent}"}'`);
        } else {
          console.log(`    curl -X POST ${serverUrl}/run${authHeader} -H "Content-Type: application/json" -d '{"project": "${firstProject.id}", "agent": "${firstAgent}"}'`);
          console.log(`    ${chalk.dim(`curl ${serverUrl}/ for server info`)}`);
        }
        console.log(`    ${chalk.dim(`curl -N ... -H "Accept: application/x-ndjson" -d '{"agent": "..."}' (streaming)`)}`);

        // Available agents for webhooks (only in single-project mode to avoid noise)
        if (!multiProject && firstProject.agentFiles.length > 0) {
          console.log(`\n    ${chalk.dim(`Agents (${firstProject.agentFiles.length})`)}`);
          for (const agent of firstProject.agentFiles) {
            console.log(`      ${agent}`);
          }
        }
        // Scheduled agents
        if (schedules.length > 0) {
          console.log(`\n  ${chalk.dim(`Scheduled (${schedules.length})`)}`);
          console.log(scheduler.formatScheduleTable());
        }

        console.log();

        // Capture server start telemetry
        telemetry.captureServerStart({
          port,
          host: effectiveHost,
          scheduledAgents: schedules.length,
          totalAgents,
          authEnabled: !!apiKey,
        });
      });
    });

  // Add ps and logs subcommands
  serveCmd.addCommand(createPsSubcommand());
  serveCmd.addCommand(createLogsSubcommand());
  serveCmd.addCommand(createAgentsSubcommand());
  serveCmd.addCommand(createSchedulesSubcommand());

  return serveCmd;
}

// Helper functions for ps subcommand
function truncatePath(path: string, maxLen: number): string {
  const homeDir = homedir();
  let displayPath = path.startsWith(homeDir) ? "~" + path.slice(homeDir.length) : path;
  if (displayPath.length <= maxLen) {
    return displayPath;
  }
  return "..." + displayPath.slice(-(maxLen - 3));
}

function formatPsTable(servers: ServerEntry[]): string {
  if (servers.length === 0) return "";

  const headers = ["PID", "PORT", "PROJECTS", "AGENTS", "SCHEDULES", "UPTIME"];
  const widths = [7, 7, 40, 7, 10, 10];

  const headerRow = headers.map((h, i) => h.padEnd(widths[i])).join("  ");
  const separator = widths.map((w) => "─".repeat(w)).join("──");

  const formatProjects = (s: ServerEntry): string => {
    if (s.projects && s.projects.length > 0) {
      if (s.projects.length === 1) {
        return truncatePath(s.projects[0].root, widths[2]);
      }
      const head = s.projects[0].id;
      return `${head} +${s.projects.length - 1}`;
    }
    return truncatePath(s.projectRoot, widths[2]);
  };

  const blocks: string[] = [chalk.dim(headerRow), chalk.dim(separator)];
  for (const s of servers) {
    const row = [
      String(s.pid).padEnd(widths[0]),
      String(s.port).padEnd(widths[1]),
      formatProjects(s).padEnd(widths[2]),
      String(s.agentCount).padEnd(widths[3]),
      String(s.scheduleCount).padEnd(widths[4]),
      formatUptime(s.startTime).padEnd(widths[5]),
    ].join("  ");
    blocks.push(row);
    if (s.logFile) {
      const shortLog = s.logFile.startsWith(homedir())
        ? "~" + s.logFile.slice(homedir().length)
        : s.logFile;
      blocks.push(chalk.dim(`  log: ${shortLog}`));
    }
  }
  return blocks.join("\n");
}

function summarizeServerProjects(server: ServerEntry): string {
  const projects = server.projects && server.projects.length > 0
    ? server.projects
    : [{ id: basename(server.projectRoot), root: server.projectRoot }];
  if (projects.length === 1) return truncatePath(projects[0].root, 80);
  const shown = projects.slice(0, 3).map((project) => project.id).join(", ");
  const hidden = projects.length - 3;
  return hidden > 0 ? `${shown}, +${hidden} more` : shown;
}

function createPsSubcommand(): Command {
  return new Command("ps")
    .description("Show the running agentuse serve daemon")
    .option("--json", "Output as JSON")
    .action((options: { json?: boolean }) => {
      const servers = listServers();

      if (options.json) {
        console.log(JSON.stringify(servers, null, 2));
        return;
      }

      if (servers.length === 0) {
        console.log(chalk.dim("No running agentuse serve daemon found."));
        console.log(chalk.dim("\nStart a server with: agentuse serve"));
        return;
      }

      console.log(formatPsTable(servers));
      console.log();
      console.log(chalk.dim(`${servers.length} serve daemon${servers.length === 1 ? "" : "s"} running`));
      if (servers.length > 1) {
        console.log(chalk.yellow("Only one serve daemon should be running. Stop the extras before starting new work."));
      }
    });
}

function resolveTargetServer(pidArg: string | undefined): ServerEntry | null {
  const servers = listServers();
  if (pidArg !== undefined) {
    const pid = parseInt(pidArg, 10);
    if (isNaN(pid)) {
      console.error(chalk.red(`Invalid pid: ${pidArg}`));
      return null;
    }
    const found = servers.find((s) => s.pid === pid);
    if (!found) {
      console.error(chalk.red(`No running agentuse serve daemon with pid ${pid}.`));
      console.error(chalk.dim(`Use \`agentuse serve ps\` to see the running daemon.`));
      return null;
    }
    return found;
  }
  if (servers.length === 0) {
    console.error(chalk.dim("No running agentuse serve daemon found."));
    return null;
  }
  if (servers.length > 1) {
    console.error(chalk.red("Multiple serve daemons are running; specify a pid."));
    console.error();
    console.error(formatPsTable(servers));
    return null;
  }
  return servers[0];
}

function createLogsSubcommand(): Command {
  return new Command("logs")
    .description("Show the log file for the running agentuse serve daemon")
    .argument("[pid]", "PID of the daemon to tail (omit when only one daemon is running)")
    .option("-n, --lines <number>", "Number of lines to show from the end of the file", "50")
    .option("-f, --follow", "Follow the log as it grows")
    .option("--path", "Print only the log file path and exit")
    .action((pidArg: string | undefined, options: { lines: string; follow?: boolean; path?: boolean }) => {
      const target = resolveTargetServer(pidArg);
      if (!target) {
        process.exit(1);
      }
      if (!target.logFile) {
        console.error(chalk.red(`Server pid ${target.pid} has no log file (started with --no-log-file?).`));
        process.exit(1);
      }

      if (options.path) {
        console.log(target.logFile);
        return;
      }

      const lines = parseInt(options.lines, 10);
      if (isNaN(lines) || lines < 0) {
        console.error(chalk.red(`Invalid --lines value: ${options.lines}`));
        process.exit(1);
      }

      const args = options.follow
        ? ["-n", String(lines), "-F", target.logFile]
        : ["-n", String(lines), target.logFile];
      const child = spawn("tail", args, { stdio: "inherit" });
      child.on("error", (err) => {
        console.error(chalk.red(`Failed to spawn tail: ${err.message}`));
        process.exit(1);
      });
      child.on("exit", (code) => {
        process.exit(code ?? 0);
      });
      if (options.follow) {
        const forward = (sig: NodeJS.Signals) => {
          child.kill(sig);
        };
        process.on("SIGINT", forward);
        process.on("SIGTERM", forward);
      }
    });
}

/**
 * Fetch a JSON payload from a running serve daemon's read endpoint.
 * Reuses AGENTUSE_API_KEY from the environment when the daemon requires auth.
 */
async function fetchDaemonJson(server: ServerEntry, path: string): Promise<unknown> {
  const host = server.host === "0.0.0.0" || server.host === "::" ? "127.0.0.1" : server.host;
  const headers: Record<string, string> = { Accept: "application/json" };
  const apiKey = process.env.AGENTUSE_API_KEY;
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;

  const res = await fetch(`http://${host}:${server.port}${path}`, { headers });
  if (!res.ok) {
    let detail = "";
    try {
      const body = (await res.json()) as { error?: { message?: string } };
      detail = body?.error?.message ?? "";
    } catch {
      // Non-JSON error body; fall back to status only.
    }
    const authHint = res.status === 401 ? " (set AGENTUSE_API_KEY to match the daemon)" : "";
    throw new Error(`Request to ${path} failed: ${res.status}${detail ? ` ${detail}` : ""}${authHint}`);
  }
  return res.json();
}

/** Render an aligned, headered table for CLI output (mirrors `serve ps`). */
function renderCliTable(headers: string[], rows: string[][]): string {
  const widths = headers.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => (row[i] ?? "").length))
  );
  const line = (cells: string[]) => cells.map((cell, i) => (cell ?? "").padEnd(widths[i])).join("  ");
  const out = [chalk.dim(line(headers)), chalk.dim(widths.map((w) => "─".repeat(w)).join("──"))];
  for (const row of rows) out.push(line(row));
  return out.join("\n");
}

function formatAgentsTable(agents: AgentSummary[]): string {
  if (agents.length === 0) return chalk.dim("No agents loaded by this serve daemon.");
  const multiProject = new Set(agents.map((a) => a.projectId)).size > 1;
  const rows = agents.map((a) => [
    multiProject ? `${a.projectId}/${a.path}` : a.path,
    a.name,
    a.model,
    a.schedule ?? "—",
  ]);
  return renderCliTable(["AGENT", "NAME", "MODEL", "SCHEDULE"], rows);
}

function formatLocalDateTime(iso: string | null): string {
  if (!iso) return "—";
  const ms = Date.parse(iso);
  return Number.isFinite(ms)
    ? new Date(ms).toLocaleString("en-US", { month: "short", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false })
    : "—";
}

function formatSchedulesTable(schedules: SerializedSchedule[]): string {
  if (schedules.length === 0) return chalk.dim("No scheduled agents in this serve daemon.");
  const multiProject = new Set(schedules.map((s) => s.projectId)).size > 1;
  const rows = schedules.map((s) => [
    s.nextRun ? formatLocalDateTime(s.nextRun) : "disabled",
    multiProject ? `${s.projectId}/${s.agentPath}` : s.agentPath,
    s.human,
    s.lastRun ? `${formatLocalDateTime(s.lastRun)}${s.lastResult ? (s.lastResult.success ? " ok" : " failed") : ""}` : "never",
  ]);
  return renderCliTable(["NEXT RUN", "AGENT", "SCHEDULE", "LAST RUN"], rows);
}

function createAgentsSubcommand(): Command {
  return new Command("agents")
    .description("List agents loaded by the running agentuse serve daemon")
    .argument("[pid]", "PID of the daemon to query (omit when only one daemon is running)")
    .option("--json", "Output as JSON")
    .action(async (pidArg: string | undefined, options: { json?: boolean }) => {
      const target = resolveTargetServer(pidArg);
      if (!target) process.exit(1);
      try {
        const data = (await fetchDaemonJson(target, "/api/agents")) as {
          agents: AgentSummary[];
          errors: Array<{ projectId: string; path: string; message: string }>;
        };
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(formatAgentsTable(data.agents));
        if (data.errors.length > 0) {
          console.log();
          console.log(chalk.yellow(`${data.errors.length} agent${data.errors.length === 1 ? "" : "s"} failed to parse:`));
          for (const err of data.errors) {
            console.log(chalk.dim(`  ${err.projectId}/${err.path}: ${err.message}`));
          }
        }
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}

function createSchedulesSubcommand(): Command {
  return new Command("schedules")
    .description("List scheduled agents in the running agentuse serve daemon")
    .argument("[pid]", "PID of the daemon to query (omit when only one daemon is running)")
    .option("--json", "Output as JSON")
    .action(async (pidArg: string | undefined, options: { json?: boolean }) => {
      const target = resolveTargetServer(pidArg);
      if (!target) process.exit(1);
      try {
        const data = (await fetchDaemonJson(target, "/api/schedules")) as {
          schedules: SerializedSchedule[];
        };
        if (options.json) {
          console.log(JSON.stringify(data, null, 2));
          return;
        }
        console.log(formatSchedulesTable(data.schedules));
      } catch (err) {
        console.error(chalk.red((err as Error).message));
        process.exit(1);
      }
    });
}

export const __testing = {
  serveSessionArtifact,
  isHeaderGateExemptRoute,
  isSpaPageRoute,
  collectAgents,
  formatAgentsTable,
  formatSchedulesTable,
  canContinueApprovalSession,
  isEndedSessionStatus,
  approvalListCreatedAfter,
  APPROVAL_LIST_SSE_INTERVAL_MS,
  sessionListCreatedAfter,
  SESSION_LIST_SSE_INTERVAL_MS,
  sessionMatchesAgentFilter,
};
