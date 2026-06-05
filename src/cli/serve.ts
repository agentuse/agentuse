import { Command } from "commander";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { WebClient } from "@slack/web-api";
import { timingSafeEqual } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { join, resolve, basename, relative } from "path";
import { existsSync } from "fs";
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
  approvalThemeBootScript,
  approvalsThemeToggleHtml,
  approvalsThemeToggleScript,
  approvalsTopbarMarkup,
  approvalsTopbarStyles,
  escapeHtml,
  formatApprovalTime,
  formatLogTime,
  renderInlineMarkdown,
  renderLogContentValue,
  valueAsRecord,
  normalizeApiPath
} from "./serve/ui";
import { FAVICON_SVG } from "./serve/brand";
import {
  findStoreItem,
  isSafeStoreName,
  listProjectStores,
  listStoreRows,
  renderStoreToolEvent,
  storeItemPreview,
  storeItemTitle,
  type StoreBrowserRows,
  type StoreBrowserSummary
} from "./serve/stores";

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
const APPROVAL_LIST_DEFAULT_DAYS = 30;

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

interface SessionSummary {
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
  logs?: ApprovalLogEntry[];
}

interface ApprovalLogEntry {
  id: string;
  type: string;
  tool?: string;
  status?: string;
  title: string;
  message?: string;
  time?: number;
  details?: ApprovalLogDetails;
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
  private pendingRequests: Map<string, {
    resolve: (value: WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSweepExpiredResult | WorkerListApprovalsResult | WorkerListSessionsResult | WorkerStopSessionResult) => void;
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
    options: { createdAfter?: number } = {}
  ): Promise<WorkerListSessionsResult | WorkerExecuteError> {
    return this.request({
      type: "list-sessions",
      projectRoot,
      sessionsCreatedAfter: options.createdAfter,
      timeout: 30,
    }) as Promise<WorkerListSessionsResult | WorkerExecuteError>;
  }

  private request(options: Record<string, unknown> & { timeout?: number | undefined }): Promise<WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSweepExpiredResult | WorkerListApprovalsResult | WorkerListSessionsResult | WorkerStopSessionResult> {
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
    if (this.process) {
      this.process.kill("SIGTERM");
      this.process = null;
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
  const daysParam = requestUrl.searchParams.get('days');
  if (daysParam === 'all') return undefined;

  const days = daysParam === null
    ? APPROVAL_LIST_DEFAULT_DAYS
    : Number(daysParam);
  if (!Number.isFinite(days) || days <= 0) return now - APPROVAL_LIST_DEFAULT_DAYS * 24 * 60 * 60 * 1000;

  return now - Math.floor(days) * 24 * 60 * 60 * 1000;
}

function renderLogItems(
  logs?: ApprovalLogEntry[],
  options?: { actionable?: boolean; currentResumeToken?: string | undefined; projectId?: string | undefined }
): string {
  if (!logs || logs.length === 0) {
    return '<li class="log-empty">No session events yet.</li>';
  }
  const actionable = options?.actionable ?? false;
  const currentResumeToken = options?.currentResumeToken;
  return logs.map((entry) => {
    const showActions = actionable &&
      entry.status === 'pending' &&
      Boolean(entry.details) &&
      (!currentResumeToken || entry.details?.resumeToken === currentResumeToken);
    const isApprovalEntry = Boolean(entry.details?.resumeToken);
    const expandable = entry.type === 'tool' && !isApprovalEntry;
    const expanded = !expandable || entry.status === 'running';
    const resumeTokenAttr = entry.details?.resumeToken
      ? ` data-resume-token="${escapeHtml(entry.details.resumeToken)}"`
      : '';
    const storeEventHtml = renderStoreToolEvent(entry, options?.projectId);
    const markerHtml = entry.status === 'streaming' || entry.status === 'running'
      ? '<span class="log-spinner" aria-label="streaming"></span>'
      : '⋮';
    return `
        <li class="log-item ${escapeHtml(entry.status ?? '')}${expandable ? ' expandable' : ''}${expanded ? ' expanded' : ''}" data-log-id="${escapeHtml(entry.id)}" data-log-type="${escapeHtml(entry.type)}"${resumeTokenAttr}${expandable ? ` aria-expanded="${expanded ? 'true' : 'false'}" tabindex="0"` : ''}>
          <span class="log-time">${escapeHtml(formatLogTime(entry.time))}</span>
          <span class="log-marker">${markerHtml}</span>
          <span class="log-main">
            <span class="log-title">${escapeHtml(entry.title)}</span>
            <span class="log-content">
              ${storeEventHtml}
              ${renderLogDetailBlock(entry)}
              ${entry.message && !storeEventHtml ? renderLogContentValue(entry.message, { forceMarkdown: entry.type === 'text' }) : ''}
            </span>
            ${showActions ? renderInlineActions() : ''}
          </span>
        </li>`;
  }).join('');
}

function renderInlineActions(): string {
  return `<div class="log-actions" data-actions-row>
    <div class="log-actions-hint">
      <span class="kbd">⌘⏎</span> approve <span class="kbd">esc</span> reject <span class="kbd">c</span> comment
    </div>
    <div class="log-actions-buttons">
      <button class="primary" data-action="approve">Approve</button>
      <button class="danger" data-action="reject">Reject</button>
      <button data-action="comment">Comment</button>
    </div>
  </div>`;
}

const COPY_ICON_SVG = `<svg class="copy-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="5.5" y="5.5" width="8" height="8" rx="1.5"/><path d="M3.5 10.5H3A1.5 1.5 0 0 1 1.5 9V3A1.5 1.5 0 0 1 3 1.5h6A1.5 1.5 0 0 1 10.5 3v.5"/></svg>`;
const CHECK_ICON_SVG = `<svg class="check-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 8.5l3 3 7-7"/></svg>`;

/**
 * A meta-grid cell whose value can be copied to the clipboard with one click.
 * The button carries the raw value in `data-copy`; the session page's inline JS
 * delegates clicks on `.copy-btn` and flips it to a check on success.
 */
function renderCopyCell(label: string, value: string): string {
  return `<div class="cell"><span class="label">${escapeHtml(label)}</span><span class="copyable"><code>${escapeHtml(value)}</code><button class="copy-btn" type="button" data-copy="${escapeHtml(value)}" aria-label="Copy ${escapeHtml(label)}" title="Copy ${escapeHtml(label)}">${COPY_ICON_SVG}${CHECK_ICON_SVG}</button></span></div>`;
}

function renderApprovalDetailBlock(details: ApprovalLogDetails): string {
  const decisionLabel = details.decisionStatus
    ? `${details.decisionStatus}${details.decisionReviewer ? ` by ${details.decisionReviewer}` : ''}`
    : '';
  const primary = details.draft
    ? { title: 'Draft', html: renderLogContentValue(details.draft, { forceMarkdown: true }) }
    : details.artifactUrl
      ? { title: 'Artifact', html: `<a class="approval-link" href="${escapeHtml(details.artifactUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(details.artifactUrl)}</a>` }
      : details.draftUrl
        ? { title: 'Draft', html: `<a class="approval-link" href="${escapeHtml(details.draftUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(details.draftUrl)}</a>` }
        : details.summary
          ? { title: 'Review', html: renderLogContentValue(details.summary, { forceMarkdown: true }) }
          : undefined;
  const showSummary = details.summary && primary?.title !== 'Review';
  const linkRows = [
    details.draftUrl ? `<a class="approval-link" href="${escapeHtml(details.draftUrl)}" target="_blank" rel="noopener noreferrer">Open draft</a>` : '',
    details.artifactUrl ? `<a class="approval-link" href="${escapeHtml(details.artifactUrl)}" target="_blank" rel="noopener noreferrer">Open artifact</a>` : ''
  ].filter(Boolean).join('');
  const hasContent = details.prompt || primary || details.risk || showSummary || details.context || linkRows || decisionLabel || details.decisionComment || details.errorMessage;
  if (!hasContent) return '';

  return `<div class="approval-card">
    ${details.prompt ? `<div class="approval-question">${renderInlineMarkdown(details.prompt)}</div>` : ''}
    ${details.context ? `<section class="approval-section approval-context"><div class="approval-section-title">Source context</div><div class="approval-section-body">${renderLogContentValue(details.context, { forceMarkdown: true })}</div></section>` : ''}
    ${primary ? `<section class="approval-section approval-primary"><div class="approval-section-title">${escapeHtml(primary.title)}</div><div class="approval-section-body">${primary.html}</div></section>` : ''}
    ${linkRows ? `<section class="approval-section approval-links"><div class="approval-section-title">Links</div><div class="approval-link-row">${linkRows}</div></section>` : ''}
    ${showSummary ? `<section class="approval-section approval-secondary"><div class="approval-section-title">Why this request</div><div class="approval-section-body">${renderLogContentValue(details.summary!, { forceMarkdown: true })}</div></section>` : ''}
    ${details.risk ? `<section class="approval-section approval-risk"><div class="approval-section-title">Risk / consequence</div><div class="approval-section-body">${renderLogContentValue(details.risk, { forceMarkdown: true })}</div></section>` : ''}
    ${decisionLabel ? `<section class="approval-section approval-decision"><div class="approval-section-title">Decision</div><div class="approval-section-body">${escapeHtml(decisionLabel)}</div></section>` : ''}
    ${details.decisionComment ? `<section class="approval-section approval-secondary"><div class="approval-section-title">Comment</div><div class="approval-section-body">${renderLogContentValue(details.decisionComment, { forceMarkdown: true })}</div></section>` : ''}
    ${details.errorMessage ? `<section class="approval-section approval-risk"><div class="approval-section-title">Error</div><div class="approval-section-body">${escapeHtml(details.errorMessage)}</div></section>` : ''}
  </div>`;
}

function renderToolDetailBlock(details: ApprovalLogDetails): string {
  const rows = [
    details.input ? { label: 'Input', value: details.input } : undefined,
    details.output ? { label: 'Output', value: details.output } : undefined,
    details.errorMessage ? { label: 'Error', value: details.errorMessage } : undefined
  ].filter((row): row is { label: string; value: string } => Boolean(row));
  if (rows.length === 0) return '';

  return `<div class="log-details">${rows.map((row) => `
    <div class="log-detail">
      <div class="log-detail-label">${escapeHtml(row.label)}</div>
      <div class="log-detail-value">${renderLogContentValue(row.value)}</div>
    </div>
  `).join('')}</div>`;
}

function renderLogDetailBlock(entry: ApprovalLogEntry): string {
  if (!entry.details) return '';
  return entry.details.resumeToken
    ? renderApprovalDetailBlock(entry.details)
    : renderToolDetailBlock(entry.details);
}

function latestReviewerComment(logs: ApprovalLogEntry[]): { comment: string; reviewer?: string; status?: string } | undefined {
  for (const entry of [...logs].reverse()) {
    const details = entry.details;
    if (!details?.decisionComment) continue;
    return {
      comment: details.decisionComment,
      ...(details.decisionReviewer && { reviewer: details.decisionReviewer }),
      ...(details.decisionStatus && { status: details.decisionStatus })
    };
  }
  return undefined;
}

/**
 * Shared list-row + chip styles for the Approvals and Sessions list pages, so
 * the two row layouts stay identical instead of drifting apart (the cause of
 * the layouts diverging in the first place).
 */
function approvalsListRowStyles(): string {
  return `
    .rows { display: flex; flex-direction: column; gap: 8px; }
    .row { display: block; background: var(--panel); border: 1px solid var(--line); border-radius: 10px; padding: 14px 16px; transition: background 120ms ease, border-color 120ms ease; }
    a.row { cursor: pointer; }
    a.row:hover { background: var(--panel-hover); border-color: var(--line-strong); }
    .row-static { opacity: 0.85; }
    .row-head { display: flex; flex-wrap: wrap; align-items: center; gap: 8px; margin-bottom: 8px; }
    .row-time { color: var(--muted-2); font-size: 12px; margin-left: auto; }
    .row-title { font-family: var(--sans); font-size: 16px; line-height: 1.35; color: var(--fg); font-weight: 500; overflow-wrap: anywhere; }
    .row-locator { margin-top: 3px; font-family: var(--mono); font-size: 12px; color: var(--muted-3); overflow-wrap: anywhere; }
    .row-locator code { font-family: var(--mono); }
    .row-desc { margin-top: 6px; color: var(--muted); font-size: 12.5px; line-height: 1.45; overflow-wrap: anywhere; }
    .row-decision { margin-top: 6px; color: var(--muted); font-size: 12.5px; }
    .row-meta { margin-top: 8px; color: var(--muted-2); font-size: 11px; }
    .row-meta code { font-family: var(--mono); font-size: 11px; }
    .chip { display: inline-flex; align-items: center; padding: 2px 8px; border-radius: 999px; font-size: 10.5px; letter-spacing: 0.08em; text-transform: uppercase; border: 1px solid var(--line-strong); background: var(--panel); color: var(--muted-3); }
    .chip.status.pending { color: var(--cyan); border-color: var(--cyan-border); background: var(--cyan-soft); }
    .chip.status.approved, .chip.status.commented { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
    .chip.status.rejected { color: var(--amber); border-color: var(--amber-border); background: var(--amber-soft); }
    .chip.status.expired, .chip.status.errored { color: var(--red); border-color: var(--red-border); background: var(--red-soft); }
    .chip.project { color: var(--cyan); }
    .chip.agent { color: var(--fg); }
    .empty { color: var(--muted-2); font-style: italic; padding: 14px 0; }
  `;
}

function renderApprovalRow(row: { projectId: string; multiProject: boolean; approval: ApprovalSummary }): string {
  const { approval, projectId } = row;
  // Rows link into the unified session page. Carry the gate resumeToken as the
  // token; on a remote deploy the session page accepts it as a view credential
  // (legacy fallback). On local the token is ignored (open). Rows without a
  // token are still linkable (local), so always link.
  const params = new URLSearchParams();
  if (approval.resumeToken) params.set('token', approval.resumeToken);
  const query = params.toString();
  const href = `/sessions/${encodeURIComponent(approval.sessionId)}${query ? `?${query}` : ''}`;

  // Mirror the sessions list row: the agent name is the title, the
  // project-relative file path is the locator, and the approval's
  // description/prompt is demoted to the secondary description line.
  const fileName = approval.agentId.split('/').pop() || approval.agentId;
  const agentName = approval.agentName || fileName;
  const locator = `${projectId}/${approval.agentId}.agentuse`;

  const timeLabel = approval.status === 'pending'
    ? (approval.expiresAt
      ? `expires ${formatApprovalTime(approval.expiresAt)}`
      : `suspended ${formatApprovalTime(approval.suspendedAt)}`)
    : approval.status === 'expired'
      ? `expired ${formatApprovalTime(approval.decisionAt ?? approval.expiresAt)}`
      : `decided ${formatApprovalTime(approval.decisionAt)}`;

  const descriptionText = approval.agentDescription || approval.prompt || '';
  const description = descriptionText.length > 200 ? `${descriptionText.slice(0, 200)}…` : descriptionText;
  const decisionLabel = approval.errorMessage || approval.decisionComment || '';

  const inner = `
    <div class="row-head">
      <span class="chip status ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span>
      <span class="row-time">${escapeHtml(timeLabel)}</span>
    </div>
    <div class="row-title">${escapeHtml(agentName)}</div>
    <div class="row-locator"><code>${escapeHtml(locator)}</code></div>
    ${description ? `<div class="row-desc">${escapeHtml(description)}</div>` : ''}
    ${decisionLabel ? `<div class="row-decision">${escapeHtml(decisionLabel)}</div>` : ''}
    <div class="row-meta"><code>${escapeHtml(approval.sessionId)}</code></div>
  `;

  return `<a class="row" href="${escapeHtml(href)}">${inner}</a>`;
}

function renderApprovalBucket(
  title: string,
  rows: Array<{ projectId: string; multiProject: boolean; approval: ApprovalSummary }>,
  emptyText: string
): string {
  return `
    <section class="bucket">
      <h2 class="section-title"><span>${escapeHtml(title)}</span><span class="count">${rows.length}</span><span class="rule"></span></h2>
      ${rows.length === 0
        ? `<p class="empty">${escapeHtml(emptyText)}</p>`
        : `<div class="rows">${rows.map(renderApprovalRow).join('')}</div>`}
    </section>
  `;
}

function renderStoreStyles(): string {
  return `
    ${approvalsTopbarStyles()}
    body {
      margin: 0;
      min-height: 100vh;
      background: var(--bg);
      color: var(--fg);
      font-family: var(--mono);
      font-size: 14px;
      line-height: 1.5;
      -webkit-font-smoothing: antialiased;
    }
    a { color: var(--cyan); text-decoration: none; border-bottom: 1px dotted var(--cyan-border); }
    main { width: min(1120px, calc(100vw - 32px)); margin: 0 auto; padding: 36px 0 80px; }
    header { margin-bottom: 24px; }
    .eyebrow { font-size: 11px; color: var(--cyan); letter-spacing: 0.18em; text-transform: uppercase; margin-bottom: 8px; }
    h1 { margin: 0 0 8px; font-family: var(--sans); font-size: 34px; line-height: 1.12; font-weight: 500; }
    .lede { margin: 0; color: var(--muted-3); font-family: var(--sans); font-size: 15px; }
    .panel { border: 1px solid var(--line); border-radius: 10px; background: var(--panel); overflow: hidden; }
    .store-table { width: 100%; border-collapse: collapse; }
    .store-table th, .store-table td { padding: 11px 12px; border-bottom: 1px solid var(--line); text-align: left; vertical-align: top; }
    /* Keep the Updated timestamp on one line so narrow-screen rows don't grow
       ragged heights when the date would otherwise wrap to 2-3 lines. */
    .store-table th:nth-child(3), .store-table td:nth-child(3) { white-space: nowrap; }
    .store-table th { color: var(--muted-2); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 500; background: var(--panel); }
    .store-table th[aria-sort] { color: var(--muted-3); }
    .sort-header {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 0;
      border: 0;
      background: transparent;
      color: inherit;
      font: inherit;
      letter-spacing: inherit;
      text-transform: inherit;
      cursor: pointer;
    }
    .sort-header:hover { color: var(--fg); }
    .sort-indicator { width: 10px; color: var(--cyan); text-transform: none; letter-spacing: 0; }
    .sort-indicator::before { content: ""; }
    th[aria-sort="ascending"] .sort-indicator::before { content: "^"; }
    th[aria-sort="descending"] .sort-indicator::before { content: "v"; }
    .store-table tr:last-child td { border-bottom: 0; }
    .store-table tbody tr { transition: background 160ms ease, box-shadow 160ms ease; }
    .store-table tbody tr:hover { background: var(--panel-hover); }
    .store-table tbody tr.clickable { cursor: pointer; }
    .store-table tbody tr.clickable:focus-within { outline: 2px solid var(--cyan-border); outline-offset: -2px; }
    .store-table tbody tr.highlighted { background: var(--amber-soft); box-shadow: inset 3px 0 0 var(--amber); }
    .title-cell { display: grid; gap: 4px; min-width: 260px; }
    .title-cell a { width: fit-content; font-weight: 500; color: var(--fg); border-color: var(--line-strong); }
    .preview { color: var(--muted-2); font-size: 12px; max-width: 520px; }
    .muted { color: var(--muted-2); }
    .chips { display: flex; flex-wrap: wrap; gap: 5px; }
    .chip {
      display: inline-flex; align-items: center;
      padding: 2px 7px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted-3);
      background: var(--bg);
      font-size: 11px;
      white-space: nowrap;
    }
    .chip.status { color: var(--cyan); border-color: var(--cyan-border); }
    .empty { padding: 18px; color: var(--muted-2); font-style: italic; }
    .errors { margin: 0 0 14px; padding: 12px 14px; border: 1px solid var(--red-border); border-radius: 8px; color: var(--red); background: var(--red-soft); }
    .detail-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 1px; background: var(--line); border: 1px solid var(--line); border-radius: 10px; overflow: hidden; margin-bottom: 16px; }
    .detail-cell { background: var(--bg); padding: 12px 14px; }
    .detail-label { display: block; color: var(--muted-2); font-size: 11px; letter-spacing: 0.1em; text-transform: uppercase; margin-bottom: 5px; }
    .data-grid { display: grid; gap: 10px; }
    .data-field { display: grid; gap: 5px; }
    .data-key { color: var(--cyan); font-size: 11px; letter-spacing: 0.08em; }
    .data-value { border: 1px solid var(--line); border-radius: 8px; background: var(--bg); padding: 10px 12px; color: var(--muted-3); white-space: pre-wrap; overflow-wrap: anywhere; }
    .data-value pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12.5px; }
    .tabs { display: inline-flex; gap: 4px; margin: 0 0 12px; padding: 3px; border: 1px solid var(--line); border-radius: 8px; background: var(--panel); }
    .tabs button {
      min-height: 0;
      padding: 6px 10px;
      border: 0;
      border-radius: 6px;
      background: transparent;
      color: var(--muted-2);
      font-family: var(--mono);
      font-size: 12px;
      cursor: pointer;
    }
    .tabs button:hover { background: var(--panel-hover); color: var(--muted-3); border: 0; }
    .tabs button[aria-selected="true"] { background: var(--bg); color: var(--fg); border: 1px solid var(--line); }
    .tab-panel[hidden] { display: none; }
    .raw-json { margin: 0; padding: 14px 16px; white-space: pre-wrap; overflow-wrap: anywhere; font-family: var(--mono); font-size: 12.5px; color: var(--muted-3); }
    .back-link { display: inline-flex; margin-bottom: 18px; color: var(--muted-3); border-color: var(--line-strong); }
    code { color: var(--muted-3); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
    /* Narrow screens: a 5-column table can't fit, so let the panel scroll the
       table horizontally rather than clipping the trailing columns. */
    @media (max-width: 760px) {
      h1 { font-size: 28px; }
      .panel:has(.store-table) { overflow-x: auto; }
      .store-table { min-width: 640px; }
      /* Keep chip groups on one line so every row settles to the same height
         (the Types/Status overflow is reachable via the horizontal scroll). */
      .store-table .chips { flex-wrap: nowrap; }
    }
  `;
}

function sortableStoreHeader(
  label: string,
  key: string,
  type: 'text' | 'number' = 'text',
  defaultDirection: 'asc' | 'desc' = type === 'number' ? 'desc' : 'asc'
): string {
  return `<th data-sort-key="${escapeHtml(key)}" data-sort-type="${type}" data-default-direction="${defaultDirection}"><button class="sort-header" type="button">${escapeHtml(label)}<span class="sort-indicator" aria-hidden="true"></span></button></th>`;
}

function sortableStoreTableScript(): string {
  return `
    document.querySelectorAll('table[data-sortable="true"]').forEach((table) => {
      const tbody = table.querySelector('tbody');
      if (!tbody) return;
      const headers = Array.from(table.querySelectorAll('th[data-sort-key]'));

      const valueFor = (row, key, type) => {
        const raw = row.getAttribute('data-sort-' + key) || '';
        if (type === 'number') {
          const parsed = Number(raw);
          return Number.isFinite(parsed) ? parsed : 0;
        }
        return raw.toLocaleLowerCase();
      };

      const updateHeaders = (activeHeader, direction) => {
        headers.forEach((header) => {
          if (header === activeHeader) {
            header.setAttribute('aria-sort', direction === 'asc' ? 'ascending' : 'descending');
          } else {
            header.removeAttribute('aria-sort');
          }
        });
      };

      const sortBy = (header, direction) => {
        const key = header.getAttribute('data-sort-key');
        const type = header.getAttribute('data-sort-type') || 'text';
        const rows = Array.from(tbody.querySelectorAll('tr'));
        rows.sort((a, b) => {
          const left = valueFor(a, key, type);
          const right = valueFor(b, key, type);
          const primary = type === 'number'
            ? left - right
            : String(left).localeCompare(String(right), undefined, { numeric: true, sensitivity: 'base' });
          if (primary !== 0) return direction === 'asc' ? primary : -primary;
          return Number(a.getAttribute('data-row-index') || 0) - Number(b.getAttribute('data-row-index') || 0);
        });
        rows.forEach((row) => tbody.appendChild(row));
        updateHeaders(header, direction);
      };

      headers.forEach((header) => {
        const button = header.querySelector('button');
        if (!button) return;
        button.addEventListener('click', () => {
          const isActive = header.hasAttribute('aria-sort');
          const current = header.getAttribute('aria-sort') === 'ascending' ? 'asc' : 'desc';
          const direction = isActive
            ? (current === 'asc' ? 'desc' : 'asc')
            : (header.getAttribute('data-default-direction') || 'asc');
          sortBy(header, direction);
        });
      });

      const defaultKey = table.getAttribute('data-default-sort-key');
      const defaultHeader = defaultKey
        ? headers.find((header) => header.getAttribute('data-sort-key') === defaultKey)
        : null;
      if (defaultHeader) sortBy(defaultHeader, table.getAttribute('data-default-sort-direction') || 'desc');
    });
  `;
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

/** Extra styles for the grouped agents view and the schedule timetable. */
function renderAgentsSchedulesStyles(): string {
  return `
    .group { margin-bottom: 26px; scroll-margin-top: 80px; }
    .group:target .group-title span:first-child { color: var(--cyan); }
    .group-title, .day-title {
      display: flex; align-items: baseline; gap: 10px;
      margin: 26px 0 12px;
      font-family: var(--sans);
      font-size: 14px;
      font-weight: 500;
      color: var(--fg);
    }
    .group-title::before, .day-title::before { content: "⋮"; color: var(--cyan); transform: translateY(1px); }
    .group-title .path { color: var(--muted-2); font-size: 12px; font-family: var(--mono); }
    .group-title .count, .day-title .count { color: var(--muted-2); font-size: 12px; font-family: var(--mono); }
    .group-title .rule, .day-title .rule { flex: 1; height: 1px; background: var(--line); }
    .day { margin-bottom: 22px; }
    .timetable {
      display: flex; flex-direction: column; gap: 1px;
      background: var(--line);
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
    }
    .slot {
      display: grid;
      grid-template-columns: 92px minmax(0, 1fr) auto;
      gap: 16px;
      align-items: center;
      background: var(--bg);
      padding: 12px 16px;
      transition: background 120ms ease;
    }
    .slot:hover { background: var(--panel-hover); }
    .slot.disabled .slot-time { color: var(--muted-2); }
    .slot-time {
      font-family: var(--mono);
      font-size: 17px;
      color: var(--cyan);
      font-variant-numeric: tabular-nums;
      white-space: nowrap;
    }
    .slot-main { min-width: 0; }
    .slot-agent { color: var(--fg); font-family: var(--sans); overflow-wrap: anywhere; }
    .slot-agent code { color: var(--fg); font-family: var(--mono); font-size: 13px; }
    .slot-proj { color: var(--cyan); font-size: 11px; letter-spacing: 0.04em; }
    .slot-cadence { color: var(--muted-3); font-size: 12px; margin-top: 3px; }
    .slot-cadence code { color: var(--muted-2); font-size: 11.5px; }
    .slot-side { text-align: right; color: var(--muted-2); font-size: 11.5px; white-space: nowrap; }
    .slot-side .ok { color: var(--green); }
    .slot-side .failed { color: var(--red); }
    @media (max-width: 640px) {
      .slot { grid-template-columns: 64px minmax(0, 1fr); }
      .slot-side { grid-column: 2; text-align: left; margin-top: 2px; }
    }
    /* One shared grid for the whole tree so the header and every row align to
       the same column tracks (subgrid), regardless of nesting depth or chip
       width. The two trailing columns size to the widest content across all
       rows, not per-row. */
    .tree {
      display: grid;
      grid-template-columns: minmax(0, 1.7fr) minmax(0, 1fr) auto auto;
      column-gap: 14px;
    }
    .tree-head, .tree-row {
      grid-column: 1 / -1;
      display: grid;
      grid-template-columns: subgrid;
    }
    .tree-head {
      align-items: center;
      color: var(--muted-2);
      font-size: 11px;
      letter-spacing: 0.12em;
      text-transform: uppercase;
      background: var(--panel);
      border-bottom: 1px solid var(--line);
    }
    .tree-head > span { padding: 8px 0; }
    .tree-row { align-items: stretch; min-height: 38px; border-bottom: 1px solid var(--line); transition: background 120ms ease; }
    .tree-row:last-child { border-bottom: 0; }
    .tree-row:hover { background: var(--panel-hover); }
    .tree-row > span { display: flex; align-items: center; min-width: 0; }
    .tree-row.dir { background: var(--panel); }
    .tree-row.dir:hover { background: var(--panel-hover); }
    .tree-row.dir .tree-path { grid-column: 1 / -1; }
    /* Edge insets live on the first/last cells, not the row, so they don't
       shift the subgrid tracks out of alignment. */
    .tree-head > span:first-child, .tree-path { padding-left: 14px; }
    .tree-head > span:last-child, .tree-row > span:last-child { padding-right: 14px; }
    .tree-path { font-family: var(--mono); font-size: 13px; color: var(--fg); }
    .tree-label { padding: 7px 0 7px 6px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
    .tree-row.dir .tree-label { color: var(--cyan); }
    /* CSS-drawn tree guides: fixed-width, full-row-height segments so the
       vertical connectors stay continuous and aligned across padded rows. */
    .guide { position: relative; flex: 0 0 22px; align-self: stretch; }
    .guide.v::before, .guide.elbow::before {
      content: ""; position: absolute; left: 11px; top: 0; bottom: 0; width: 1px; background: var(--muted-2);
    }
    .guide.elbow.last::before { bottom: auto; height: 50%; }
    .guide.elbow::after {
      content: ""; position: absolute; left: 11px; top: 50%; width: 11px; height: 1px; background: var(--muted-2);
    }
    .tree-row .tree-name { flex-direction: column; align-items: flex-start; justify-content: center; text-align: left; font-family: var(--sans); color: var(--muted-3); font-size: 13px; overflow-wrap: anywhere; padding: 7px 0; }
    .tree-desc { color: var(--muted-2); font-size: 11.5px; margin-top: 2px; }
    .tree-row .chip { white-space: nowrap; }
    /* Narrow screens: hide the Description, Model, and Schedule (cron) columns
       so only the tree and agent name remain, readable without a horizontal
       scroll. The collapsed columns drop the 600px min-width the desktop tree needs. */
    @media (max-width: 700px) {
      .tree-head { display: none; }
      .tree { grid-template-columns: minmax(0, 1.4fr) minmax(0, 1fr); column-gap: 10px; }
      .tree-desc { display: none; }
      .tree-row > span:nth-child(3),
      .tree-row > span:nth-child(4) { display: none; }
    }
    /* Parse-error badge + popover (collapses the old full-width error banner).
       A <details> disclosure anchors the panel directly under the badge. */
    .issues { position: relative; display: inline-block; margin-top: 12px; }
    .issues-badge {
      display: inline-flex; align-items: center; gap: 6px;
      padding: 4px 11px;
      border: 1px solid var(--amber-border);
      background: var(--amber-soft);
      color: var(--amber);
      border-radius: 999px;
      font-family: var(--mono);
      font-size: 12px;
      cursor: pointer;
      list-style: none;
      user-select: none;
    }
    .issues-badge::-webkit-details-marker { display: none; }
    .issues-badge::marker { content: ""; }
    .issues-badge:hover, .issues[open] .issues-badge { border-color: var(--amber); }
    .issues-popover {
      position: absolute; top: calc(100% + 6px); left: 0; z-index: 50;
      width: min(620px, calc(100vw - 32px));
      border: 1px solid var(--amber-border);
      background: var(--bg);
      color: var(--fg);
      border-radius: 12px;
      padding: 16px 18px;
      box-shadow: 0 16px 48px rgba(0,0,0,0.32);
    }
    .issues-popover h3 { margin: 0 0 10px; font-family: var(--sans); font-size: 13px; font-weight: 500; color: var(--amber); }
    .issues-popover ul { margin: 0; padding: 0; list-style: none; display: flex; flex-direction: column; gap: 10px; }
    .issues-popover li { font-size: 12.5px; }
    .issues-popover code { color: var(--fg); font-family: var(--mono); font-size: 12px; overflow-wrap: anywhere; }
    .issues-popover .msg { display: block; margin-top: 3px; color: var(--muted-3); }
  `;
}

interface AgentTreeNode {
  name: string;
  children: Map<string, AgentTreeNode>;
  agent?: AgentSummary;
}

/** Build a directory tree from agent paths within a single project. */
function buildAgentTree(agents: AgentSummary[]): AgentTreeNode {
  const root: AgentTreeNode = { name: '', children: new Map() };
  for (const agent of agents) {
    const parts = agent.path.split('/');
    let node = root;
    parts.forEach((part, i) => {
      let child = node.children.get(part);
      if (!child) {
        child = { name: part, children: new Map() };
        node.children.set(part, child);
      }
      if (i === parts.length - 1) child.agent = agent;
      node = child;
    });
  }
  return root;
}

/** Render an agent file tree as grid rows with CSS-drawn tree guides. */
function renderAgentTree(agents: AgentSummary[]): string {
  const root = buildAgentTree(agents);
  const rows: string[] = [];

  const sortChildren = (node: AgentTreeNode): AgentTreeNode[] =>
    [...node.children.values()].sort((a, b) => {
      const aDir = a.agent === undefined;
      const bDir = b.agent === undefined;
      if (aDir !== bDir) return aDir ? -1 : 1; // directories before files
      return a.name.localeCompare(b.name);
    });

  // `guides` tracks, per ancestor level, whether that level still has a
  // continuing sibling (and therefore a vertical line through this row).
  const guideHtml = (guides: boolean[], last: boolean): string =>
    guides.map((continues) => `<span class="guide${continues ? ' v' : ''}"></span>`).join('') +
    `<span class="guide elbow${last ? ' last' : ''}"></span>`;

  const walk = (node: AgentTreeNode, guides: boolean[]) => {
    const children = sortChildren(node);
    children.forEach((child, idx) => {
      const last = idx === children.length - 1;
      const prefix = guideHtml(guides, last);
      if (child.agent) {
        const a = child.agent;
        const scheduleCell = a.schedule
          ? `<span class="chip status">${escapeHtml(a.schedule)}</span>`
          : '<span class="muted">—</span>';
        // Deep-link the agent label to its run history. The session store keys
        // by computeAgentId (project-relative path minus the .agentuse suffix).
        const agentId = a.path.replace(/\.agentuse$/, '');
        const sessionsHref = `/sessions?agent=${encodeURIComponent(agentId)}`;
        rows.push(`<div class="tree-row">
          <span class="tree-path">${prefix}<a class="tree-label" href="${escapeHtml(sessionsHref)}">${escapeHtml(child.name)}</a></span>
          <span class="tree-name">${escapeHtml(a.name)}${a.description ? `<div class="tree-desc">${escapeHtml(a.description)}</div>` : ''}</span>
          <span><span class="chip">${escapeHtml(a.model)}</span></span>
          <span>${scheduleCell}</span>
        </div>`);
      } else {
        rows.push(`<div class="tree-row dir">
          <span class="tree-path">${prefix}<span class="tree-label">${escapeHtml(child.name)}/</span></span>
        </div>`);
        walk(child, [...guides, !last]);
      }
    });
  };

  walk(root, []);
  return rows.join('');
}

/**
 * Fragment id for a project's section on the agents page, so the dashboard
 * project rows can deep-link straight to that group. Shared by renderHomePage
 * (the link) and renderAgentsPage (the anchor) so the two never drift.
 */
function projectAnchor(projectId: string): string {
  return `project-${projectId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** Dashboard-specific styles: the nav-card grid and the project list. */
function renderHomeStyles(): string {
  return `
    .cards {
      display: grid;
      grid-template-columns: repeat(auto-fill, minmax(240px, 1fr));
      gap: 12px;
      margin-bottom: 32px;
    }
    .card {
      display: flex;
      flex-direction: column;
      gap: 6px;
      padding: 18px 18px 16px;
      border: 1px solid var(--line);
      border-radius: 12px;
      background: var(--panel);
      text-decoration: none;
      transition: background 120ms ease, border-color 120ms ease;
    }
    .card:hover { background: var(--panel-hover); border-color: var(--line-strong); }
    .card-top { display: flex; align-items: baseline; justify-content: space-between; gap: 10px; }
    .card-title { font-family: var(--sans); font-size: 16px; font-weight: 500; color: var(--fg); }
    .card-count { font-family: var(--mono); font-size: 12px; color: var(--cyan); white-space: nowrap; }
    .card-desc { color: var(--muted-3); font-size: 12.5px; line-height: 1.4; }
    .proj { display: grid; grid-template-columns: minmax(0, 1fr) auto; gap: 8px 16px; align-items: center; padding: 13px 16px; border-bottom: 1px solid var(--line); }
    a.proj { color: inherit; text-decoration: none; border-bottom: 1px solid var(--line); transition: background 120ms ease; }
    a.proj:hover { background: var(--panel-hover); }
    .proj:last-child, a.proj:last-child { border-bottom: 0; }
    .proj-counts .proj-go { color: var(--muted-2); margin-left: 8px; }
    .proj-id { font-family: var(--sans); font-size: 14px; color: var(--fg); display: inline-flex; align-items: center; gap: 8px; }
    .proj-default { font-family: var(--mono); font-size: 10px; letter-spacing: 0.08em; text-transform: uppercase; color: var(--cyan); border: 1px solid var(--cyan-border); border-radius: 999px; padding: 1px 7px; }
    .proj-path { font-family: var(--mono); font-size: 11.5px; color: var(--muted-2); overflow-wrap: anywhere; margin-top: 2px; }
    .proj-counts { font-family: var(--mono); font-size: 12px; color: var(--muted-3); white-space: nowrap; text-align: right; }
    .api-hint { margin-top: 28px; color: var(--muted-2); font-size: 12px; }
    .api-hint code { color: var(--muted-3); }
  `;
}

function renderHomePage(options: {
  version: string;
  defaultProject: string | null;
  projects: Array<{ id: string; path: string; scope?: string; agentCount: number; scheduleCount: number }>;
  multiProject: boolean;
}): string {
  const totalAgents = options.projects.reduce((sum, p) => sum + p.agentCount, 0);
  const totalSchedules = options.projects.reduce((sum, p) => sum + p.scheduleCount, 0);
  const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

  const card = (href: string, title: string, desc: string, count?: string): string => `
    <a class="card" href="${href}">
      <div class="card-top"><span class="card-title">${title}</span>${count ? `<span class="card-count">${count}</span>` : ''}</div>
      <div class="card-desc">${desc}</div>
    </a>`;

  const cards = [
    card('/agents', 'Agents', 'Browse the agents loaded by this daemon.', plural(totalAgents, 'agent')),
    card('/sessions', 'Sessions', 'Run logs and approvals for every run.'),
    card('/schedules', 'Schedules', 'Upcoming and recent scheduled runs.', plural(totalSchedules, 'run')),
    card('/stores', 'Stores', 'Key-value data written by agents.'),
    card('/approvals', 'Approvals', 'Tool calls awaiting a decision.'),
  ].join('');

  const projects = options.projects.map((p) => `
    <a class="proj" href="/agents#${projectAnchor(p.id)}">
      <div>
        <div class="proj-id">${escapeHtml(p.id)}${p.id === options.defaultProject ? '<span class="proj-default">default</span>' : ''}</div>
        <div class="proj-path">${escapeHtml(p.path)}${p.scope && p.scope !== p.path ? ` · scope ${escapeHtml(p.scope)}` : ''}</div>
      </div>
      <div class="proj-counts">${p.agentCount} agent${p.agentCount === 1 ? '' : 's'} · ${p.scheduleCount} schedule${p.scheduleCount === 1 ? '' : 's'}<span class="proj-go" aria-hidden="true">›</span></div>
    </a>`).join('');

  const projectCount = options.projects.length;
  const lede = options.multiProject
    ? `${plural(projectCount, 'project')} · ${plural(totalAgents, 'agent')} · ${plural(totalSchedules, 'scheduled run')}.`
    : `${plural(totalAgents, 'agent')} · ${plural(totalSchedules, 'scheduled run')} in this serve daemon.`;

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>AgentUse</title>
  <script>${approvalThemeBootScript()}</script>
  <style>${approvalListThemeStyles()}${renderStoreStyles()}${renderAgentsSchedulesStyles()}${renderHomeStyles()}</style>
</head>
<body>
  ${approvalsTopbarMarkup({ right: approvalsThemeToggleHtml() })}
  <main>
    <header>
      <div class="eyebrow">serve daemon</div>
      <h1>AgentUse</h1>
      <p class="lede">${lede}</p>
    </header>
    <div class="cards">${cards}</div>
    <section class="group">
      <h2 class="group-title"><span>Projects</span><span class="count">${projectCount}</span><span class="rule"></span></h2>
      <div class="panel">${projects || '<div class="empty">No projects loaded.</div>'}</div>
    </section>
    <p class="api-hint">Programmatic clients: server info JSON at <code>/api</code>, JSON twins at <code>/api/agents</code>, <code>/api/sessions</code>, <code>/api/schedules</code>. v${escapeHtml(options.version)}</p>
  </main>
  <script>${approvalsThemeToggleScript()}</script>
</body>
</html>`;
}

function renderAgentsPage(options: {
  agents: AgentSummary[];
  errors: Array<{ projectId: string; path: string; message: string }>;
  multiProject: boolean;
}): string {
  // Preserve the input order (sorted by project, then path) when grouping.
  const byProject = new Map<string, AgentSummary[]>();
  for (const agent of options.agents) {
    const list = byProject.get(agent.projectId);
    if (list) list.push(agent);
    else byProject.set(agent.projectId, [agent]);
  }

  const groups = [...byProject.entries()].map(([projectId, agents]) => `
    <section class="group" id="${projectAnchor(projectId)}">
      <h2 class="group-title"><span>${escapeHtml(projectId)}</span><span class="count">${agents.length} agent${agents.length === 1 ? '' : 's'}</span><span class="rule"></span></h2>
      <div class="panel">
        <div class="tree">
          <div class="tree-head"><span>Tree</span><span>Name</span><span>Model</span><span>Schedule</span></div>
          ${renderAgentTree(agents)}
        </div>
      </div>
    </section>`).join('');

  // Parse failures collapse into a small badge that opens a popover, rather
  // than a full-width banner pushing the agent list down.
  const issues = options.errors.length > 0
    ? `<details class="issues">
        <summary class="issues-badge">⚠ ${options.errors.length} failed to parse</summary>
        <div class="issues-popover">
          <h3>${options.errors.length} agent${options.errors.length === 1 ? '' : 's'} failed to parse</h3>
          <ul>${options.errors.map((err) => `<li><code>${escapeHtml(err.projectId)}/${escapeHtml(err.path)}</code><span class="msg">${escapeHtml(err.message.split('\n')[0])}</span></li>`).join('')}</ul>
        </div>
      </details>`
    : '';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>AgentUse Agents</title>
  <meta http-equiv="refresh" content="30">
  <script>${approvalThemeBootScript()}</script>
  <style>${approvalListThemeStyles()}${renderStoreStyles()}${renderAgentsSchedulesStyles()}</style>
</head>
<body>
  ${approvalsTopbarMarkup({ currentPage: 'agents', right: approvalsThemeToggleHtml() })}
  <main>
    <header>
      <div class="eyebrow">loaded agents</div>
      <h1>Agents</h1>
      <p class="lede">${options.agents.length} agent${options.agents.length === 1 ? '' : 's'} across ${byProject.size} project${byProject.size === 1 ? '' : 's'} in this serve daemon.</p>
      ${issues}
    </header>
    ${groups || '<div class="panel"><div class="empty">No agents loaded by this serve daemon.</div></div>'}
  </main>
  <script>${approvalsThemeToggleScript()}</script>
</body>
</html>`;
}

function renderSchedulesPage(options: {
  schedules: SerializedSchedule[];
  multiProject: boolean;
  sessionToken?: (sessionId: string) => string;
}): string {
  // Group the (already next-run-sorted) schedules into day buckets, with
  // disabled schedules (no next run) collected at the end.
  const dayLabel = (ms: number) => new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' });
  const timeLabel = (ms: number) => new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });

  const days = new Map<string, SerializedSchedule[]>();
  const disabled: SerializedSchedule[] = [];
  for (const schedule of options.schedules) {
    if (!schedule.nextRun) {
      disabled.push(schedule);
      continue;
    }
    const label = dayLabel(Date.parse(schedule.nextRun));
    const list = days.get(label);
    if (list) list.push(schedule);
    else days.set(label, [schedule]);
  }

  const renderSlot = (schedule: SerializedSchedule): string => {
    const ms = schedule.nextRun ? Date.parse(schedule.nextRun) : NaN;
    const time = Number.isFinite(ms) ? escapeHtml(timeLabel(ms)) : '—';
    const proj = options.multiProject ? `<div class="slot-proj">${escapeHtml(schedule.projectId)}</div>` : '';
    // Exact cron + stagger live in a tooltip, not the row: the human cadence
    // already conveys the schedule, and stagger is operational trivia.
    const staggerNote = schedule.jitterMs > 0 ? ` · stagger +${Math.round(schedule.jitterMs / 1000)}s` : '';
    const cadenceTitle = escapeHtml(`${schedule.expression}${staggerNote}`);
    // Only surface last-run once it has actually run (the in-memory state
    // resets on daemon restart, so "never run" would otherwise dominate).
    // When the run recorded a session, the badge deep-links into its log.
    const lastRunSessionId = schedule.lastResult?.sessionId;
    const lastRunBadge = schedule.lastResult
      ? `<span class="${schedule.lastResult.success ? 'ok' : 'failed'}">ran ${schedule.lastResult.success ? 'ok' : 'failed'}</span> ${escapeHtml(formatApprovalTime(Date.parse(schedule.lastRun!)))}`
      : `ran ${escapeHtml(formatApprovalTime(Date.parse(schedule.lastRun!)))}`;
    const lastRun = schedule.lastRun
      ? lastRunSessionId
        ? `<a href="${escapeHtml(`/sessions/${encodeURIComponent(lastRunSessionId)}${(() => { const t = options.sessionToken?.(lastRunSessionId); return t ? `?token=${encodeURIComponent(t)}` : ''; })()}`)}">${lastRunBadge}</a>`
        : lastRunBadge
      : '';
    return `<div class="slot${schedule.nextRun ? '' : ' disabled'}">
      <div class="slot-time">${time}</div>
      <div class="slot-main">
        ${proj}
        <div class="slot-agent"><code>${escapeHtml(schedule.agentPath)}</code></div>
        <div class="slot-cadence" title="${cadenceTitle}">${escapeHtml(schedule.human)}</div>
      </div>
      <div class="slot-side">${lastRun}</div>
    </div>`;
  };

  const renderDay = (label: string, schedules: SerializedSchedule[]): string => `
    <section class="day">
      <h2 class="day-title"><span>${escapeHtml(label)}</span><span class="count">${schedules.length}</span><span class="rule"></span></h2>
      <div class="timetable">${schedules.map(renderSlot).join('')}</div>
    </section>`;

  const dayMarkup = [...days.entries()].map(([label, schedules]) => renderDay(label, schedules)).join('');
  const disabledMarkup = disabled.length > 0 ? renderDay('Disabled', disabled) : '';
  const body = dayMarkup || disabledMarkup
    ? `${dayMarkup}${disabledMarkup}`
    : '<div class="panel"><div class="empty">No scheduled agents. Add a <code>schedule:</code> field to an agent file.</div></div>';

  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>AgentUse Schedules</title>
  <meta http-equiv="refresh" content="30">
  <script>${approvalThemeBootScript()}</script>
  <style>${approvalListThemeStyles()}${renderStoreStyles()}${renderAgentsSchedulesStyles()}</style>
</head>
<body>
  ${approvalsTopbarMarkup({ currentPage: 'schedules', right: approvalsThemeToggleHtml() })}
  <main>
    <header>
      <div class="eyebrow">scheduled agents</div>
      <h1>Schedules</h1>
      <p class="lede">${options.schedules.length} scheduled agent${options.schedules.length === 1 ? '' : 's'}, upcoming runs first.</p>
    </header>
    ${body}
  </main>
  <script>${approvalsThemeToggleScript()}</script>
</body>
</html>`;
}

function renderStoresIndexPage(options: {
  stores: StoreBrowserSummary[];
  errors: Array<{ projectId: string; storeName?: string; message: string }>;
  multiProject: boolean;
}): string {
  const sortedStores = [...options.stores].sort(compareStoreBrowserSummaries);
  const rows = sortedStores.map((store, index) => {
    const params = new URLSearchParams();
    if (options.multiProject) params.set('project', store.projectId);
    const href = `/stores/${encodeURIComponent(store.name)}${params.toString() ? `?${params.toString()}` : ''}`;
    const sortAttrs = [
      `data-row-index="${index}"`,
      `data-sort-store="${escapeHtml(store.name)}"`,
      `data-sort-items="${store.itemCount}"`,
      `data-sort-updated="${store.updatedAt ?? 0}"`,
      `data-sort-types="${escapeHtml(store.types.join(' '))}"`,
      `data-sort-status="${escapeHtml(store.statuses.join(' '))}"`
    ].join(' ');
    return `<tr ${sortAttrs}>
      <td class="title-cell"><a href="${escapeHtml(href)}">${escapeHtml(store.name)}</a>${options.multiProject ? `<span class="muted">${escapeHtml(store.projectId)}</span>` : ''}</td>
      <td>${store.itemCount}</td>
      <td>${store.updatedAt ? escapeHtml(formatApprovalTime(store.updatedAt)) : '<span class="muted">never</span>'}</td>
      <td><span class="chips">${store.types.slice(0, 6).map((type) => `<span class="chip">${escapeHtml(type)}</span>`).join('') || '<span class="muted">none</span>'}</span></td>
      <td><span class="chips">${store.statuses.slice(0, 6).map((status) => `<span class="chip status">${escapeHtml(status)}</span>`).join('') || '<span class="muted">none</span>'}</span></td>
    </tr>`;
  }).join('');
  const errors = options.errors.length > 0
    ? `<div class="errors">${options.errors.map((err) => `${escapeHtml(err.projectId)}${err.storeName ? `/${escapeHtml(err.storeName)}` : ''}: ${escapeHtml(err.message)}`).join('<br>')}</div>`
    : '';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>AgentUse Stores</title>
  <script>${approvalThemeBootScript()}</script>
  <style>${approvalListThemeStyles()}${renderStoreStyles()}</style>
</head>
<body>
  ${approvalsTopbarMarkup({ currentPage: 'stores', right: approvalsThemeToggleHtml() })}
  <main>
    <header>
      <div class="eyebrow">shared state</div>
      <h1>Stores</h1>
      <p class="lede">Browse persistent state that agents can share across runs.</p>
    </header>
    ${errors}
    <div class="panel">
      ${rows ? `<table class="store-table" data-sortable="true" data-default-sort-key="updated" data-default-sort-direction="desc">
        <thead><tr>${sortableStoreHeader('Store', 'store')}${sortableStoreHeader('Items', 'items', 'number')}${sortableStoreHeader('Updated', 'updated', 'number')}${sortableStoreHeader('Types', 'types')}${sortableStoreHeader('Status', 'status')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">No stores found for this serve daemon.</div>'}
    </div>
  </main>
  <script>${approvalsThemeToggleScript()}${sortableStoreTableScript()}</script>
</body>
</html>`;
}

function renderStoreItemsPage(options: {
  storeName: string;
  rows: StoreBrowserRows[];
  errors: Array<{ projectId: string; message: string }>;
  highlight?: string;
  multiProject: boolean;
}): string {
  const allRows = options.rows
    .flatMap((group) => group.items.map((item) => ({ projectId: group.projectId, item })))
    .sort((a, b) => (Date.parse(b.item.updatedAt) || 0) - (Date.parse(a.item.updatedAt) || 0)
      || storeItemTitle(a.item).localeCompare(storeItemTitle(b.item))
      || a.projectId.localeCompare(b.projectId));
  const rows = allRows.map(({ projectId, item }, index) => {
    const highlighted = options.highlight && item.id === options.highlight;
    const params = new URLSearchParams();
    if (options.multiProject) params.set('project', projectId);
    const href = `/stores/${encodeURIComponent(options.storeName)}/${encodeURIComponent(item.id)}${params.toString() ? `?${params.toString()}` : ''}`;
    const sortAttrs = [
      `data-row-index="${index}"`,
      `data-sort-item="${escapeHtml(storeItemTitle(item))}"`,
      `data-sort-status="${escapeHtml(`${item.status ?? ''} ${item.type ?? ''}`)}"`,
      `data-sort-updated="${Date.parse(item.updatedAt) || 0}"`,
      `data-sort-created-by="${escapeHtml(item.createdBy ?? '')}"`,
      `data-sort-id="${escapeHtml(item.id)}"`
    ].join(' ');
    return `<tr id="store-item-${escapeHtml(item.id)}" class="clickable${highlighted ? ' highlighted' : ''}" data-store-item-id="${escapeHtml(item.id)}" data-href="${escapeHtml(href)}" ${sortAttrs}>
      <td class="title-cell">
        <a href="${escapeHtml(href)}">${escapeHtml(storeItemTitle(item))}</a>
        <span class="preview">${escapeHtml(storeItemPreview(item))}</span>
      </td>
      <td><span class="chips">${item.status ? `<span class="chip status">${escapeHtml(item.status)}</span>` : ''}${item.type ? `<span class="chip">${escapeHtml(item.type)}</span>` : ''}</span></td>
      <td>${escapeHtml(formatApprovalTime(Date.parse(item.updatedAt)))}</td>
      <td>${item.createdBy ? escapeHtml(item.createdBy) : '<span class="muted">unknown</span>'}</td>
      <td><code>${escapeHtml(item.id)}</code>${options.multiProject ? `<div class="muted">${escapeHtml(projectId)}</div>` : ''}</td>
    </tr>`;
  }).join('');
  const errors = options.errors.length > 0
    ? `<div class="errors">${options.errors.map((err) => `${escapeHtml(err.projectId)}: ${escapeHtml(err.message)}`).join('<br>')}</div>`
    : '';
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>AgentUse Store - ${escapeHtml(options.storeName)}</title>
  <script>${approvalThemeBootScript()}</script>
  <style>${approvalListThemeStyles()}${renderStoreStyles()}</style>
</head>
<body>
  ${approvalsTopbarMarkup({ currentPage: 'stores', right: `<span class="session-pill">store <code>${escapeHtml(options.storeName)}</code></span>${approvalsThemeToggleHtml()}` })}
  <main>
    <header>
      <div class="eyebrow">store table</div>
      <h1>${escapeHtml(options.storeName)}</h1>
      <p class="lede">${allRows.length} item${allRows.length === 1 ? '' : 's'} visible in this serve daemon.</p>
    </header>
    ${errors}
    <div class="panel">
      ${rows ? `<table class="store-table" data-sortable="true" data-default-sort-key="updated" data-default-sort-direction="desc">
        <thead><tr>${sortableStoreHeader('Item', 'item')}${sortableStoreHeader('Status / type', 'status')}${sortableStoreHeader('Updated', 'updated', 'number')}${sortableStoreHeader('Created by', 'created-by')}${sortableStoreHeader('ID', 'id')}</tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">No items found in this store.</div>'}
    </div>
  </main>
  <script>
    ${approvalsThemeToggleScript()}
    ${sortableStoreTableScript()}
    const highlight = ${JSON.stringify(options.highlight ?? null)};
    if (highlight && window.CSS && CSS.escape) {
      const row = document.querySelector('[data-store-item-id="' + CSS.escape(highlight) + '"]');
      if (row) requestAnimationFrame(() => row.scrollIntoView({ block: 'center' }));
    }
    document.addEventListener('click', (event) => {
      const link = event.target instanceof Element ? event.target.closest('a') : null;
      if (link) return;
      const row = event.target instanceof Element ? event.target.closest('tr[data-href]') : null;
      const href = row && row.getAttribute('data-href');
      if (href) location.href = href;
    });
  </script>
</body>
</html>`;
}

function renderStoreDataValue(value: unknown): string {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return `<code>${escapeHtml(JSON.stringify(value))}</code>`;
  }
  if (typeof value === 'string') {
    return escapeHtml(value);
  }
  return `<pre>${escapeHtml(JSON.stringify(value, null, 2))}</pre>`;
}

function renderStoreItemDetailPage(options: {
  storeName: string;
  projectId?: string;
  item: StoreItem;
}): string {
  const { item } = options;
  const backParams = new URLSearchParams();
  if (options.projectId) backParams.set('project', options.projectId);
  backParams.set('highlight', item.id);
  const backHref = `/stores/${encodeURIComponent(options.storeName)}?${backParams.toString()}`;
  const dataEntries = Object.entries(valueAsRecord(item.data));
  const dataRows = dataEntries.length > 0
    ? dataEntries.map(([key, value]) => `<div class="data-field">
        <span class="data-key">${escapeHtml(key)}</span>
        <div class="data-value">${renderStoreDataValue(value)}</div>
      </div>`).join('')
    : '<div class="empty">No item data.</div>';
  const tagChips = item.tags?.map((tag) => `<span class="chip">${escapeHtml(tag)}</span>`).join('') ?? '';
  const rawJson = JSON.stringify(item, null, 2);
  return `<!doctype html>
<html>
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>AgentUse Store Item - ${escapeHtml(storeItemTitle(item))}</title>
  <script>${approvalThemeBootScript()}</script>
  <style>${approvalListThemeStyles()}${renderStoreStyles()}</style>
</head>
<body>
  ${approvalsTopbarMarkup({ currentPage: 'stores', right: `<span class="session-pill">store <code>${escapeHtml(options.storeName)}</code></span>${approvalsThemeToggleHtml()}` })}
  <main>
    <a class="back-link" href="${escapeHtml(backHref)}">Back to store table</a>
    <header>
      <div class="eyebrow">store item</div>
      <h1>${escapeHtml(storeItemTitle(item))}</h1>
      <p class="lede">${escapeHtml(storeItemPreview(item, 260))}</p>
    </header>
    <div class="tabs" role="tablist" aria-label="Store item views">
      <button type="button" role="tab" id="tab-table" aria-controls="panel-table" aria-selected="true" data-tab="table">Table</button>
      <button type="button" role="tab" id="tab-json" aria-controls="panel-json" aria-selected="false" data-tab="json">Raw JSON</button>
    </div>
    <section id="panel-table" class="tab-panel" role="tabpanel" aria-labelledby="tab-table">
      <div class="detail-grid">
        <div class="detail-cell"><span class="detail-label">id</span><code>${escapeHtml(item.id)}</code></div>
        <div class="detail-cell"><span class="detail-label">type</span>${item.type ? escapeHtml(item.type) : '<span class="muted">none</span>'}</div>
        <div class="detail-cell"><span class="detail-label">status</span>${item.status ? `<span class="chip status">${escapeHtml(item.status)}</span>` : '<span class="muted">none</span>'}</div>
        <div class="detail-cell"><span class="detail-label">created by</span>${item.createdBy ? escapeHtml(item.createdBy) : '<span class="muted">unknown</span>'}</div>
        <div class="detail-cell"><span class="detail-label">created</span>${escapeHtml(formatApprovalTime(Date.parse(item.createdAt)))}</div>
        <div class="detail-cell"><span class="detail-label">updated</span>${escapeHtml(formatApprovalTime(Date.parse(item.updatedAt)))}</div>
        ${item.parentId ? `<div class="detail-cell"><span class="detail-label">parent</span><code>${escapeHtml(item.parentId)}</code></div>` : ''}
        ${tagChips ? `<div class="detail-cell"><span class="detail-label">tags</span><span class="chips">${tagChips}</span></div>` : ''}
      </div>
      <div class="panel">
        <div class="data-grid">${dataRows}</div>
      </div>
    </section>
    <section id="panel-json" class="tab-panel panel" role="tabpanel" aria-labelledby="tab-json" hidden>
      <pre class="raw-json"><code>${escapeHtml(rawJson)}</code></pre>
    </section>
  </main>
  <script>
    ${approvalsThemeToggleScript()}
    const tabButtons = Array.from(document.querySelectorAll('[data-tab]'));
    const panels = {
      table: document.getElementById('panel-table'),
      json: document.getElementById('panel-json')
    };
    function selectStoreTab(name) {
      for (const button of tabButtons) {
        const selected = button.dataset.tab === name;
        button.setAttribute('aria-selected', String(selected));
      }
      for (const [key, panel] of Object.entries(panels)) {
        if (panel) panel.hidden = key !== name;
      }
    }
    for (const button of tabButtons) {
      button.addEventListener('click', () => selectStoreTab(button.dataset.tab || 'table'));
    }
  </script>
</body>
</html>`;
}

function renderApprovalsListPage(options: {
  buckets: {
    pending: Array<{ projectId: string; multiProject: boolean; approval: ApprovalSummary }>;
    completed: Array<{ projectId: string; multiProject: boolean; approval: ApprovalSummary }>;
    expired: Array<{ projectId: string; multiProject: boolean; approval: ApprovalSummary }>;
  };
  errors: Array<{ projectId: string; message: string }>;
  multiProject: boolean;
}): string {
  const { buckets, errors } = options;
  const totalPending = buckets.pending.length;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>AgentUse / Approvals</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
  <script>${approvalThemeBootScript()}</script>
  <meta http-equiv="refresh" content="10">
  <style>
    ${approvalListThemeStyles()}
    * { box-sizing: border-box; }
    html, body { background: var(--bg); }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--fg);
      font-family: var(--mono);
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
      background:
        radial-gradient(1200px 600px at 50% -200px, var(--glow-1), transparent 60%),
        radial-gradient(800px 400px at 100% 100%, var(--glow-2), transparent 60%),
        var(--bg);
    }
    a { color: inherit; text-decoration: none; }
    ${approvalsTopbarStyles()}
    main { width: min(1080px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 48px; }
    h1 {
      font-family: var(--sans);
      font-size: clamp(24px, 3vw, 34px);
      letter-spacing: -0.02em;
      margin: 0 0 24px;
      font-weight: 500;
    }
    .section-title {
      display: flex; align-items: baseline; gap: 10px;
      margin: 32px 0 12px;
      font-size: 11px;
      letter-spacing: 0.18em; text-transform: uppercase;
      color: var(--muted-2);
      font-weight: 500;
    }
    .section-title::before { content: "⋮"; color: var(--cyan); font-size: 14px; transform: translateY(1px); }
    .section-title .count { color: var(--muted-3); font-size: 12px; }
    .section-title .rule { flex: 1; height: 1px; background: var(--line); }
    ${approvalsListRowStyles()}
    .errors {
      margin: 16px 0 0;
      padding: 12px 14px;
      border: 1px solid var(--red-border);
      background: var(--red-soft);
      border-radius: 10px;
      color: var(--red);
      font-size: 12.5px;
    }
    .errors ul { margin: 6px 0 0; padding-left: 20px; }
    footer { color: var(--muted-2); font-size: 11px; margin-top: 32px; text-align: center; }
  </style>
</head>
<body>
  ${approvalsTopbarMarkup({
    isCurrentPage: true,
    right: `<span class="pending-count">${totalPending} pending</span>${approvalsThemeToggleHtml()}`
  })}
  <main>
    <h1>Approvals</h1>
    ${errors.length > 0 ? `
      <div class="errors">
        Some projects failed to load:
        <ul>${errors.map((e) => `<li>${escapeHtml(e.projectId)}: ${escapeHtml(e.message)}</li>`).join('')}</ul>
      </div>
    ` : ''}
    ${renderApprovalBucket('Pending', buckets.pending, 'No approvals waiting.')}
    ${renderApprovalBucket('Completed', buckets.completed, 'No completed approvals yet.')}
    ${renderApprovalBucket('Expired / Errored', buckets.expired, 'Nothing has expired or errored.')}
    <footer>auto-refreshes every 10s</footer>
  </main>
  <script>${approvalsThemeToggleScript()}</script>
</body>
</html>`;
}

function renderSessionStatusChipClass(status: string): string {
  if (status === 'suspended') return 'pending';
  if (status === 'completed') return 'approved';
  if (status === 'running') return 'pending';
  if (status === 'error') return 'errored';
  return '';
}

function renderChildSessionStatus(child: ChildSessionSummary): string {
  if (child.status === 'error' && child.errorCode === 'USER_STOPPED') return 'stopped';
  if (child.status === 'error' && child.errorCode === 'TIMEOUT') return 'timeout';
  return child.status;
}

function renderSessionRow(row: {
  projectId: string;
  multiProject: boolean;
  session: SessionSummary;
  token: string;
}): string {
  const { session, projectId, token } = row;
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  const query = params.toString();
  const href = `/sessions/${encodeURIComponent(session.sessionId)}${query ? `?${query}` : ''}`;

  // Primary identity: the agent's display name, falling back to its filename.
  // The locator below carries the full project/path/filename for disambiguation.
  const fileName = session.agent.id.split('/').pop() || session.agent.id;
  const agentName = session.agent.name || fileName;
  // project-name / project-relative-path/filename.agentuse. agent.id is the path
  // minus the suffix, so re-add it for the canonical run locator.
  const locator = `${projectId}/${session.agent.id}.agentuse`;
  const timeLabel = `started ${formatApprovalTime(session.createdAt)}`;
  const description = session.agent.description
    ? (session.agent.description.length > 200 ? `${session.agent.description.slice(0, 200)}…` : session.agent.description)
    : '';
  const errorLabel = session.errorMessage || '';

  const inner = `
    <div class="row-head">
      <span class="chip status ${renderSessionStatusChipClass(session.status)}">${escapeHtml(session.status)}</span>
      <span class="chip">${escapeHtml(session.trigger)}</span>
      <span class="row-time">${escapeHtml(timeLabel)}</span>
    </div>
    <div class="row-title">${escapeHtml(agentName)}</div>
    <div class="row-locator"><code>${escapeHtml(locator)}</code></div>
    ${description ? `<div class="row-desc">${escapeHtml(description)}</div>` : ''}
    ${errorLabel ? `<div class="row-decision">${escapeHtml(errorLabel)}</div>` : ''}
    <div class="row-meta"><code>${escapeHtml(session.sessionId)}</code></div>
  `;
  return `<a class="row" href="${escapeHtml(href)}">${inner}</a>`;
}

function renderSessionsListPage(options: {
  rows: Array<{ projectId: string; multiProject: boolean; session: SessionSummary }>;
  errors: Array<{ projectId: string; message: string }>;
  multiProject: boolean;
  agentFilter?: string;
  triggerFilter?: SessionTrigger;
  sessionToken: (sessionId: string) => string;
}): string {
  const { rows, errors, agentFilter, triggerFilter, sessionToken } = options;
  const activeFilters = [
    agentFilter ? `agent <code>${escapeHtml(agentFilter)}</code>` : '',
    triggerFilter ? `trigger <code>${escapeHtml(triggerFilter)}</code>` : '',
  ].filter(Boolean).join(' · ');

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>AgentUse / Sessions</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
  <script>${approvalThemeBootScript()}</script>
  <meta http-equiv="refresh" content="10">
  <style>
    ${approvalListThemeStyles()}
    * { box-sizing: border-box; }
    html, body { background: var(--bg); }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--fg);
      font-family: var(--mono);
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
      background:
        radial-gradient(1200px 600px at 50% -200px, var(--glow-1), transparent 60%),
        radial-gradient(800px 400px at 100% 100%, var(--glow-2), transparent 60%),
        var(--bg);
    }
    a { color: inherit; text-decoration: none; }
    ${approvalsTopbarStyles()}
    main { width: min(1080px, calc(100vw - 32px)); margin: 0 auto; padding: 32px 0 48px; }
    h1 { font-family: var(--sans); font-size: clamp(24px, 3vw, 34px); letter-spacing: -0.02em; margin: 0 0 8px; font-weight: 500; }
    .filters { color: var(--muted-2); font-size: 12px; margin: 0 0 24px; }
    .filters code { color: var(--muted-3); }
    .filters a { color: var(--cyan); }
    ${approvalsListRowStyles()}
    .errors { margin: 16px 0 0; padding: 12px 14px; border: 1px solid var(--red-border); background: var(--red-soft); border-radius: 10px; color: var(--red); font-size: 12.5px; }
    .errors ul { margin: 6px 0 0; padding-left: 20px; }
    footer { color: var(--muted-2); font-size: 11px; margin-top: 32px; text-align: center; }
  </style>
</head>
<body>
  ${approvalsTopbarMarkup({
    currentPage: 'sessions',
    right: `<span class="session-pill">${rows.length} sessions</span>${approvalsThemeToggleHtml()}`
  })}
  <main>
    <h1>Sessions</h1>
    ${activeFilters ? `<p class="filters">${activeFilters} · <a href="/sessions">clear</a></p>` : ''}
    ${errors.length > 0 ? `
      <div class="errors">
        Some projects failed to load:
        <ul>${errors.map((e) => `<li>${escapeHtml(e.projectId)}: ${escapeHtml(e.message)}</li>`).join('')}</ul>
      </div>
    ` : ''}
    <div class="rows">
      ${rows.length > 0
        ? rows.map((row) => renderSessionRow({ ...row, token: sessionToken(row.session.sessionId) })).join('')
        : '<div class="empty">No sessions yet.</div>'}
    </div>
    <footer>auto-refreshes every 10s</footer>
  </main>
  <script>${approvalsThemeToggleScript()}</script>
</body>
</html>`;
}

function isEndedSessionStatus(status: string | undefined): boolean {
  return status === 'completed' || status === 'error';
}

/**
 * Whether a request bypasses the global `Authorization: Bearer` header gate.
 *
 * Exempt: any `/approvals/*` route (legacy, token-authenticated) and, only on
 * the non-API surface, the unified session page `/sessions/:id` plus its action
 * subroutes `/sessions/:id/{decision,continue,status,stop}`. These carry their own
 * capability auth (session token / api key / local).
 *
 * NOT exempt (stays header-gated): `/sessions` (the list page), and every
 * `/api/*` route including `/api/sessions` and `/api/sessions/:id`. The `isApi`
 * qualifier on the session branch is the security boundary that keeps the JSON
 * session endpoints authenticated on an exposed host.
 */
function isHeaderGateExemptRoute(routePath: string, isApi: boolean): boolean {
  if (routePath.startsWith('/approvals/')) return true;
  if (isApi) return false;
  return /^\/sessions\/[^/?#]+(?:\/(?:decision|continue|status|stop))?$/.test(routePath);
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

function approvalSessionErrorText(approval: Pick<ApprovalPageInfo, 'sessionStatus' | 'errorCode' | 'errorMessage'>): string {
  if (approval.sessionStatus !== 'error') return '';
  if (approval.errorCode === 'USER_STOPPED') {
    return approval.errorMessage || 'Session stopped by user.';
  }
  if (approval.errorCode === 'TIMEOUT') {
    return approval.errorMessage || 'Session timed out.';
  }
  if (!approval.errorCode && !approval.errorMessage) {
    return 'Session finished with an error. Check the session log for details.';
  }
  return `Session finished with an error: ${[
    approval.errorCode,
    approval.errorMessage
  ].filter(Boolean).join(': ')}`;
}

interface SessionTimelineState {
  approval: ApprovalPageInfo;
  projectId?: string | undefined;
  childSessionToken?: ((sessionId: string) => string) | undefined;
  status: string;
  eyebrow: string;
  /** Primary identity: the agent's display name (falls back to its filename). */
  agentName: string;
  /** project-relative path + filename.agentuse, for the meta grid locator. */
  agentFile: string;
  /** Secondary, demoted from the title. */
  agentDescription: string;
  promptText: string;
  error?: string | undefined;
  initialReviewerComment: { comment: string; reviewer?: string; status?: string } | undefined;
  initialLogs: ApprovalLogEntry[];
  actionable: boolean;
  continueActionable: boolean;
  stopActionable: boolean;
  busy: boolean;
  /** Whether the run is actively progressing at render time (drives the working indicator). */
  live: boolean;
  initialResultText: string;
}

/**
 * The session timeline body: agent header + status eyebrow + reviewer comment +
 * log timeline, plus the action affordances (continue panel, comment dialog).
 * The action affordances render only when the corresponding `actionable` /
 * `continueActionable` flag is set (which the caller derives from `canAct`).
 * Shared by the unified `/sessions/:id` page (renderSessionPage).
 */
function renderSessionTimeline(view: SessionTimelineState): string {
  const {
    approval,
    projectId,
    status,
    eyebrow,
    agentName,
    agentFile,
    agentDescription,
    promptText,
    error,
    initialReviewerComment,
    initialLogs,
    actionable,
    continueActionable,
    stopActionable,
    busy,
    live,
    initialResultText,
  } = view;
  const childSessions = approval.childSessions ?? [];
  const childSessionHref = (sessionId: string): string => {
    const params = new URLSearchParams();
    const token = view.childSessionToken?.(sessionId) ?? '';
    if (token) params.set('token', token);
    if (projectId) params.set('project', projectId);
    const query = params.toString();
    return `/sessions/${encodeURIComponent(sessionId)}${query ? `?${query}` : ''}`;
  };
  return `<main>
    <header>
      <span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span>
      <div class="eyebrow">${escapeHtml(eyebrow)}</div>
      <h1>${escapeHtml(agentName)}</h1>
      ${agentDescription ? `<p class="agent-desc">${escapeHtml(agentDescription)}</p>` : ''}
      <p class="prompt">${escapeHtml(promptText)}</p>
      <div class="meta" id="approval-meta">
        ${renderCopyCell('session', approval.sessionId)}
        <div class="cell"><span class="label">project</span><code>${escapeHtml(projectId ?? 'default')}</code></div>
        ${renderCopyCell('file', agentFile)}
        <div class="cell"><span class="label">started</span><span class="value">${approval.createdAt !== undefined ? escapeHtml(formatApprovalTime(approval.createdAt)) : '—'}</span></div>
        <div class="cell" id="expires-cell"${approval.expiresAt === undefined ? ' hidden' : ''}><span class="label">expires</span><span class="value" id="expires-value">${approval.expiresAt !== undefined ? escapeHtml(formatApprovalTime(approval.expiresAt)) : ''}</span></div>
      </div>
    </header>

    ${childSessions.length > 0 ? `
    <div class="section-title"><span>subagents</span><span class="rule"></span></div>
    <div class="panel subagents-panel">
      <div class="subagent-list">
        ${childSessions.map((child) => {
          const childStatus = renderChildSessionStatus(child);
          const href = childSessionHref(child.sessionId);
          return `
          <a class="subagent-row" href="${escapeHtml(href)}">
            <span class="subagent-status ${escapeHtml(childStatus)}">${escapeHtml(childStatus)}</span>
            <span class="subagent-name">${escapeHtml(child.agent.name || child.agent.id)}</span>
            <code>${escapeHtml(child.sessionId)}</code>
            <span class="subagent-command">agentuse sessions show ${escapeHtml(child.sessionId.substring(0, 12))} --all-search</span>
          </a>
        `;
        }).join('')}
      </div>
    </div>` : ''}

    ${error ? `<p class="notice error">${escapeHtml(error)}</p>` : ''}

    <div id="reviewer-comment" class="panel reviewer-comment"${initialReviewerComment ? '' : ' hidden'}>
      <div class="label">latest reviewer comment</div>
      <div id="reviewer-comment-body" class="body">${initialReviewerComment ? renderLogContentValue(initialReviewerComment.comment, { forceMarkdown: true }) : ''}</div>
      <div id="reviewer-comment-meta" class="meta-line">${initialReviewerComment?.reviewer ? `from ${escapeHtml(initialReviewerComment.reviewer)}` : ''}</div>
    </div>

    <div class="section-title"><span>session log</span><span class="rule"></span></div>
    <div class="panel">
      <ul id="logs" class="logs">${renderLogItems(initialLogs, { actionable, currentResumeToken: approval.currentResumeToken, projectId })}</ul>
    </div>

    <div id="working-indicator" class="working-indicator"${live ? '' : ' hidden'}>
      <span class="log-spinner" aria-hidden="true"></span>
      <span>session running — the agent is working…</span>
    </div>

    <div id="stop-panel" class="stop-panel"${stopActionable ? '' : ' hidden'}>
      <span>Stop this session and any running subagents.</span>
      <button id="stop-submit" type="button" class="danger">Stop session</button>
    </div>

    <div id="continue-panel" class="continue-panel"${continueActionable ? '' : ' hidden'}>
      <div class="continue-label">continue session</div>
      <textarea id="continue-prompt" placeholder="tell the agent what to do next"></textarea>
      <div class="continue-actions">
        <span class="continue-hint"><span class="kbd">⌘⏎</span> continue with this instruction</span>
        <button id="continue-submit" type="button" class="primary">Continue session</button>
      </div>
    </div>

    <div id="inactive-banner" class="inactive-banner"${actionable || continueActionable || stopActionable || busy ? ' hidden' : ''}>This approval request is not accepting decisions right now.</div>

    <p id="result" class="notice${initialResultText ? ' error' : ''}">${initialResultText ? escapeHtml(initialResultText) : ''}</p>
  </main>

  ${actionable ? `
  <dialog id="comment-dialog" aria-labelledby="comment-dialog-title">
    <form method="dialog">
      <div class="dialog-head">
        <span id="comment-dialog-title" class="title">leave a comment</span>
        <button type="button" class="dialog-close" data-comment-cancel aria-label="Close">×</button>
      </div>
      <div class="dialog-body">
        <span class="prefix">&gt;</span>
        <textarea id="comment" placeholder="explain your decision, ask for a tweak, or send context back to the agent" autofocus></textarea>
      </div>
      <div class="dialog-foot">
        <span class="hint"><span class="kbd">⌘⏎</span> send <span class="kbd">esc</span> cancel</span>
        <span class="actions">
          <button type="button" data-comment-cancel>Cancel</button>
          <button type="button" class="primary" data-comment-submit>Send comment</button>
        </span>
      </div>
    </form>
  </dialog>` : ''}`;
}

interface SessionPageOptions {
  approval: ApprovalPageInfo;
  token: string;
  projectId?: string;
  childSessionToken?: (sessionId: string) => string;
  resuming?: boolean;
  continuing?: boolean;
  error?: string;
  /**
   * Whether the viewer is authorized to act on this session (approve / reject /
   * comment / continue). Defaults to true so this renders identically to the
   * legacy approval page. The unified `/sessions/:id` route passes the result
   * of its auth check here; an unauthorized viewer never reaches render (the
   * route returns 401 first), so on that route this is effectively always true.
   */
  canAct?: boolean;
}

/**
 * Full `/sessions/:id` page: doctype + head + topbar + the session timeline
 * (delegated to renderSessionTimeline) + the inline JS that polls status and
 * drives the action affordances. This is the single page for both viewing a
 * run log and approving/continuing it.
 */
function renderSessionPage(options: SessionPageOptions): string {
  const { approval, token, projectId, childSessionToken, resuming, continuing, error, canAct = true } = options;
  const expired = approval.expiresAt !== undefined && approval.expiresAt <= Date.now();
  const busy = Boolean(resuming || continuing);
  const actionable = canAct && approval.sessionStatus === 'suspended' && !expired && !busy && !error && Boolean(approval.prompt);
  const continueActionable = canAct && canContinueApprovalSession({ approval, resuming, continuing, error });
  const stopActionable = canAct && !busy && !expired && !isEndedSessionStatus(approval.sessionStatus);
  let status = continuing
    ? 'continuing'
    : resuming
    ? 'resuming'
    : expired
      ? 'expired'
      : approval.sessionStatus === 'suspended'
        ? 'waiting'
        : approval.sessionStatus;
  if (status === 'error' && approval.errorCode === 'USER_STOPPED') status = 'stopped';
  if (status === 'error' && approval.errorCode === 'TIMEOUT') status = 'timeout';
  const initialLogs = approval.logs ?? [];
  // Live whenever the run is actively progressing — covers tool execution and
  // the between-step thinking gaps where no individual log entry is streaming.
  // Mirrors the client isLiveStatus() (including its terminal-status short
  // circuit) so the working indicator and eyebrow render correctly before the
  // first status poll lands.
  const live = status === 'completed' || status === 'error' || status === 'expired' || status === 'failed'
    ? false
    : status === 'running' || status === 'run' || resuming || continuing
      || initialLogs.some((entry) => entry.status === 'streaming' || entry.status === 'running');
  const initialReviewerComment = latestReviewerComment(initialLogs);
  const fileName = approval.agent.id.split('/').pop() || approval.agent.id;
  const agentName = approval.agent.name || fileName;
  const agentFile = `${approval.agent.id}.agentuse`;
  const agentDescription = approval.agent.description ?? '';
  const eyebrow = actionable
    ? 'human approval requested'
    : continueActionable
      ? approval.sessionStatus === 'error' ? 'session needs attention' : 'session completed'
      : live
        ? 'session running'
        : 'approval history';
  const promptText = actionable
    ? 'Review the pending request in the session log below, then approve, reject, or send a comment back to the agent. The session is paused until you respond.'
    : continueActionable
      ? approval.sessionStatus === 'error'
        ? 'This run stopped with an error. Review the session log, then send a follow-up instruction to continue the same session with its existing context.'
        : 'This run has finished. Send a follow-up instruction to continue the same session with its existing context.'
      : busy
        ? 'AgentUse is continuing this session. The session log updates as new work arrives.'
        : expired
          ? 'This approval request has expired. The session log remains available for review.'
          : 'This approval request is not accepting decisions right now. The session log remains available for review.';
  const sessionErrorText = approvalSessionErrorText(approval);
  const initialResultText = error || sessionErrorText;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <link rel="icon" type="image/svg+xml" href="/favicon.svg">
  <title>${escapeHtml(agentName)} · AgentUse session</title>
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
  <link href="https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500;600&family=Geist:wght@400;500;600&display=swap" rel="stylesheet">
  <script>
    // Resolve theme before paint to avoid flash. Stored value: 'light' | 'dark' | null (system).
    (function() {
      try {
        var stored = localStorage.getItem('agentuse-theme');
        var resolved = stored === 'light' || stored === 'dark'
          ? stored
          : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', resolved);
        if (stored) document.documentElement.setAttribute('data-theme-pref', stored);
        else document.documentElement.setAttribute('data-theme-pref', 'system');
      } catch (e) {}
    })();
  </script>
  <style>
    :root {
      --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #000000;
      --fg: #ffffff;
      --line: rgba(255,255,255,0.10);
      --line-strong: rgba(255,255,255,0.18);
      --panel: rgba(255,255,255,0.03);
      --panel-hover: rgba(255,255,255,0.06);
      --muted: rgba(255,255,255,0.50);
      --muted-2: rgba(255,255,255,0.30);
      --muted-3: rgba(255,255,255,0.70);
      --cyan: #22d3ee;
      --cyan-soft: rgba(34,211,238,0.08);
      --cyan-border: rgba(34,211,238,0.35);
      --green: #4ade80;
      --green-soft: rgba(74,222,128,0.08);
      --green-border: rgba(74,222,128,0.35);
      --amber: #fbbf24;
      --amber-soft: rgba(251,191,36,0.08);
      --amber-border: rgba(251,191,36,0.35);
      --red: #f87171;
      --red-soft: rgba(248,113,113,0.10);
      --red-border: rgba(248,113,113,0.35);
      --primary-fg: #000000;
      --primary-bg: #4ade80;
      --primary-bg-hover: #86efac;
      --bar-bg: rgba(0,0,0,0.85);
      --glow-1: rgba(34,211,238,0.06);
      --glow-2: rgba(74,222,128,0.04);
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #fafaf9;
      --fg: #0a0a0a;
      --line: rgba(0,0,0,0.08);
      --line-strong: rgba(0,0,0,0.16);
      --panel: rgba(0,0,0,0.025);
      --panel-hover: rgba(0,0,0,0.05);
      --muted: rgba(0,0,0,0.55);
      --muted-2: rgba(0,0,0,0.35);
      --muted-3: rgba(0,0,0,0.75);
      --cyan: #0891b2;
      --cyan-soft: rgba(8,145,178,0.08);
      --cyan-border: rgba(8,145,178,0.35);
      --green: #047857;
      --green-soft: rgba(4,120,87,0.08);
      --green-border: rgba(4,120,87,0.35);
      --amber: #b45309;
      --amber-soft: rgba(180,83,9,0.10);
      --amber-border: rgba(180,83,9,0.35);
      --red: #b91c1c;
      --red-soft: rgba(185,28,28,0.08);
      --red-border: rgba(185,28,28,0.35);
      --primary-fg: #ffffff;
      --primary-bg: #047857;
      --primary-bg-hover: #065f46;
      --bar-bg: rgba(250,250,249,0.85);
      --glow-1: rgba(8,145,178,0.06);
      --glow-2: rgba(4,120,87,0.04);
    }
    * { box-sizing: border-box; }
    html, body { background: var(--bg); }
    body {
      margin: 0;
      min-height: 100vh;
      color: var(--fg);
      font-family: var(--mono);
      font-size: 14px;
      line-height: 1.55;
      -webkit-font-smoothing: antialiased;
      background:
        radial-gradient(1200px 600px at 50% -200px, var(--glow-1), transparent 60%),
        radial-gradient(800px 400px at 100% 100%, var(--glow-2), transparent 60%),
        var(--bg);
      padding-bottom: 140px;
    }
    a { color: var(--cyan); text-decoration: none; border-bottom: 1px dotted var(--cyan-border); }
    a:hover { opacity: 0.8; }

    /* top bar */
    ${approvalsTopbarStyles()}

    main { width: min(960px, calc(100vw - 32px)); margin: 0 auto; padding: 40px 0 24px; }

    /* header */
    header { margin-bottom: 28px; }
    .status {
      display: inline-flex; align-items: center; gap: 8px;
      padding: 4px 10px 4px 8px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      font-size: 11px; font-weight: 500;
      letter-spacing: 0.08em; text-transform: uppercase;
      background: var(--panel);
      color: var(--muted-3);
      margin-bottom: 18px;
    }
    .status::before {
      content: ""; width: 6px; height: 6px; border-radius: 999px;
      background: currentColor; box-shadow: 0 0 10px currentColor;
    }
    .status.waiting { color: var(--cyan); border-color: var(--cyan-border); background: var(--cyan-soft); }
    .status.waiting::before { animation: pulse 1.4s ease-in-out infinite; }
    .status.running, .status.run { color: var(--cyan); border-color: var(--cyan-border); background: var(--cyan-soft); }
    .status.running::before, .status.run::before { animation: pulse 0.8s ease-in-out infinite; }
    .status.resuming, .status.continuing { color: var(--amber); border-color: var(--amber-border); background: var(--amber-soft); }
    .status.resuming::before, .status.continuing::before { animation: pulse 0.8s ease-in-out infinite; }
    .status.completed, .status.approved { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
    .status.expired, .status.error, .status.rejected, .status.stopped, .status.timeout { color: var(--red); border-color: var(--red-border); background: var(--red-soft); }
    @keyframes pulse { 0%, 100% { opacity: 1; } 50% { opacity: 0.35; } }

    .eyebrow {
      font-size: 11px;
      color: var(--cyan);
      letter-spacing: 0.18em; text-transform: uppercase;
      margin-bottom: 8px;
    }
    h1 {
      font-family: var(--sans);
      font-size: clamp(28px, 4vw, 42px);
      line-height: 1.1;
      letter-spacing: -0.02em;
      margin: 0 0 18px;
      font-weight: 500;
    }
    .agent-desc {
      font-family: var(--sans);
      font-size: 15px;
      line-height: 1.5;
      color: var(--muted-3);
      margin: 10px 0 0;
      max-width: 70ch;
    }
    .prompt {
      font-family: var(--sans);
      font-size: 17px;
      color: var(--muted-3);
      border-left: 2px solid var(--cyan-border);
      padding: 6px 0 6px 16px;
      margin: 16px 0 0;
    }

    /* meta grid */
    .meta {
      display: grid;
      grid-template-columns: repeat(auto-fit, minmax(180px, 1fr));
      gap: 1px;
      margin: 28px 0 0;
      background: var(--line);
      border: 1px solid var(--line);
      border-radius: 10px;
      overflow: hidden;
    }
    .meta .cell {
      background: var(--bg);
      padding: 14px 16px;
    }
    .meta .label {
      display: block;
      color: var(--muted-2);
      font-size: 11px;
      letter-spacing: 0.06em;
      margin-bottom: 6px;
    }
    .meta .label::before { content: "⋮ "; color: var(--cyan); opacity: 0.6; }
    .meta .value, .meta code { color: var(--fg); font-size: 13px; word-break: break-all; }
    .copyable { display: flex; align-items: flex-start; gap: 6px; }
    .copyable code { flex: 1; min-width: 0; }
    .copy-btn {
      flex: none;
      display: inline-flex;
      align-items: center;
      justify-content: center;
      min-height: 0;
      width: 22px;
      height: 22px;
      padding: 0;
      margin-top: -2px;
      border: 1px solid var(--line);
      border-radius: 6px;
      background: var(--panel);
      color: var(--muted-2);
      cursor: pointer;
      transition: color 120ms ease, background 120ms ease, border-color 120ms ease;
    }
    .copy-btn:hover { color: var(--fg); background: var(--panel-hover); border-color: var(--line-strong); }
    .copy-btn svg { width: 13px; height: 13px; display: block; }
    .copy-btn .check-icon { display: none; }
    .copy-btn.copied { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
    .copy-btn.copied .copy-icon { display: none; }
    .copy-btn.copied .check-icon { display: block; }

    /* sections */
    .section-title {
      display: flex; align-items: baseline; gap: 10px;
      margin: 36px 0 10px;
      font-size: 11px;
      letter-spacing: 0.18em; text-transform: uppercase;
      color: var(--muted-2);
    }
    .section-title::before { content: "⋮"; color: var(--cyan); font-size: 14px; transform: translateY(1px); }
    .section-title .rule { flex: 1; height: 1px; background: var(--line); }

    .panel {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 16px 18px;
    }
    .panel + .panel { margin-top: 10px; }
    .panel pre {
      margin: 0;
      white-space: pre-wrap; overflow-wrap: anywhere;
      font-family: var(--mono);
      font-size: 13px;
      color: var(--muted-3);
    }

    .notice { margin: 12px 0 0; color: var(--muted); font-size: 13px; }
    .notice.error { color: var(--red); }
    .notice.error::before { content: "✗ "; }
    .subagents-panel { padding: 0; overflow: hidden; }
    .subagent-list { display: grid; }
    .subagent-row {
      display: grid;
      grid-template-columns: auto minmax(120px, 1fr) minmax(180px, auto);
      gap: 10px 14px;
      align-items: center;
      padding: 12px 14px;
      border-bottom: 1px solid var(--line);
      color: inherit;
      text-decoration: none;
    }
    .subagent-row:hover { background: var(--panel-soft); }
    .subagent-row:last-child { border-bottom: 0; }
    .subagent-status {
      display: inline-flex;
      align-items: center;
      padding: 2px 7px;
      border: 1px solid var(--line-strong);
      border-radius: 999px;
      color: var(--muted-3);
      font-size: 10px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
    }
    .subagent-status.running, .subagent-status.suspended { color: var(--cyan); border-color: var(--cyan-border); background: var(--cyan-soft); }
    .subagent-status.completed { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
    .subagent-status.error { color: var(--red); border-color: var(--red-border); background: var(--red-soft); }
    .subagent-name { color: var(--fg); font-weight: 500; overflow-wrap: anywhere; }
    .subagent-row code { color: var(--muted-3); overflow-wrap: anywhere; }
    .subagent-command {
      grid-column: 2 / -1;
      color: var(--muted-2);
      font-size: 11px;
      overflow-wrap: anywhere;
    }
    .stop-panel {
      margin: 14px 0 0;
      padding: 12px 14px;
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
      border: 1px solid var(--red-border);
      border-radius: 8px;
      background: var(--red-soft);
      color: var(--fg);
      font-size: 13px;
    }
    .stop-panel button { white-space: nowrap; }
    .reviewer-comment {
      margin: 0 0 18px;
      border-color: var(--cyan-border);
      background: var(--cyan-soft);
    }
    .reviewer-comment[hidden] { display: none; }
    .reviewer-comment .label {
      color: var(--cyan);
      font-size: 10px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      margin-bottom: 8px;
    }
    .reviewer-comment .body {
      color: var(--fg);
      font-family: var(--sans);
      font-size: 15px;
      line-height: 1.55;
      overflow-wrap: anywhere;
    }
    .reviewer-comment .meta-line {
      margin-top: 10px;
      color: var(--muted);
      font-size: 12px;
    }

    /* logs */
    .logs { list-style: none; margin: 0; padding: 0; }
    .log-item {
      display: grid;
      grid-template-columns: 96px 14px 1fr;
      gap: 12px;
      padding: 10px 0;
      border-bottom: 1px dashed var(--line);
      align-items: start;
    }
    .log-item:last-child { border-bottom: 0; }
    .log-time { color: var(--muted-2); font-size: 12px; padding-top: 1px; }
    .log-marker {
      display: inline-flex;
      justify-content: center;
      align-items: center;
      width: 12px;
      min-height: 18px;
      color: var(--cyan);
      opacity: 0.6;
    }
    .log-spinner {
      width: 10px;
      height: 10px;
      border-radius: 999px;
      border: 1.5px solid var(--cyan-border);
      border-top-color: var(--cyan);
      animation: log-spin 700ms linear infinite;
    }
    @keyframes log-spin { to { transform: rotate(360deg); } }
    .working-indicator {
      display: flex;
      align-items: center;
      gap: 10px;
      margin: 14px 2px 0;
      font-size: 12px;
      letter-spacing: 0.04em;
      color: var(--muted-3);
    }
    .working-indicator[hidden] { display: none; }
    .log-item.streaming .log-marker, .log-item.running .log-marker { opacity: 1; }
    .log-item.error .log-marker, .log-item.failed .log-marker { color: var(--red); }
    .log-item.completed .log-marker, .log-item.approved .log-marker { color: var(--green); }
    .log-item.resuming .log-marker { color: var(--amber); }
    .log-item.expandable { cursor: pointer; }
    .log-item.expandable:hover .log-title { color: var(--cyan); }
    .log-item.expandable .log-title::after {
      content: "show";
      display: inline-flex;
      margin-left: 8px;
      padding: 1px 6px;
      border: 1px solid var(--line);
      border-radius: 999px;
      color: var(--muted-2);
      font-size: 10px;
      font-weight: 500;
      letter-spacing: 0.06em;
      text-transform: uppercase;
      vertical-align: 1px;
    }
    .log-item.expandable.expanded .log-title::after { content: "hide"; color: var(--muted); }
    .log-title { font-weight: 500; color: var(--fg); }
    .log-content {
      display: block;
      margin-top: 6px;
    }
    .log-item.expandable:not(.expanded) .log-content { display: none; }
    .log-empty { color: var(--muted-2); padding: 12px 0; font-style: italic; }

    .store-event {
      display: flex;
      justify-content: space-between;
      gap: 14px;
      margin-top: 8px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .store-event-title { color: var(--fg); font-weight: 500; margin-top: 3px; }
    .store-event-store,
    .store-event-meta,
    .store-event-preview {
      color: var(--muted-2);
      font-size: 12px;
    }
    .store-event-meta { display: flex; flex-wrap: wrap; gap: 8px; margin-top: 4px; }
    .store-event-preview { margin-top: 6px; max-width: 640px; }
    .store-event-link {
      align-self: flex-start;
      white-space: nowrap;
      border-bottom-style: dashed;
    }

    .log-details {
      display: grid;
      gap: 10px;
    }
    .log-detail {
      display: grid;
      gap: 4px;
    }
    .log-detail-label {
      font-size: 10px;
      letter-spacing: 0.18em;
      text-transform: uppercase;
      color: var(--muted-2);
    }
    .log-detail-label::before { content: "⋮ "; color: var(--cyan); opacity: 0.6; }
    .log-detail-value {
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 8px;
      color: var(--muted-3);
      overflow: hidden;
    }
    .log-detail-link {
      color: var(--cyan);
      text-decoration: none;
      border-bottom: 1px dashed var(--cyan-border);
    }
    .log-detail-link:hover { border-bottom-style: solid; }
    .content-code {
      margin: 0;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--bg);
      color: var(--muted-3);
      font-family: var(--mono);
      font-size: 12.5px;
      line-height: 1.5;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      overflow-x: auto;
    }
    .log-detail-value .content-code {
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .content-code.json code { color: var(--fg); }
    .json-object-block {
      display: grid;
      gap: 10px;
      padding: 10px 12px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .json-object-block::before,
    .json-object-block::after {
      color: var(--muted-2);
      font-family: var(--mono);
      font-size: 12px;
      line-height: 1;
    }
    .json-object-block::before { content: "{"; }
    .json-object-block::after { content: "}"; }
    .log-detail-value .json-object-block {
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .json-field {
      display: grid;
      gap: 6px;
    }
    .json-field-key {
      color: var(--cyan);
      font-family: var(--mono);
      font-size: 11px;
      letter-spacing: 0.06em;
    }
    .json-field-key::before { content: '"'; color: var(--muted-2); }
    .json-field-key::after { content: '":'; color: var(--muted-2); }
    .json-field-value > .content-markdown,
    .json-field-value > .content-code {
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--bg);
    }
    .decoded-json-string {
      white-space: pre-wrap;
      tab-size: 2;
    }
    .json-inline-string,
    .json-inline-literal {
      display: inline-block;
      padding: 3px 6px;
      border: 1px solid var(--line);
      border-radius: 5px;
      background: var(--bg);
      color: var(--muted-3);
      font-family: var(--mono);
      font-size: 12px;
      overflow-wrap: anywhere;
    }
    .content-markdown {
      padding: 10px 12px;
      color: var(--muted-3);
      font-family: var(--sans);
      font-size: 14px;
      line-height: 1.6;
      overflow-wrap: anywhere;
    }
    .log-content > .content-markdown,
    .log-content > .content-code {
      margin-top: 4px;
      border: 1px solid var(--line);
      border-radius: 8px;
      background: var(--panel);
    }
    .content-markdown > :first-child { margin-top: 0; }
    .content-markdown > :last-child { margin-bottom: 0; }
    .content-markdown p { margin: 0 0 9px; }
    .content-markdown h2,
    .content-markdown h3,
    .content-markdown h4,
    .content-markdown h5,
    .content-markdown h6 {
      margin: 14px 0 6px;
      color: var(--fg);
      font-family: var(--sans);
      font-size: 15px;
      line-height: 1.35;
      font-weight: 600;
    }
    .content-markdown ul,
    .content-markdown ol { margin: 6px 0 10px; padding-left: 22px; }
    .content-markdown li { margin: 3px 0; }
    .content-markdown blockquote {
      margin: 8px 0;
      padding-left: 12px;
      border-left: 2px solid var(--cyan-border);
      color: var(--muted);
    }
    .content-markdown code {
      font-family: var(--mono);
      font-size: 0.92em;
      color: var(--fg);
      background: var(--panel-hover);
      border: 1px solid var(--line);
      border-radius: 4px;
      padding: 1px 4px;
    }
    .content-markdown .content-code {
      margin: 10px 0;
      padding: 10px 12px;
      background: var(--bg);
    }
    .content-markdown .content-code code {
      padding: 0;
      border: 0;
      background: transparent;
    }
    .content-markdown strong {
      color: var(--fg);
      font-weight: 600;
    }

    /* approval review card */
    .approval-card {
      display: grid;
      gap: 12px;
      margin-top: 6px;
    }
    .approval-question {
      color: var(--fg);
      font-family: var(--sans);
      font-size: 18px;
      line-height: 1.35;
      font-weight: 500;
      overflow-wrap: anywhere;
    }
    .approval-question strong { font-weight: 600; }
    .approval-section {
      border: 0;
      border-radius: 0;
      background: transparent;
      overflow: hidden;
    }
    .approval-primary {
      border: 1px solid var(--line-strong);
      border-radius: 10px;
      border-color: var(--line-strong);
      background: var(--bg);
    }
    .approval-risk {
      background: transparent;
    }
    .approval-section-title,
    .approval-context > summary {
      color: var(--muted-2);
      font-size: 10px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
      padding: 10px 12px 0;
    }
    .approval-context > summary {
      cursor: pointer;
      padding-bottom: 10px;
      list-style-position: inside;
    }
    .approval-section-body {
      padding: 10px 12px 12px;
      color: var(--muted-3);
      overflow-wrap: anywhere;
    }
    .approval-primary .approval-section-body {
      color: var(--fg);
      font-size: 14px;
      line-height: 1.65;
    }
    .approval-risk .approval-section-title { color: var(--amber); }
    .approval-card .content-markdown,
    .approval-card .content-code {
      padding: 0;
      border: 0;
      border-radius: 0;
      background: transparent;
    }
    .approval-card .content-code {
      color: inherit;
      white-space: pre-wrap;
    }
    .approval-link-row {
      display: flex;
      flex-wrap: wrap;
      gap: 8px;
      padding: 10px 12px 12px;
    }
    .approval-link {
      color: var(--cyan);
      border-bottom: 1px dashed var(--cyan-border);
    }
    .approval-link:hover { border-bottom-style: solid; }

    /* inline approval actions (rendered inside the active pending log entry) */
    .log-actions {
      margin-top: 12px;
      padding: 12px 14px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
      display: flex; flex-wrap: wrap;
      gap: 12px;
      align-items: center;
      justify-content: space-between;
    }
    .log-actions-hint {
      font-size: 12px;
      color: var(--muted-2);
      letter-spacing: 0.04em;
    }
    .log-actions-hint .kbd {
      display: inline-block;
      padding: 1px 6px; margin: 0 2px;
      font-size: 11px;
      border: 1px solid var(--line-strong);
      border-radius: 4px;
      color: var(--muted-3);
      background: var(--bg);
    }
    .log-actions-buttons { display: inline-flex; flex-wrap: wrap; gap: 8px; justify-content: flex-end; }
    button {
      font-family: var(--mono);
      font-size: 13px;
      font-weight: 500;
      letter-spacing: 0.02em;
      border: 1px solid var(--line-strong);
      background: transparent;
      color: var(--fg);
      border-radius: 8px;
      min-height: 40px;
      padding: 0 16px;
      cursor: pointer;
      transition: background 120ms ease, border-color 120ms ease, transform 80ms ease;
    }
    button:hover { background: var(--panel-hover); border-color: var(--line-strong); }
    button:active { transform: translateY(1px); }
    button.primary {
      background: var(--primary-bg);
      border-color: var(--primary-bg);
      color: var(--primary-fg);
    }
    button.primary:hover { background: var(--primary-bg-hover); border-color: var(--primary-bg-hover); }
    button.danger {
      background: transparent;
      border-color: var(--red-border);
      color: var(--red);
    }
    button.danger:hover { background: var(--red-soft); border-color: var(--red); }
    button:disabled { opacity: 0.45; cursor: not-allowed; transform: none; }

    /* comment dialog */
    dialog#comment-dialog {
      width: min(560px, calc(100vw - 32px));
      max-width: 100%;
      padding: 0;
      border: 1px solid var(--line-strong);
      border-radius: 12px;
      background: var(--bg);
      color: var(--fg);
      box-shadow: 0 20px 60px rgba(0,0,0,0.45);
    }
    dialog#comment-dialog::backdrop {
      background: rgba(0,0,0,0.55);
      backdrop-filter: blur(4px);
      -webkit-backdrop-filter: blur(4px);
    }
    :root[data-theme="light"] dialog#comment-dialog::backdrop {
      background: rgba(0,0,0,0.30);
    }
    dialog#comment-dialog form { margin: 0; padding: 0; }
    .dialog-head {
      display: flex; align-items: center; justify-content: space-between;
      padding: 14px 18px;
      border-bottom: 1px solid var(--line);
      font-size: 11px;
      letter-spacing: 0.18em; text-transform: uppercase;
      color: var(--muted-2);
    }
    .dialog-head .title::before { content: "⋮ "; color: var(--cyan); }
    .dialog-close {
      min-height: 0; padding: 4px 8px;
      background: transparent; border: 0;
      color: var(--muted-2); font-size: 16px; line-height: 1;
      cursor: pointer; border-radius: 6px;
    }
    .dialog-close:hover { background: var(--panel-hover); color: var(--fg); border: 0; }
    .dialog-body {
      padding: 16px 18px;
      display: grid;
      grid-template-columns: auto 1fr;
      gap: 10px;
      align-items: start;
    }
    .dialog-body .prefix {
      color: var(--cyan); opacity: 0.7; font-size: 13px; padding-top: 12px;
    }
    textarea {
      width: 100%;
      min-height: 96px;
      max-height: 240px;
      resize: vertical;
      border: 1px solid var(--line);
      background: var(--panel);
      border-radius: 8px;
      padding: 10px 12px;
      font: inherit;
      font-family: var(--mono);
      font-size: 13.5px;
      color: var(--fg);
      outline: none;
      transition: border-color 120ms ease;
    }
    textarea:focus { border-color: var(--cyan-border); }
    textarea::placeholder { color: var(--muted-2); }
    textarea:disabled { opacity: 0.55; cursor: not-allowed; }
    .dialog-foot {
      display: flex; align-items: center; justify-content: space-between;
      gap: 12px;
      padding: 12px 18px;
      border-top: 1px solid var(--line);
    }
    .dialog-foot .hint {
      font-size: 11px;
      color: var(--muted-2);
      letter-spacing: 0.04em;
    }
    .dialog-foot .hint .kbd {
      display: inline-block;
      padding: 1px 6px; margin: 0 2px;
      font-size: 11px;
      border: 1px solid var(--line-strong);
      border-radius: 4px;
      color: var(--muted-3);
      background: var(--panel);
    }
    .dialog-foot .actions { gap: 8px; }

    .inactive-banner {
      margin-top: 24px;
      padding: 14px 16px;
      border: 1px dashed var(--line-strong);
      border-radius: 10px;
      color: var(--muted);
      font-size: 13px;
    }
    .inactive-banner[hidden] { display: none; }
    .inactive-banner::before { content: "⋮ "; color: var(--muted-2); }

    .continue-panel {
      margin-top: 24px;
      padding: 16px 18px;
      border: 1px solid var(--line);
      border-radius: 10px;
      background: var(--panel);
      display: grid;
      gap: 12px;
    }
    .continue-panel[hidden] { display: none; }
    .continue-label {
      color: var(--muted-2);
      font-size: 10px;
      letter-spacing: 0.16em;
      text-transform: uppercase;
    }
    .continue-label::before { content: "⋮ "; color: var(--cyan); opacity: 0.7; }
    .continue-panel textarea {
      min-height: 112px;
    }
    .continue-actions {
      display: flex;
      justify-content: space-between;
      align-items: center;
      gap: 12px;
    }
    .continue-hint {
      color: var(--muted-2);
      font-size: 11px;
      letter-spacing: 0.04em;
    }
    .continue-hint .kbd {
      display: inline-block;
      padding: 1px 6px;
      margin: 0 2px;
      font-size: 11px;
      border: 1px solid var(--line-strong);
      border-radius: 4px;
      color: var(--muted-3);
      background: var(--bg);
    }

    /* responsive */
    @media (max-width: 640px) {
      h1 { font-size: 26px; }
      .subagent-row { grid-template-columns: 1fr; }
      .subagent-command { grid-column: auto; }
      .stop-panel { flex-direction: column; align-items: stretch; }
      .stop-panel button { width: 100%; }
      .log-actions { flex-direction: column; align-items: stretch; }
      .log-actions-hint { display: none; }
      .log-actions-buttons { justify-content: stretch; }
      .log-actions-buttons button { flex: 1; }
      .continue-actions { flex-direction: column; align-items: stretch; }
      .continue-actions button { width: 100%; }
    }
  </style>
</head>
<body>
  ${approvalsTopbarMarkup({
    currentPage: 'sessions',
    right: approvalsThemeToggleHtml()
  })}

  ${renderSessionTimeline({
    approval,
    projectId,
    childSessionToken,
    status,
    eyebrow,
    agentName,
    agentFile,
    agentDescription,
    promptText,
    error,
    initialReviewerComment,
    initialLogs,
    actionable,
    continueActionable,
    stopActionable,
    busy,
    live,
    initialResultText,
  })}

  <script>
    const token = ${JSON.stringify(token)};
    const project = ${JSON.stringify(projectId)};
    // The active gate's resumeToken at page render. Each await_human gate mints
    // a fresh token; if the page was opened on gate N's URL but the agent has
    // moved on to gate N+1, this rotates and refreshStatus redirects to the new
    // approval URL. /decision is sent with the current token, not the URL token,
    // so it stays valid across gates within the same session.
    let currentResumeToken = ${JSON.stringify(approval.currentResumeToken ?? token)};
    let pendingActionable = ${JSON.stringify(actionable)};
    let continueActionable = ${JSON.stringify(continueActionable)};
    let stopActionable = ${JSON.stringify(stopActionable)};
    const statusEl = document.querySelector('.status');
    const logsEl = document.getElementById('logs');
    const reviewerCommentEl = document.getElementById('reviewer-comment');
    const reviewerCommentBodyEl = document.getElementById('reviewer-comment-body');
    const reviewerCommentMetaEl = document.getElementById('reviewer-comment-meta');
    const continuePanel = document.getElementById('continue-panel');
    const continueInput = document.getElementById('continue-prompt');
    const continueSubmit = document.getElementById('continue-submit');
    const stopPanel = document.getElementById('stop-panel');
    const stopSubmit = document.getElementById('stop-submit');
    const inactiveBanner = document.getElementById('inactive-banner');
    const workingIndicator = document.getElementById('working-indicator');
    try { if ('scrollRestoration' in history) history.scrollRestoration = 'manual'; } catch {}

    // theme toggle
    ${approvalsThemeToggleScript()}
    function escapeText(value) {
      return String(value ?? '').replace(/[&<>"']/g, (ch) => ({
        '&': '&amp;',
        '<': '&lt;',
        '>': '&gt;',
        '"': '&quot;',
        "'": '&#39;'
      }[ch]));
    }
    function isJsonLikeContent(value) {
      const trimmed = String(value ?? '').trim();
      if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return false;
      try { JSON.parse(trimmed); return true; } catch { return false; }
    }
    function looksLikeMarkdown(value) {
      const trimmed = String(value ?? '').trim();
      if (!trimmed) return false;
      return /(^|\\n)(#{1,6}\\s|\\s*[-*+]\\s|\\s*\\d+\\.\\s|>\\s|\`\`\`|\\|.+\\|)/.test(trimmed) ||
        /\\[[^\\]]+\\]\\([^)]+\\)/.test(trimmed) ||
        /\\*\\*[^*]+\\*\\*/.test(trimmed) ||
        /https?:\\/\\/[^\\s)]+/.test(trimmed) ||
        /\`[^\`]+\`/.test(trimmed);
    }
    function renderInlineMarkdown(value) {
      return escapeText(value)
        .replace(/\\*\\*([^*]+)\\*\\*/g, '<strong>$1</strong>')
        .replace(/\`([^\`]+)\`/g, '<code>$1</code>')
        .replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)\\s]+)\\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
        .replace(/(^|[\\s(])(https?:\\/\\/[^\\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
    }
    function renderMarkdownTextBlock(value) {
      const lines = String(value ?? '').split(/\\r?\\n/);
      const html = [];
      let paragraph = [];
      let list = null;
      let quote = [];
      function flushParagraph() {
        if (!paragraph.length) return;
        html.push('<p>' + paragraph.map(renderInlineMarkdown).join('<br>') + '</p>');
        paragraph = [];
      }
      function flushList() {
        if (!list) return;
        html.push('<' + list.type + '>' + list.items.map((item) => '<li>' + renderInlineMarkdown(item) + '</li>').join('') + '</' + list.type + '>');
        list = null;
      }
      function flushQuote() {
        if (!quote.length) return;
        html.push('<blockquote>' + quote.map((line) => '<p>' + renderInlineMarkdown(line) + '</p>').join('') + '</blockquote>');
        quote = [];
      }
      function flushAll() { flushParagraph(); flushList(); flushQuote(); }
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) { flushAll(); continue; }
        const heading = trimmed.match(/^(#{1,6})\\s+(.+)$/);
        if (heading) {
          flushAll();
          const level = Math.min(6, heading[1].length + 1);
          html.push('<h' + level + '>' + renderInlineMarkdown(heading[2]) + '</h' + level + '>');
          continue;
        }
        const unordered = trimmed.match(/^[-*+]\\s+(.+)$/);
        if (unordered) {
          flushParagraph(); flushQuote();
          if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
          list.items.push(unordered[1]);
          continue;
        }
        const ordered = trimmed.match(/^\\d+\\.\\s+(.+)$/);
        if (ordered) {
          flushParagraph(); flushQuote();
          if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
          list.items.push(ordered[1]);
          continue;
        }
        const blockquote = trimmed.match(/^>\\s?(.*)$/);
        if (blockquote) {
          flushParagraph(); flushList();
          quote.push(blockquote[1]);
          continue;
        }
        flushList(); flushQuote();
        paragraph.push(trimmed);
      }
      flushAll();
      return html.join('');
    }
    function renderMarkdownBlock(value) {
      const html = [];
      let cursor = 0;
      const fencePattern = /\`\`\`([A-Za-z0-9_-]+)?\\s*\\n([\\s\\S]*?)\`\`\`/g;
      let match;
      while ((match = fencePattern.exec(String(value ?? ''))) !== null) {
        const before = String(value ?? '').slice(cursor, match.index);
        if (before.trim()) html.push(renderMarkdownTextBlock(before));
        const language = match[1] ? ' data-language="' + escapeText(match[1]) + '"' : '';
        html.push('<pre class="content-code"' + language + '><code>' + escapeText(match[2].trim()) + '</code></pre>');
        cursor = match.index + match[0].length;
      }
      const rest = String(value ?? '').slice(cursor);
      if (rest.trim()) html.push(renderMarkdownTextBlock(rest));
      return '<div class="content-markdown">' + html.join('') + '</div>';
    }
    function isReadableJsonString(value) {
      return value.length > 120 || value.includes('\\n') || value.includes('\\t');
    }
    function renderJsonFieldValue(value) {
      if (typeof value === 'string') {
        if (isReadableJsonString(value)) {
          return '<pre class="content-code text decoded-json-string"><code>' + escapeText(value) + '</code></pre>';
        }
        return '<code class="json-inline-string">' + escapeText(JSON.stringify(value)) + '</code>';
      }
      if (value === null || typeof value === 'number' || typeof value === 'boolean') {
        return '<code class="json-inline-literal">' + escapeText(JSON.stringify(value)) + '</code>';
      }
      return '<pre class="content-code json"><code>' + escapeText(JSON.stringify(value, null, 2)) + '</code></pre>';
    }
    function renderSmartJsonBlock(parsed) {
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return '<pre class="content-code json"><code>' + escapeText(JSON.stringify(parsed, null, 2)) + '</code></pre>';
      }
      const entries = Object.entries(parsed);
      if (!entries.some(([, value]) => typeof value === 'string' && isReadableJsonString(value))) {
        return '<pre class="content-code json"><code>' + escapeText(JSON.stringify(parsed, null, 2)) + '</code></pre>';
      }
      return '<div class="json-object-block" role="group" aria-label="JSON object">' + entries.map(([key, fieldValue]) =>
        '<div class="json-field">' +
          '<div class="json-field-key">' + escapeText(key) + '</div>' +
          '<div class="json-field-value">' + renderJsonFieldValue(fieldValue) + '</div>' +
        '</div>'
      ).join('') + '</div>';
    }
    function renderLogContentValue(value, opts) {
      const text = String(value ?? '');
      if (isJsonLikeContent(text)) {
        return renderSmartJsonBlock(JSON.parse(text));
      }
      if ((opts && opts.forceMarkdown) || looksLikeMarkdown(text)) return renderMarkdownBlock(text);
      return '<pre class="content-code text"><code>' + escapeText(text) + '</code></pre>';
    }
    function formatTime(value) {
      return value ? new Date(value).toLocaleTimeString() : '';
    }
    // Logs accumulate monotonically across the session. The /status endpoint
    // can return fewer (or zero) entries during the approval handoff window,
    // so we merge by id instead of overwriting.
    const renderedLogs = new Map();
    const expandedLogIds = new Set();
    const initialEntries = ${JSON.stringify(initialLogs)};
    for (const entry of initialEntries) {
      if (entry && entry.id != null) renderedLogs.set(String(entry.id), entry);
    }
    function approvalDetailsHtml(details) {
      if (!details) return '';
      const primary = details.draft
        ? { title: 'Draft', html: renderLogContentValue(details.draft, { forceMarkdown: true }) }
        : details.artifactUrl
          ? { title: 'Artifact', html: '<a class="approval-link" href="' + escapeText(details.artifactUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeText(details.artifactUrl) + '</a>' }
          : details.draftUrl
            ? { title: 'Draft', html: '<a class="approval-link" href="' + escapeText(details.draftUrl) + '" target="_blank" rel="noopener noreferrer">' + escapeText(details.draftUrl) + '</a>' }
            : details.summary
              ? { title: 'Review', html: renderLogContentValue(details.summary, { forceMarkdown: true }) }
              : null;
      const showSummary = details.summary && (!primary || primary.title !== 'Review');
      const links = [
        details.draftUrl ? '<a class="approval-link" href="' + escapeText(details.draftUrl) + '" target="_blank" rel="noopener noreferrer">Open draft</a>' : '',
        details.artifactUrl ? '<a class="approval-link" href="' + escapeText(details.artifactUrl) + '" target="_blank" rel="noopener noreferrer">Open artifact</a>' : ''
      ].filter(Boolean).join('');
      const sections = [];
      if (details.prompt) sections.push('<div class="approval-question">' + renderInlineMarkdown(details.prompt) + '</div>');
      if (details.context) sections.push('<section class="approval-section approval-context"><div class="approval-section-title">Source context</div><div class="approval-section-body">' + renderLogContentValue(details.context, { forceMarkdown: true }) + '</div></section>');
      if (primary) sections.push('<section class="approval-section approval-primary"><div class="approval-section-title">' + escapeText(primary.title) + '</div><div class="approval-section-body">' + primary.html + '</div></section>');
      if (links) sections.push('<section class="approval-section approval-links"><div class="approval-section-title">Links</div><div class="approval-link-row">' + links + '</div></section>');
      if (showSummary) sections.push('<section class="approval-section approval-secondary"><div class="approval-section-title">Why this request</div><div class="approval-section-body">' + renderLogContentValue(details.summary, { forceMarkdown: true }) + '</div></section>');
      if (details.risk) sections.push('<section class="approval-section approval-risk"><div class="approval-section-title">Risk / consequence</div><div class="approval-section-body">' + renderLogContentValue(details.risk, { forceMarkdown: true }) + '</div></section>');
      if (details.decisionStatus) {
        const reviewer = details.decisionReviewer ? ' by ' + details.decisionReviewer : '';
        sections.push('<section class="approval-section approval-decision"><div class="approval-section-title">Decision</div><div class="approval-section-body">' + escapeText(details.decisionStatus + reviewer) + '</div></section>');
      }
      if (details.decisionComment) sections.push('<section class="approval-section approval-secondary"><div class="approval-section-title">Comment</div><div class="approval-section-body">' + renderLogContentValue(details.decisionComment, { forceMarkdown: true }) + '</div></section>');
      if (details.errorMessage) sections.push('<section class="approval-section approval-risk"><div class="approval-section-title">Error</div><div class="approval-section-body">' + escapeText(details.errorMessage) + '</div></section>');
      if (sections.length === 0) return '';
      return '<div class="approval-card">' + sections.join('') + '</div>';
    }
    function toolDetailsHtml(details) {
      if (!details) return '';
      const rows = [];
      if (details.input) rows.push({ label: 'Input', value: details.input });
      if (details.output) rows.push({ label: 'Output', value: details.output });
      if (details.errorMessage) rows.push({ label: 'Error', value: details.errorMessage });
      if (rows.length === 0) return '';
      return '<div class="log-details">' + rows.map((row) =>
        '<div class="log-detail">' +
          '<div class="log-detail-label">' + escapeText(row.label) + '</div>' +
          '<div class="log-detail-value">' + renderLogContentValue(row.value) + '</div>' +
        '</div>'
      ).join('') + '</div>';
    }
    function logDetailsHtml(entry) {
      const details = entry && entry.details;
      if (!details) return '';
      return details.resumeToken ? approvalDetailsHtml(details) : toolDetailsHtml(details);
    }
    function objectValue(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    }
    function latestReviewerComment(logs) {
      if (!Array.isArray(logs)) return null;
      for (let i = logs.length - 1; i >= 0; i--) {
        const details = logs[i] && logs[i].details;
        if (details && typeof details.decisionComment === 'string' && details.decisionComment) {
          return {
            comment: details.decisionComment,
            reviewer: typeof details.decisionReviewer === 'string' ? details.decisionReviewer : '',
            status: typeof details.decisionStatus === 'string' ? details.decisionStatus : ''
          };
        }
      }
      return null;
    }
    function updateReviewerComment(logs) {
      if (!reviewerCommentEl || !reviewerCommentBodyEl || !reviewerCommentMetaEl) return;
      const latest = latestReviewerComment(logs);
      if (!latest) {
        reviewerCommentEl.setAttribute('hidden', '');
        reviewerCommentBodyEl.innerHTML = '';
        reviewerCommentMetaEl.textContent = '';
        return;
      }
      reviewerCommentEl.removeAttribute('hidden');
      reviewerCommentBodyEl.innerHTML = renderLogContentValue(latest.comment, { forceMarkdown: true });
      reviewerCommentMetaEl.textContent = latest.reviewer ? 'from ' + latest.reviewer : '';
    }
    function storeItemTitle(item) {
      if (item && typeof item.title === 'string' && item.title) return item.title;
      const data = objectValue(item && item.data);
      const keys = ['title', 'name', 'headline', 'subject', 'url'];
      for (const key of keys) {
        if (typeof data[key] === 'string' && data[key].trim()) return data[key].trim();
      }
      return item && item.id ? String(item.id) : 'Store item';
    }
    function storeItemPreview(item) {
      const data = objectValue(item && item.data);
      const keys = ['summary', 'description', 'note_excerpt', 'excerpt', 'draft', 'body', 'content', 'why_engage'];
      for (const key of keys) {
        if (typeof data[key] === 'string' && data[key].trim()) {
          const compact = data[key].trim().replace(/\\s+/g, ' ');
          return compact.length > 180 ? compact.slice(0, 180) + '…' : compact;
        }
      }
      const json = JSON.stringify(data);
      return json.length > 180 ? json.slice(0, 180) + '…' : json;
    }
    function storeEventHtml(entry) {
      if (!entry || typeof entry.tool !== 'string' || !entry.tool.startsWith('store_')) return '';
      if (!entry.message || !isJsonLikeContent(entry.message)) return '';
      let payload;
      try { payload = objectValue(JSON.parse(entry.message)); } catch { return ''; }
      const item = objectValue(payload.item);
      const store = typeof payload.store === 'string' && payload.store ? payload.store : '';
      const itemId = typeof payload.itemId === 'string' && payload.itemId
        ? payload.itemId
        : typeof item.id === 'string' && item.id
          ? item.id
          : '';
      const params = new URLSearchParams();
      if (project) params.set('project', project);
      if (itemId) params.set('highlight', itemId);
      const href = store ? '/stores/' + encodeURIComponent(store) + (params.toString() ? '?' + params.toString() : '') : '';
      const summary = item && typeof item.id === 'string'
        ? '<div class="store-event-title">' + escapeText(storeItemTitle(item)) + '</div>' +
          '<div class="store-event-meta">' +
            (item.type ? '<span>' + escapeText(item.type) + '</span>' : '') +
            (item.status ? '<span>' + escapeText(item.status) + '</span>' : '') +
            (itemId ? '<code>' + escapeText(itemId) + '</code>' : '') +
          '</div>' +
          '<div class="store-event-preview">' + escapeText(storeItemPreview(item)) + '</div>'
        : '<div class="store-event-title">' + escapeText(itemId || 'Store operation') + '</div>';
      return '<div class="store-event"><div>' +
        (store ? '<div class="store-event-store">Store: <code>' + escapeText(store) + '</code></div>' : '') +
        summary +
        '</div>' +
        (href ? '<a class="store-event-link" href="' + escapeText(href) + '">Open in Store</a>' : '') +
      '</div>';
    }
    function detailsKey(details) {
      return details ? JSON.stringify(details) : '';
    }
    function logActionsHtml(entry) {
      if (!pendingActionable) return '';
      if (entry.status !== 'pending' || !entry.details) return '';
      if (currentResumeToken && entry.details.resumeToken !== currentResumeToken) return '';
      return '<div class="log-actions" data-actions-row>' +
        '<div class="log-actions-hint">' +
          '<span class="kbd">⌘⏎</span> approve <span class="kbd">esc</span> reject <span class="kbd">c</span> comment' +
        '</div>' +
        '<div class="log-actions-buttons">' +
          '<button class="primary" data-action="approve">Approve</button>' +
          '<button class="danger" data-action="reject">Reject</button>' +
          '<button data-action="comment">Comment</button>' +
        '</div>' +
      '</div>';
    }
    function logEntryHtml(entry) {
      const isApprovalEntry = Boolean(entry.details && entry.details.resumeToken);
      const expandable = entry.type === 'tool' && !isApprovalEntry;
      const expanded = !expandable || entry.status === 'running' || expandedLogIds.has(String(entry.id));
      const resumeTokenAttr = entry.details && entry.details.resumeToken
        ? ' data-resume-token="' + escapeText(entry.details.resumeToken) + '"'
        : '';
      const storeHtml = storeEventHtml(entry);
      const markerHtml = entry.status === 'streaming' || entry.status === 'running'
        ? '<span class="log-spinner" aria-label="streaming"></span>'
        : '⋮';
      return '<li class="log-item ' + escapeText(entry.status || '') + (expandable ? ' expandable' : '') + (expanded ? ' expanded' : '') + '" data-log-id="' + escapeText(entry.id) + '" data-log-type="' + escapeText(entry.type) + '"' + resumeTokenAttr + (expandable ? ' aria-expanded="' + String(expanded) + '" tabindex="0"' : '') + '>' +
        '<span class="log-time">' + escapeText(formatTime(entry.time)) + '</span>' +
        '<span class="log-marker">' + markerHtml + '</span>' +
        '<span class="log-main"><span class="log-title">' + escapeText(entry.title) + '</span>' +
        '<span class="log-content">' +
        storeHtml +
        logDetailsHtml(entry) +
        (entry.message && !storeHtml ? renderLogContentValue(entry.message, { forceMarkdown: entry.type === 'text' }) : '') +
        '</span>' +
        logActionsHtml(entry) +
        '</span></li>';
    }
    function renderLogs(logs, force) {
      const shouldFollowEnd = isNearPageEnd();
      let changed = Boolean(force);
      if (Array.isArray(logs)) {
        for (const entry of logs) {
          if (!entry || entry.id == null) continue;
          const key = String(entry.id);
          const prior = renderedLogs.get(key);
          // Update if new, or if state changed (e.g. tool: pending -> completed).
          if (!prior
            || prior.status !== entry.status
            || prior.message !== entry.message
            || prior.title !== entry.title
            || detailsKey(prior.details) !== detailsKey(entry.details)) {
            renderedLogs.set(key, entry);
            changed = true;
          }
        }
      }
      if (renderedLogs.size === 0) {
        logsEl.innerHTML = '<li class="log-empty">No session events yet.</li>';
        return;
      }
      if (!changed) return;
      const ordered = [...renderedLogs.values()].sort((a, b) => (a.time ?? 0) - (b.time ?? 0));
      logsEl.innerHTML = ordered.map(logEntryHtml).join('');
      updateReviewerComment(ordered);
      scrollToPageEnd({ follow: shouldFollowEnd });
    }
    // Passive sessions open at the top and must not auto-jump to the bottom on
    // the first log render; seed as already-handled so a non-follow render is a
    // no-op. (A user who scrolls to the bottom still gets live follow.) When
    // there is an active gate we force-scroll to it instead.
    let hasScrolledToPageEnd = !pendingActionable;
    function isNearPageEnd() {
      const page = document.documentElement;
      return window.innerHeight + window.scrollY >= page.scrollHeight - 240;
    }
    function scrollToPageEnd(options) {
      const force = Boolean(options && options.force);
      const follow = Boolean(options && options.follow);
      if (!force && hasScrolledToPageEnd && !follow) return;
      hasScrolledToPageEnd = true;
      window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
      requestAnimationFrame(function () {
        window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'auto' });
      });
    }
    function formatExpires(value) {
      if (typeof value !== 'number') return '';
      try { return new Date(value).toLocaleString(); } catch { return String(value); }
    }
    // Swap the active gate's panels (prompt, summary/context/risk, expires) and
    // re-enable the action buttons. Called when a fresh await_human gate opens
    // mid-session — the page stays put so the session log keeps full history,
    // but the actionable surface refreshes for the new gate.
    function renderActiveGate(approval) {
      const expiresCell = document.getElementById('expires-cell');
      const expiresValue = document.getElementById('expires-value');
      if (expiresCell && expiresValue) {
        if (typeof approval.expiresAt === 'number') {
          expiresCell.removeAttribute('hidden');
          expiresValue.textContent = formatExpires(approval.expiresAt);
        } else {
          expiresCell.setAttribute('hidden', '');
          expiresValue.textContent = '';
        }
      }
      const result = document.getElementById('result');
      if (result) { result.textContent = ''; result.className = 'notice'; }
      const commentInput = document.getElementById('comment');
      if (commentInput) commentInput.value = '';
      submittingDecision = false;
      for (const b of document.querySelectorAll('button[data-action]')) b.disabled = false;
      // Keep the URL in sync so a refresh lands on the active gate.
      if (approval.approvalUrl) {
        try { history.replaceState(null, '', approval.approvalUrl); } catch {}
      }
      scrollToPageEnd({ force: true });
    }
    function isLiveStatus(status, logs) {
      if (status === 'completed' || status === 'error' || status === 'expired' || status === 'failed' || status === 'stopped' || status === 'timeout') return false;
      if (status === 'run' || status === 'running' || status === 'resuming' || status === 'continuing') return true;
      return Array.isArray(logs) && logs.some(function (entry) {
        return entry && (entry.status === 'streaming' || entry.status === 'running');
      });
    }
    function isEndedStatus(status) {
      return status === 'completed' || status === 'error' || status === 'stopped' || status === 'timeout';
    }
    function displaySessionStatus(status, approval) {
      const code = approval && typeof approval.errorCode === 'string' ? approval.errorCode : '';
      if (status === 'error' && code === 'USER_STOPPED') return 'stopped';
      if (status === 'error' && code === 'TIMEOUT') return 'timeout';
      return status;
    }
    function sessionErrorText(approval) {
      if (!approval || approval.sessionStatus !== 'error') return '';
      const code = typeof approval.errorCode === 'string' ? approval.errorCode : '';
      const message = typeof approval.errorMessage === 'string' ? approval.errorMessage : '';
      if (code === 'USER_STOPPED') return message || 'Session stopped by user.';
      if (code === 'TIMEOUT') return message || 'Session timed out.';
      if (!code && !message) return 'Session finished with an error. Check the session log for details.';
      return 'Session finished with an error: ' + [code, message].filter(Boolean).join(': ');
    }
    let submittingStop = false;
    function updateContinuationSurface(status, approval, logs) {
      const live = isLiveStatus(status, logs);
      const sessionStatus = approval && approval.sessionStatus ? approval.sessionStatus : status;
      const hasAgentFile = Boolean(approval && approval.agent && approval.agent.filePath);
      continueActionable = isEndedStatus(sessionStatus) && !live && hasAgentFile;
      stopActionable = !isEndedStatus(sessionStatus) && !submittingStop;

      if (continuePanel && continueInput && continueSubmit) {
        if (continueActionable) {
          submittingContinue = false;
          continuePanel.removeAttribute('hidden');
          continueInput.disabled = false;
          continueSubmit.disabled = false;
        } else {
          continuePanel.setAttribute('hidden', '');
          continueInput.disabled = true;
          continueSubmit.disabled = true;
        }
      }

      if (stopPanel && stopSubmit) {
        if (stopActionable) {
          stopPanel.removeAttribute('hidden');
          stopSubmit.disabled = false;
        } else {
          stopPanel.setAttribute('hidden', '');
          stopSubmit.disabled = true;
        }
      }

      if (inactiveBanner) {
        if (pendingActionable || continueActionable || stopActionable || live) {
          inactiveBanner.setAttribute('hidden', '');
        } else {
          inactiveBanner.removeAttribute('hidden');
        }
      }

      // The session log only spins on entries that are actively streaming/running.
      // Between steps (the agent deciding the next tool call) no entry spins, yet
      // the run is still live — keep a persistent indicator at the end of the log
      // so a scrolled-down viewer always sees that work is in progress. Hidden
      // once an approval gate opens, since that surface signals "your turn".
      if (workingIndicator) {
        if (live && !pendingActionable) {
          workingIndicator.removeAttribute('hidden');
        } else {
          workingIndicator.setAttribute('hidden', '');
        }
      }
    }
    let refreshTimer = null;
    function scheduleRefresh(delay) {
      if (refreshTimer) clearTimeout(refreshTimer);
      refreshTimer = setTimeout(refreshStatus, delay);
    }
    async function submitStop() {
      if (submittingStop || !stopSubmit) return;
      submittingStop = true;
      stopActionable = false;
      stopSubmit.disabled = true;
      const result = document.getElementById('result');
      if (result) {
        result.textContent = '⋮ stopping session…';
        result.className = 'notice';
      }
      try {
        const response = await fetch(location.pathname + '/stop' + (token ? '?token=' + encodeURIComponent(token) : ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            project,
            reason: 'Stopped from session UI'
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message || 'Stop failed');
        if (result) {
          result.textContent = '✓ session stopped. Running subagents were stopped too.';
          result.className = 'notice';
        }
        statusEl.textContent = 'stopped';
        statusEl.className = 'status stopped';
        stopPanel?.setAttribute('hidden', '');
        continuePanel?.setAttribute('hidden', '');
        workingIndicator?.setAttribute('hidden', '');
        refreshStatus();
      } catch (err) {
        if (result) {
          result.textContent = err.message || String(err);
          result.className = 'notice error';
        }
        submittingStop = false;
        stopActionable = true;
        stopSubmit.disabled = false;
      }
    }
    async function refreshStatus() {
      let nextDelay = 1500;
      try {
        // LEGACY ROUTES: this page fetches its sibling action endpoints by relative
        // path (/approvals/:id/{status,decision,continue}). Canonical paths are
        // /api/approvals/:id/*. Kept relative for back-compat (relative path also
        // preserves nothing but the ?token query we re-add); migrate when legacy
        // routes are removed.
        const url = new URL(location.pathname + '/status', location.origin);
        url.searchParams.set('token', token);
        if (project) url.searchParams.set('project', project);
        const response = await fetch(url);
        const payload = await response.json();
        if (!response.ok || !payload.success) return;
        const rawStatus = payload.status || payload.approval?.sessionStatus || 'unknown';
        const status = displaySessionStatus(rawStatus, payload.approval);
        statusEl.textContent = status;
        statusEl.className = 'status ' + status;
        const nextToken = payload.approval?.currentResumeToken;
        const approvalWaiting = status === 'waiting' || payload.approval?.sessionStatus === 'suspended';
        let forceLogRender = false;
        if (nextToken && nextToken !== currentResumeToken && approvalWaiting) {
          currentResumeToken = nextToken;
          pendingActionable = true;
          forceLogRender = true;
          renderActiveGate(payload.approval);
        } else {
          pendingActionable = Boolean(nextToken && approvalWaiting);
        }
        const logs = payload.logs || payload.approval?.logs || [];
        renderLogs(logs, forceLogRender);
        updateContinuationSurface(status, payload.approval, logs);
        const resultEl = document.getElementById('result');
        const transitionResult = /submitting decision|decision recorded|resuming the session|continuing session|follow-up recorded/.test(resultEl?.textContent || '');
        const errorText = sessionErrorText(payload.approval);
        if (resultEl && (status === 'error' || payload.approval?.sessionStatus === 'error')) {
          resultEl.textContent = errorText || 'Session finished with an error. Check the latest log entry for details.';
          resultEl.className = 'notice error';
        } else if (resultEl && status === 'completed' && transitionResult) {
          resultEl.textContent = '✓ session completed.';
          resultEl.className = 'notice';
        }
        nextDelay = isLiveStatus(status, logs) ? 500 : 1500;
      } catch {}
      scheduleRefresh(nextDelay);
    }
    refreshStatus();
    // Only auto-scroll to the bottom when there is an active approval gate to
    // act on (it renders at the end of the log). A finished/passive session
    // opens at the top so the run reads from the beginning.
    if (pendingActionable) scrollToPageEnd({ force: true });

    let submittingDecision = false;
    let submittingContinue = false;
    async function submitDecision(actionId, opts) {
      if (submittingDecision) return;
      const button = document.querySelector('button[data-action="' + actionId + '"]');
      if (!button || button.disabled) return;
      submittingDecision = true;
      for (const b of document.querySelectorAll('button[data-action]')) b.disabled = true;
      const result = document.getElementById('result');
      result.textContent = '⋮ submitting decision…';
      result.className = 'notice';
      try {
        const response = await fetch(location.pathname + '/decision' + (token ? '?token=' + encodeURIComponent(token) : ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            status: actionId,
            comment: opts && opts.comment ? opts.comment : undefined,
            resumeToken: currentResumeToken,
            project
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message || 'Approval failed');
        if (actionId === 'comment' && commentInput) commentInput.value = '';
        result.textContent = '✓ decision recorded — agentuse is resuming the session.';
        statusEl.textContent = 'resuming';
        statusEl.className = 'status resuming';
        refreshStatus();
      } catch (err) {
        result.textContent = err.message || String(err);
        result.className = 'notice error';
        submittingDecision = false;
        for (const b of document.querySelectorAll('button[data-action]')) b.disabled = false;
      }
    }

    async function submitContinue() {
      if (submittingContinue || !continueActionable || !continueInput || !continueSubmit) return;
      const prompt = String(continueInput.value || '').trim();
      if (!prompt) {
        continueInput.focus();
        return;
      }
      submittingContinue = true;
      continueInput.disabled = true;
      continueSubmit.disabled = true;
      const result = document.getElementById('result');
      result.textContent = '⋮ continuing session…';
      result.className = 'notice';
      try {
        const response = await fetch(location.pathname + '/continue' + (token ? '?token=' + encodeURIComponent(token) : ''), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            prompt,
            resumeToken: currentResumeToken,
            project
          })
        });
        const payload = await response.json();
        if (!response.ok) throw new Error(payload?.error?.message || 'Continue failed');
        result.textContent = '✓ follow-up recorded — agentuse is continuing the session.';
        statusEl.textContent = payload.status || 'continuing';
        statusEl.className = 'status ' + (payload.status || 'continuing');
        continueInput.value = '';
        continuePanel?.setAttribute('hidden', '');
        refreshStatus();
      } catch (err) {
        result.textContent = err.message || String(err);
        result.className = 'notice error';
        submittingContinue = false;
        if (continueActionable) {
          continueInput.disabled = false;
          continueSubmit.disabled = false;
        }
      }
    }

    // comment dialog
    const commentDialog = document.getElementById('comment-dialog');
    const commentInput = document.getElementById('comment');
    function openCommentDialog() {
      if (!commentDialog) return;
      if (typeof commentDialog.showModal === 'function') commentDialog.showModal();
      else commentDialog.setAttribute('open', '');
      requestAnimationFrame(() => commentInput?.focus());
    }
    function closeCommentDialog() {
      if (!commentDialog) return;
      if (typeof commentDialog.close === 'function') commentDialog.close();
      else commentDialog.removeAttribute('open');
    }
    async function submitComment() {
      const text = (commentInput?.value || '').trim();
      if (!text) { commentInput?.focus(); return; }
      closeCommentDialog();
      await submitDecision('comment', { comment: text });
    }
    if (commentDialog) {
      for (const el of commentDialog.querySelectorAll('[data-comment-cancel]')) {
        el.addEventListener('click', closeCommentDialog);
      }
      const submitBtn = commentDialog.querySelector('[data-comment-submit]');
      submitBtn?.addEventListener('click', submitComment);
      // click outside dialog content closes it
      commentDialog.addEventListener('click', (e) => {
        if (e.target === commentDialog) closeCommentDialog();
      });
      commentInput?.addEventListener('keydown', (e) => {
        if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') { e.preventDefault(); submitComment(); }
      });
    }
    continueSubmit?.addEventListener('click', submitContinue);
    stopSubmit?.addEventListener('click', submitStop);
    continueInput?.addEventListener('keydown', (e) => {
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        submitContinue();
      }
    });

    function toggleLogEntry(item) {
      if (!item || !item.classList.contains('expandable')) return;
      const id = item.dataset.logId;
      const next = !item.classList.contains('expanded');
      item.classList.toggle('expanded', next);
      item.setAttribute('aria-expanded', String(next));
      if (id) {
        if (next) expandedLogIds.add(id);
        else expandedLogIds.delete(id);
      }
    }

    // Buttons and expandable rows are re-rendered with the log on every poll, so
    // use delegation anchored at the logs container.
    logsEl.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target.closest('button[data-action]') : null;
      if (target) {
        if (target.disabled) return;
        const action = target.dataset.action;
        if (!action) return;
        if (action === 'comment') openCommentDialog();
        else submitDecision(action);
        return;
      }
      const link = e.target instanceof Element ? e.target.closest('a') : null;
      if (link) return;
      const item = e.target instanceof Element ? e.target.closest('.log-item.expandable') : null;
      toggleLogEntry(item);
    });
    logsEl.addEventListener('keydown', (e) => {
      if (e.key !== 'Enter' && e.key !== ' ') return;
      const item = e.target instanceof Element ? e.target.closest('.log-item.expandable') : null;
      if (!item || e.target !== item) return;
      e.preventDefault();
      toggleLogEntry(item);
    });

    // keyboard shortcuts (only when no dialog is open and not typing in a field):
    //   cmd/ctrl+Enter → approve, Esc → reject, c → comment
    document.addEventListener('keydown', (e) => {
      if (commentDialog?.open) return;
      const target = e.target;
      const inField = target && (target.tagName === 'TEXTAREA' || target.tagName === 'INPUT');
      if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        e.preventDefault();
        const approve = document.querySelector('button[data-action="approve"]');
        if (approve && !approve.disabled) submitDecision('approve');
      } else if (e.key === 'Escape' && !inField) {
        const reject = document.querySelector('button[data-action="reject"]');
        if (reject && !reject.disabled) submitDecision('reject');
      } else if ((e.key === 'c' || e.key === 'C') && !inField && !e.metaKey && !e.ctrlKey && !e.altKey) {
        const comment = document.querySelector('button[data-action="comment"]');
        if (comment && !comment.disabled) { e.preventDefault(); openCommentDialog(); }
      }
    });

    // copy-to-clipboard for the session id and file path
    document.addEventListener('click', (e) => {
      const btn = e.target && e.target.closest ? e.target.closest('.copy-btn') : null;
      if (!btn) return;
      e.preventDefault();
      const value = btn.getAttribute('data-copy') || '';
      const flash = () => { btn.classList.add('copied'); setTimeout(() => btn.classList.remove('copied'), 1200); };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(value).then(flash).catch(() => {});
      } else {
        const ta = document.createElement('textarea');
        ta.value = value;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); flash(); } catch (err) {}
        document.body.removeChild(ta);
      }
    });
  </script>
</body>
</html>`;
}

/**
 * Back-compat alias for the legacy approval page. The unified session page
 * (renderSessionPage) defaults `canAct` to true, so this renders identically to
 * the historical `/approvals/:id` page. Retained for the transition `/approvals`
 * routes and existing tests.
 */
function renderApprovalPage(options: SessionPageOptions): string {
  return renderSessionPage(options);
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

      const resolveResumeProject = (projectId?: string): Project | undefined => {
        return projectId
          ? projectsById.get(projectId)
          : (effectiveDefault ? projectsById.get(effectiveDefault) : projects[0]);
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
        const selectedProjects = options.projectId
          ? projects.filter((project) => project.id === options.projectId)
          : (effectiveDefault ? [projectsById.get(effectiveDefault)!] : projects);

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
          : (effectiveDefault ? [projectsById.get(effectiveDefault)!] : projects);

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
            nonSessionErrors.push({ status: 500, code: info.error.code, message: info.error.message });
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

        const project = resolveResumeProject(decision.projectId);
        if (!project) {
          throw new Error(`Project not found for Slack approval resume: ${decision.projectId ?? 'default'}`);
        }

        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          throw new Error(`No worker for project ${project.id}`);
        }

        const activeKey = `${project.id}:${decision.sessionId}`;
        const existingResume = activeApprovalResumes.get(activeKey);
        if (existingResume) {
          await existingResume;
          return;
        }

        const resumePromise = Promise.resolve().then(async () => {
          const info = await projectWorker.getApprovalInfo({
            projectRoot: project.root,
            sessionId: decision.sessionId,
            resumeToken: decision.resumeToken,
            allowHistorical: true
          });
          if (info.success && info.approval.sessionStatus === 'completed') {
            approvalLog.resumeCompleted(decision.sessionId, 0);
            return;
          }

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
          ...(approval.channelMessage.url && { approvalUrl: approval.channelMessage.url }),
          ...(approval.expiresAt && { expiresAt: new Date(approval.expiresAt).toISOString() }),
          status,
          decision,
          ...(error !== undefined && { error })
        }).catch((err) => logger.warn(`Slack approval status update failed: ${(err as Error).message}`));
      };

      const postSlackApprovalThreadNote = (
        approval: ApprovalSummary,
        message: string,
        approvalUrl?: string
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
                text: approvalUrl
                  ? `*AgentUse processed your comment.*\nThe agent updated the work and requested another approval.`
                  : `*AgentUse processed your comment.*\nThe agent continued after receiving the feedback.`
              }
            },
            ...(approvalUrl ? [{
              type: 'actions',
              elements: [{
                type: 'button',
                text: {
                  type: 'plain_text',
                  text: 'Review latest approval'
                },
                url: approvalUrl,
                style: 'primary'
              }]
            }] : [])
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
                postSlackApprovalThreadNote(
                  approval,
                  nextApprovalUrl
                    ? 'AgentUse processed your comment and requested another approval.'
                    : 'AgentUse processed your comment and continued the session.',
                  nextApprovalUrl
                );
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

      const APPROVAL_SWEEP_INTERVAL_MS = 60_000;
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

          sendHTML(res, 200, renderHomePage({
            version: packageVersion,
            defaultProject,
            projects: projectInfo,
            multiProject,
          }));
          return;
        }

        if (req.method === "GET" && routePath === '/agents') {
          const { agents, errors } = await collectAgents(projects);
          if (isApi) {
            sendJSON(res, 200, { success: true, agents, errors });
            return;
          }
          sendHTML(res, 200, renderAgentsPage({ agents, errors, multiProject }));
          return;
        }

        if (req.method === "GET" && routePath === '/schedules') {
          const schedules = scheduler.listSerialized();
          if (isApi) {
            sendJSON(res, 200, { success: true, schedules });
            return;
          }
          sendHTML(res, 200, renderSchedulesPage({ schedules, multiProject, sessionToken: (sessionId: string) => sessionViewToken(sessionId, apiKey) }));
          return;
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

          sendHTML(res, 200, renderStoresIndexPage({ stores, errors, multiProject: selectedProjects.length > 1 }));
          return;
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

          const highlight = requestUrl.searchParams.get('highlight') ?? undefined;
          sendHTML(res, 200, renderStoreItemsPage({
            storeName,
            rows,
            errors,
            ...(highlight ? { highlight } : {}),
            multiProject: selectedProjects.length > 1,
          }));
          return;
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

          sendHTML(res, 200, renderStoreItemDetailPage({
            storeName,
            projectId: found.projectId,
            item: found.item
          }));
          return;
        }

        // GET /sessions (+ /api/sessions): operator surface listing every run.
        // API-key gated (not a capability route). Filters: ?agent= ?trigger=
        // ?days=<n|all> (default window mirrors the approvals list).
        if (req.method === "GET" && routePath === '/sessions') {
          const agentFilter = requestUrl.searchParams.get('agent') ?? undefined;
          const triggerFilterRaw = requestUrl.searchParams.get('trigger') ?? undefined;
          const triggerFilter: SessionTrigger | undefined =
            triggerFilterRaw === 'scheduled' || triggerFilterRaw === 'manual' || triggerFilterRaw === 'slack' || triggerFilterRaw === 'api'
              ? triggerFilterRaw
              : undefined;
          const createdAfter = approvalListCreatedAfter(requestUrl);

          type SessionRow = { projectId: string; multiProject: boolean; session: SessionSummary };
          const rows: SessionRow[] = [];
          const errors: Array<{ projectId: string; message: string }> = [];

          const projectResults = await Promise.all(projects.map(async (project) => {
            const projectWorker = workers.get(project.id);
            if (!projectWorker) {
              return { project, error: 'Worker unavailable' };
            }
            const result = await projectWorker.listSessions(
              project.root,
              createdAfter === undefined ? {} : { createdAfter }
            );
            if (!result.success) {
              return { project, error: result.error.message };
            }
            return { project, sessions: result.sessions };
          }));

          for (const result of projectResults) {
            if (result.error) {
              errors.push({ projectId: result.project.id, message: result.error });
              continue;
            }
            for (const session of result.sessions ?? []) {
              if (agentFilter && session.agent.id !== agentFilter) continue;
              if (triggerFilter && session.trigger !== triggerFilter) continue;
              rows.push({ projectId: result.project.id, multiProject, session });
            }
          }

          rows.sort((a, b) => b.session.createdAt - a.session.createdAt);

          if (isApi) {
            sendJSON(res, 200, {
              success: true,
              sessions: rows.map((row) => ({ project: row.projectId, ...row.session })),
              window: {
                days: requestUrl.searchParams.get('days') === 'all' ? 'all' : Math.floor((Date.now() - createdAfter!) / (24 * 60 * 60 * 1000)),
                ...(createdAfter !== undefined && { createdAfter })
              },
              ...(agentFilter && { agent: agentFilter }),
              ...(triggerFilter && { trigger: triggerFilter }),
              errors
            });
            return;
          }

          sendHTML(res, 200, renderSessionsListPage({
            rows,
            errors,
            multiProject,
            ...(agentFilter && { agentFilter }),
            ...(triggerFilter && { triggerFilter }),
            sessionToken: (sessionId: string) => sessionViewToken(sessionId, apiKey),
          }));
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
        const sessionPageMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)$/) : null;
        if (sessionPageMatch) {
          const sessionId = decodeURIComponent(sessionPageMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;

          let authorized = sessionAuthorized(sessionId, token);
          // Transition: old Slack links carry a gate resumeToken. Accept any
          // token that matches a gate ever issued for THIS session as a session
          // credential until those approvals expire. This is not an escalation:
          // the legacy /approvals/:id?token=<resumeToken> page already granted
          // approve to the same holder; we preserve that capability here.
          if (!authorized && token) {
            const legacy = await findApprovalInfo({ ...(projectId && { projectId }), sessionId, resumeToken: token, allowHistorical: true });
            authorized = legacy.success;
          }
          if (!authorized) {
            sendHTML(res, 401, '<!doctype html><title>AgentUse Session</title><p>Not authorized to view this session. A valid token or API key is required.</p>');
            return;
          }

          const found = await findSessionInfo(sessionId, projectId);
          if (!found.success) {
            sendHTML(res, found.status, `<!doctype html><title>AgentUse Session</title><p>${escapeHtml(found.message)}</p>`);
            return;
          }

          const activeKey = `${found.project.id}:${sessionId}`;
          // Always embed the canonical session token so the page's own fetches
          // (status poll, decision, continue) authorize via ?token=, even when
          // the viewer authenticated with an Authorization header the browser
          // will not resend. Empty on local (no api key), where links omit it.
          const pageToken = sessionViewToken(sessionId, apiKey);
          sendHTML(res, 200, renderSessionPage({
            approval: found.info.approval,
            token: pageToken,
            projectId: found.project.id,
            childSessionToken: (childSessionId) => sessionViewToken(childSessionId, apiKey),
            resuming: activeApprovalResumes.has(activeKey),
            continuing: activeSessionContinuations.has(activeKey),
            canAct: true,
          }));
          return;
        }

        // GET /sessions/:id/status: live status poll for the session page.
        const sessionStatusMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/status$/) : null;
        if (sessionStatusMatch) {
          const sessionId = decodeURIComponent(sessionStatusMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;
          if (!sessionAuthorized(sessionId, token)) {
            sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
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
          type ProjectRow = { projectId: string; multiProject: boolean; approval: ApprovalSummary };
          const rows: ProjectRow[] = [];
          const errors: Array<{ projectId: string; message: string }> = [];
          const createdAfter = approvalListCreatedAfter(requestUrl);

          const projectResults = await Promise.all(projects.map(async (project) => {
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
              rows.push({ projectId: result.project.id, multiProject, approval });
            }
          }

          const buckets = {
            pending: rows
              .filter((r) => r.approval.status === 'pending')
              .sort((a, b) => (a.approval.expiresAt ?? Number.MAX_SAFE_INTEGER) - (b.approval.expiresAt ?? Number.MAX_SAFE_INTEGER)),
            completed: rows
              .filter((r) => r.approval.status === 'approved' || r.approval.status === 'rejected' || r.approval.status === 'commented')
              .sort((a, b) => (b.approval.decisionAt ?? 0) - (a.approval.decisionAt ?? 0)),
            expired: rows
              .filter((r) => r.approval.status === 'expired' || r.approval.status === 'errored')
              .sort((a, b) => (b.approval.decisionAt ?? b.approval.expiresAt ?? 0) - (a.approval.decisionAt ?? a.approval.expiresAt ?? 0))
          };

          if (isApi) {
            const serializeRow = (row: ProjectRow) => ({
              project: row.projectId,
              ...row.approval
            });
            sendJSON(res, 200, {
              success: true,
              approvals: rows.map(serializeRow),
              buckets: {
                pending: buckets.pending.map(serializeRow),
                completed: buckets.completed.map(serializeRow),
                expired: buckets.expired.map(serializeRow)
              },
              window: {
                days: requestUrl.searchParams.get('days') === 'all' ? 'all' : Math.floor((Date.now() - createdAfter!) / (24 * 60 * 60 * 1000)),
                ...(createdAfter !== undefined && { createdAfter })
              },
              errors
            });
            return;
          }

          sendHTML(res, 200, renderApprovalsListPage({ buckets, errors, multiProject }));
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
            const project = resolveResumeProject(projectId);

            if (!project) {
              sendError(res, 404, "PROJECT_NOT_FOUND", "Project not found for resume request");
              return;
            }

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

      // Kick off approval expiration sweep: once at startup, then on a fixed interval.
      void runApprovalSweep();
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
  renderHomePage,
  renderApprovalPage,
  renderSessionPage,
  renderSessionTimeline,
  renderSessionsListPage,
  isHeaderGateExemptRoute,
  renderStoresIndexPage,
  renderAgentsPage,
  renderSchedulesPage,
  collectAgents,
  formatAgentsTable,
  formatSchedulesTable,
  canContinueApprovalSession,
  isEndedSessionStatus,
  approvalListCreatedAfter,
};
