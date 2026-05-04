import { Command } from "commander";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { resolve, basename, relative } from "path";
import { existsSync } from "fs";
import { glob } from "glob";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import chalk from "chalk";
import * as dotenv from "dotenv";
import { parseAgent } from "../parser";
import { type AgentChunk } from "../runner";
import { resolveProjectContext } from "../utils/project";
import { logger, LogLevel, executionLog, approvalLog } from "../utils/logger";
import { printLogo } from "../utils/branding";
import { initStorage } from "../storage/index.js";
import { Scheduler, type Schedule } from "../scheduler";
import { FileWatcher } from "../watcher";
import { telemetry, parseModel } from "../telemetry";
import { version as packageVersion } from "../../package.json";
import { registerServer, unregisterServer, updateServer, listServers, formatUptime, getDefaultLogFilePath, type ServerEntry, type ServerProjectEntry } from "../utils/server-registry";
import { startLogFile, type LogFileHandle } from "../utils/log-file";
import { loadGlobalConfig, expandHome, getGlobalConfigPath, getGlobalEnvPath, loadGlobalEnv, type GlobalConfig } from "../utils/global-config";
import { SlackApprovalSocket, updateSlackApprovalRequestStatus, type SlackApprovalDecision } from "../slack/approval";
import { homedir } from "os";

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
  notification?: { type?: string; channel?: string; ts?: string; url?: string };
}

interface WorkerSweepExpiredResult {
  success: true;
  expired: ExpiredApproval[];
}

type ApprovalSummaryStatus = 'pending' | 'approved' | 'rejected' | 'commented' | 'expired' | 'errored';

interface ApprovalSummary {
  sessionId: string;
  agentId: string;
  agentName: string;
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
  errorMessage?: string;
  notification?: { type?: string; channel?: string; ts?: string; url?: string };
}

interface WorkerListApprovalsResult {
  success: true;
  approvals: ApprovalSummary[];
}

interface ApprovalPageInfo {
  sessionId: string;
  sessionStatus: string;
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
  actions?: Array<{ id: string; label: string; style?: 'primary' | 'danger' }>;
  channel?: string;
  approvalUrl?: string;
  currentResumeToken?: string;
  expiresAt?: number;
  suspendedAt?: number;
  notification?: {
    type?: string;
    channel?: string;
    ts?: string;
    url?: string;
  };
  decision?: unknown;
  logs?: ApprovalLogEntry[];
}

interface ApprovalLogEntry {
  id: string;
  type: string;
  status?: string;
  title: string;
  message?: string;
  time?: number;
  details?: ApprovalLogDetails;
}

interface ApprovalLogDetails {
  resumeToken?: string;
  prompt?: string;
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
    resolve: (value: WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSweepExpiredResult | WorkerListApprovalsResult) => void;
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
    }) as Promise<WorkerExecuteResult | WorkerExecuteError>;
  }

  getApprovalInfo(options: {
    projectRoot: string;
    sessionId: string;
    resumeToken?: string;
    allowHistorical?: boolean;
  }): Promise<WorkerApprovalInfoResult | WorkerExecuteError> {
    return this.request({
      type: "approval-info",
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      resumeToken: options.resumeToken,
      allowHistorical: options.allowHistorical ?? false,
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

  listApprovals(projectRoot: string): Promise<WorkerListApprovalsResult | WorkerExecuteError> {
    return this.request({
      type: "list-approvals",
      projectRoot,
      timeout: 30,
    }) as Promise<WorkerListApprovalsResult | WorkerExecuteError>;
  }

  private request(options: Record<string, unknown> & { timeout?: number | undefined }): Promise<WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSweepExpiredResult | WorkerListApprovalsResult> {
    return new Promise((resolve) => {
      if (!this.process || !this.ready) {
        resolve({
          success: false,
          error: { code: "WORKER_NOT_READY", message: "Worker process not ready" },
        });
        return;
      }

      const id = `req-${++this.requestCounter}`;
      const timeoutMs = (options.timeout ?? 300) * 1000 + 5000; // Add 5s buffer

      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          pending.resolve({
            success: false,
            error: { code: "TIMEOUT", message: `Request timed out after ${options.timeout ?? 300}s` },
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
  res.writeHead(status, { "Content-Type": "text/html; charset=utf-8" });
  res.end(html);
}

function wantsJson(requestUrl: URL, req: IncomingMessage): boolean {
  if (requestUrl.searchParams.get('format') === 'json') return true;
  const accept = req.headers.accept;
  return typeof accept === 'string' && accept.split(',').some(value => value.trim().startsWith('application/json'));
}

function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function formatApprovalTime(value?: number): string {
  return value ? new Date(value).toLocaleString() : 'Unknown';
}

function formatLogTime(value?: number): string {
  return value ? new Date(value).toLocaleTimeString() : '';
}

function approvalActionList(actions?: ApprovalPageInfo['actions']): Array<{ id: string; label: string; style?: 'primary' | 'danger' }> {
  return actions && actions.length > 0
    ? actions
    : [
      { id: 'approve', label: 'Approve', style: 'primary' },
      { id: 'reject', label: 'Reject', style: 'danger' },
      { id: 'comment', label: 'Comment' }
    ];
}

function renderLogItems(
  logs?: ApprovalLogEntry[],
  options?: { actions?: ApprovalActionDef[]; actionable?: boolean; currentResumeToken?: string | undefined }
): string {
  if (!logs || logs.length === 0) {
    return '<li class="log-empty">No session events yet.</li>';
  }
  const actions = options?.actions ?? [];
  const actionable = options?.actionable ?? false;
  const currentResumeToken = options?.currentResumeToken;
  return logs.map((entry) => {
    const showActions = actionable &&
      entry.status === 'pending' &&
      Boolean(entry.details) &&
      (!currentResumeToken || entry.details?.resumeToken === currentResumeToken);
    return `
        <li class="log-item ${escapeHtml(entry.status ?? '')}">
          <span class="log-time">${escapeHtml(formatLogTime(entry.time))}</span>
          <span class="log-marker">⋮</span>
          <span class="log-main">
            <span class="log-title">${escapeHtml(entry.title)}</span>
            ${entry.details ? renderApprovalDetailBlock(entry.details) : ''}
            ${showActions ? renderInlineActions(actions) : ''}
            ${entry.message ? `<pre>${escapeHtml(entry.message)}</pre>` : ''}
          </span>
        </li>`;
  }).join('');
}

type ApprovalActionDef = { id: string; label: string; style?: 'primary' | 'danger' };

function renderInlineActions(actions: ApprovalActionDef[]): string {
  if (actions.length === 0) return '';
  return `<div class="log-actions" data-actions-row>
    <div class="log-actions-hint">
      <span class="kbd">⌘⏎</span> approve <span class="kbd">esc</span> reject <span class="kbd">c</span> comment
    </div>
    <div class="log-actions-buttons">
      ${actions.map(action => `<button class="${escapeHtml(action.style ?? '')}" data-action="${escapeHtml(action.id)}">${escapeHtml(action.label)}</button>`).join('')}
    </div>
  </div>`;
}

function renderApprovalDetailBlock(details: ApprovalLogDetails): string {
  const rows: Array<{ label: string; value: string; mode?: 'text' | 'link' }> = [];
  if (details.prompt) rows.push({ label: 'prompt', value: details.prompt });
  if (details.summary) rows.push({ label: 'summary', value: details.summary });
  if (details.context) rows.push({ label: 'context', value: details.context });
  if (details.risk) rows.push({ label: 'risk / notes', value: details.risk });
  if (details.draft) rows.push({ label: 'draft', value: details.draft });
  if (details.draftUrl) rows.push({ label: 'draft url', value: details.draftUrl, mode: 'link' });
  if (details.artifactUrl) rows.push({ label: 'artifact url', value: details.artifactUrl, mode: 'link' });

  const decisionLabel = details.decisionStatus
    ? `${details.decisionStatus}${details.decisionReviewer ? ` by ${details.decisionReviewer}` : ''}`
    : '';
  if (decisionLabel) rows.push({ label: 'decision', value: decisionLabel });
  if (details.decisionComment) rows.push({ label: 'comment', value: details.decisionComment });
  if (details.errorMessage) rows.push({ label: 'error', value: details.errorMessage });

  if (rows.length === 0) return '';

  return `<div class="log-details">${rows.map((row) => {
    const value = row.mode === 'link'
      ? `<a class="log-detail-link" href="${escapeHtml(row.value)}" target="_blank" rel="noopener noreferrer">${escapeHtml(row.value)}</a>`
      : escapeHtml(row.value);
    return `<div class="log-detail"><span class="log-detail-label">${escapeHtml(row.label)}</span><div class="log-detail-value">${value}</div></div>`;
  }).join('')}</div>`;
}

function approvalListThemeStyles(): string {
  return `
    :root {
      --mono: 'Geist Mono', ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
      --sans: 'Geist', ui-sans-serif, system-ui, -apple-system, sans-serif;
    }
    :root[data-theme="dark"] {
      color-scheme: dark;
      --bg: #000000; --fg: #ffffff;
      --line: rgba(255,255,255,0.10); --line-strong: rgba(255,255,255,0.18);
      --panel: rgba(255,255,255,0.03); --panel-hover: rgba(255,255,255,0.06);
      --muted: rgba(255,255,255,0.50); --muted-2: rgba(255,255,255,0.30); --muted-3: rgba(255,255,255,0.70);
      --cyan: #22d3ee; --cyan-soft: rgba(34,211,238,0.08); --cyan-border: rgba(34,211,238,0.35);
      --green: #4ade80; --green-soft: rgba(74,222,128,0.08); --green-border: rgba(74,222,128,0.35);
      --amber: #fbbf24; --amber-soft: rgba(251,191,36,0.08); --amber-border: rgba(251,191,36,0.35);
      --red: #f87171; --red-soft: rgba(248,113,113,0.10); --red-border: rgba(248,113,113,0.35);
      --glow-1: rgba(34,211,238,0.06); --glow-2: rgba(74,222,128,0.04);
    }
    :root[data-theme="light"] {
      color-scheme: light;
      --bg: #fafaf9; --fg: #0a0a0a;
      --line: rgba(0,0,0,0.08); --line-strong: rgba(0,0,0,0.16);
      --panel: rgba(0,0,0,0.025); --panel-hover: rgba(0,0,0,0.05);
      --muted: rgba(0,0,0,0.55); --muted-2: rgba(0,0,0,0.35); --muted-3: rgba(0,0,0,0.75);
      --cyan: #0891b2; --cyan-soft: rgba(8,145,178,0.08); --cyan-border: rgba(8,145,178,0.35);
      --green: #047857; --green-soft: rgba(4,120,87,0.08); --green-border: rgba(4,120,87,0.35);
      --amber: #b45309; --amber-soft: rgba(180,83,9,0.10); --amber-border: rgba(180,83,9,0.35);
      --red: #b91c1c; --red-soft: rgba(185,28,28,0.08); --red-border: rgba(185,28,28,0.35);
      --glow-1: rgba(8,145,178,0.06); --glow-2: rgba(4,120,87,0.04);
    }
  `;
}

function approvalThemeBootScript(): string {
  return `(function() {
    try {
      var stored = localStorage.getItem('agentuse-theme');
      var resolved = stored === 'light' || stored === 'dark'
        ? stored
        : (window.matchMedia && window.matchMedia('(prefers-color-scheme: light)').matches ? 'light' : 'dark');
      document.documentElement.setAttribute('data-theme', resolved);
      document.documentElement.setAttribute('data-theme-pref', stored || 'system');
    } catch (e) {}
  })();`;
}

function approvalsTopbarStyles(): string {
  return `
    .topbar {
      display: flex; align-items: center; justify-content: space-between;
      padding: 16px 24px;
      border-bottom: 1px solid var(--line);
      font-size: 12px;
      color: var(--muted);
    }
    .topbar .brand { display: inline-flex; gap: 10px; align-items: center; color: var(--fg); font-weight: 500; letter-spacing: 0.02em; }
    .topbar .brand a { color: inherit; text-decoration: none; border: 0; }
    .topbar .brand a:hover { opacity: 1; color: var(--fg); }
    .topbar .brand .slash { color: var(--muted-2); }
    .topbar .brand .page { color: var(--muted-3); transition: color 120ms ease; }
    .topbar .brand a.page:hover { color: var(--fg); }
    .topbar .right { display: inline-flex; gap: 18px; align-items: center; }
    .session-pill { color: var(--muted); }
    .session-pill code { color: var(--muted-3); }
    .pending-count { color: var(--cyan); }
    .theme-toggle {
      display: inline-flex;
      align-items: center;
      gap: 0;
      padding: 2px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel);
    }
    .theme-toggle button {
      min-height: 0;
      padding: 4px 8px;
      border: 0;
      border-radius: 999px;
      background: transparent;
      color: var(--muted-2);
      font-size: 11px;
      letter-spacing: 0.04em;
      display: inline-flex;
      align-items: center;
      gap: 4px;
      cursor: pointer;
    }
    .theme-toggle button:hover { background: transparent; color: var(--muted-3); border: 0; }
    .theme-toggle button[aria-pressed="true"] {
      background: var(--bg);
      color: var(--fg);
      border: 1px solid var(--line);
    }
    .theme-toggle svg { width: 12px; height: 12px; display: block; }
    @media (max-width: 640px) {
      .topbar { padding: 12px 16px; flex-wrap: wrap; gap: 6px; }
    }
  `;
}

function approvalsThemeToggleHtml(): string {
  return `<span class="theme-toggle" role="group" aria-label="Theme">
      <button type="button" data-theme-pref="light" title="Light" aria-label="Light theme">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="3"/><path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1.06 1.06M4.46 11.54L3.4 12.6M12.6 12.6l-1.06-1.06M4.46 4.46L3.4 3.4"/></svg>
      </button>
      <button type="button" data-theme-pref="system" title="System" aria-label="System theme">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="2" y="3" width="12" height="8" rx="1.5"/><path d="M5.5 13.5h5M8 11v2.5" stroke-linecap="round"/></svg>
      </button>
      <button type="button" data-theme-pref="dark" title="Dark" aria-label="Dark theme">
        <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"><path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z"/></svg>
      </button>
    </span>`;
}

function approvalsThemeToggleScript(): string {
  return `
    (function() {
      const themeMql = window.matchMedia('(prefers-color-scheme: light)');
      function applyTheme(pref) {
        const resolved = pref === 'light' || pref === 'dark'
          ? pref
          : (themeMql.matches ? 'light' : 'dark');
        document.documentElement.setAttribute('data-theme', resolved);
        document.documentElement.setAttribute('data-theme-pref', pref);
        for (const btn of document.querySelectorAll('.theme-toggle button')) {
          btn.setAttribute('aria-pressed', String(btn.dataset.themePref === pref));
        }
      }
      function currentPref() {
        return localStorage.getItem('agentuse-theme') || 'system';
      }
      applyTheme(currentPref());
      for (const btn of document.querySelectorAll('.theme-toggle button')) {
        btn.addEventListener('click', () => {
          const pref = btn.dataset.themePref;
          if (pref === 'system') localStorage.removeItem('agentuse-theme');
          else localStorage.setItem('agentuse-theme', pref);
          applyTheme(pref);
        });
      }
      themeMql.addEventListener('change', () => {
        if (currentPref() === 'system') applyTheme('system');
      });
    })();
  `;
}

function approvalsTopbarMarkup(opts: { right?: string; isCurrentPage?: boolean }): string {
  const pageMarkup = opts.isCurrentPage
    ? `<span class="page">approvals</span>`
    : `<a class="page" href="/approvals">approvals</a>`;
  return `<div class="topbar">
    <span class="brand"><span>agentuse</span><span class="slash">/</span>${pageMarkup}</span>
    <span class="right">${opts.right ?? ''}</span>
  </div>`;
}

function renderApprovalRow(row: { projectId: string; multiProject: boolean; approval: ApprovalSummary }): string {
  const { approval, projectId, multiProject } = row;
  const linkable = approval.resumeToken !== undefined;
  const params = new URLSearchParams();
  if (approval.resumeToken) params.set('token', approval.resumeToken);
  params.set('project', projectId);
  const href = linkable ? `/approvals/${encodeURIComponent(approval.sessionId)}?${params.toString()}` : null;

  const promptText = approval.summary || approval.prompt || '(no prompt summary)';
  const truncated = promptText.length > 220 ? `${promptText.slice(0, 220)}…` : promptText;

  const timeLabel = approval.status === 'pending'
    ? (approval.expiresAt
      ? `expires ${formatApprovalTime(approval.expiresAt)}`
      : `suspended ${formatApprovalTime(approval.suspendedAt)}`)
    : approval.status === 'expired'
      ? `expired ${formatApprovalTime(approval.decisionAt ?? approval.expiresAt)}`
      : `decided ${formatApprovalTime(approval.decisionAt)}`;

  const decisionLabel = approval.decisionStatus
    ? `${approval.decisionStatus}${approval.decisionReviewer ? ` by ${approval.decisionReviewer}` : ''}`
    : approval.errorMessage || '';

  const projectChip = multiProject ? `<span class="chip project">${escapeHtml(projectId)}</span>` : '';

  const inner = `
    <div class="row-head">
      <span class="chip status ${escapeHtml(approval.status)}">${escapeHtml(approval.status)}</span>
      ${projectChip}
      <span class="chip agent">${escapeHtml(approval.agentName)}</span>
      <span class="row-time">${escapeHtml(timeLabel)}</span>
    </div>
    <div class="row-body">${escapeHtml(truncated)}</div>
    ${decisionLabel ? `<div class="row-decision">${escapeHtml(decisionLabel)}${approval.decisionComment ? `: ${escapeHtml(approval.decisionComment)}` : ''}</div>` : ''}
    <div class="row-meta"><code>${escapeHtml(approval.sessionId)}</code></div>
  `;

  return href
    ? `<a class="row" href="${escapeHtml(href)}">${inner}</a>`
    : `<div class="row row-static">${inner}</div>`;
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
    .empty { color: var(--muted-2); font-style: italic; padding: 14px 0; }
    .rows { display: flex; flex-direction: column; gap: 8px; }
    .row {
      display: block;
      background: var(--panel);
      border: 1px solid var(--line);
      border-radius: 10px;
      padding: 14px 16px;
      transition: background 120ms ease, border-color 120ms ease;
    }
    a.row { cursor: pointer; }
    a.row:hover { background: var(--panel-hover); border-color: var(--line-strong); }
    .row-static { opacity: 0.85; }
    .row-head {
      display: flex; flex-wrap: wrap; align-items: center; gap: 8px;
      margin-bottom: 8px;
    }
    .row-time { color: var(--muted-2); font-size: 12px; margin-left: auto; }
    .row-body {
      font-family: var(--sans);
      font-size: 14px;
      color: var(--muted-3);
      white-space: pre-wrap; overflow-wrap: anywhere;
    }
    .row-decision { margin-top: 6px; color: var(--muted); font-size: 12.5px; }
    .row-meta { margin-top: 8px; color: var(--muted-2); font-size: 11px; }
    .row-meta code { font-family: var(--mono); font-size: 11px; }
    .chip {
      display: inline-flex; align-items: center;
      padding: 2px 8px;
      border-radius: 999px;
      font-size: 10.5px;
      letter-spacing: 0.08em;
      text-transform: uppercase;
      border: 1px solid var(--line-strong);
      background: var(--panel);
      color: var(--muted-3);
    }
    .chip.status.pending { color: var(--cyan); border-color: var(--cyan-border); background: var(--cyan-soft); }
    .chip.status.approved, .chip.status.commented { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
    .chip.status.rejected { color: var(--amber); border-color: var(--amber-border); background: var(--amber-soft); }
    .chip.status.expired, .chip.status.errored { color: var(--red); border-color: var(--red-border); background: var(--red-soft); }
    .chip.project { color: var(--cyan); }
    .chip.agent { color: var(--fg); }
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

function renderApprovalPage(options: {
  approval: ApprovalPageInfo;
  token: string;
  projectId?: string;
  resuming?: boolean;
  error?: string;
}): string {
  const { approval, token, projectId, resuming, error } = options;
  const expired = approval.expiresAt !== undefined && approval.expiresAt <= Date.now();
  const actionable = approval.sessionStatus === 'suspended' && !expired && !resuming && !error && Boolean(approval.prompt);
  const status = resuming
    ? 'resuming'
    : expired
      ? 'expired'
      : approval.sessionStatus === 'suspended'
        ? 'waiting'
        : approval.sessionStatus;
  const actions = approvalActionList(approval.actions);
  const initialLogs = approval.logs ?? [];
  const agentLabel = approval.agent.name || approval.agent.id;
  const agentHeadline = approval.agent.description || agentLabel;

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>AgentUse / Approval</title>
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
    .status.resuming { color: var(--amber); border-color: var(--amber-border); background: var(--amber-soft); }
    .status.resuming::before { animation: pulse 0.8s ease-in-out infinite; }
    .status.completed, .status.approved { color: var(--green); border-color: var(--green-border); background: var(--green-soft); }
    .status.expired, .status.error, .status.rejected { color: var(--red); border-color: var(--red-border); background: var(--red-soft); }
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
    .prompt {
      font-family: var(--sans);
      font-size: 17px;
      color: var(--muted-3);
      border-left: 2px solid var(--cyan-border);
      padding: 6px 0 6px 16px;
      margin: 0;
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
    .log-marker { color: var(--cyan); opacity: 0.6; }
    .log-item.error .log-marker, .log-item.failed .log-marker { color: var(--red); }
    .log-item.completed .log-marker, .log-item.approved .log-marker { color: var(--green); }
    .log-item.resuming .log-marker { color: var(--amber); }
    .log-title { font-weight: 500; color: var(--fg); }
    .log-main pre {
      margin-top: 4px;
      color: var(--muted);
      font-size: 12.5px;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .log-empty { color: var(--muted-2); padding: 12px 0; font-style: italic; }

    .log-details {
      display: grid;
      gap: 10px;
      margin-top: 10px;
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
      padding: 10px 12px;
      font-family: var(--mono);
      font-size: 13px;
      line-height: 1.5;
      color: var(--muted-3);
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .log-detail-link {
      color: var(--cyan);
      text-decoration: none;
      border-bottom: 1px dashed var(--cyan-border);
    }
    .log-detail-link:hover { border-bottom-style: solid; }

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
    .inactive-banner::before { content: "⋮ "; color: var(--muted-2); }

    /* responsive */
    @media (max-width: 640px) {
      h1 { font-size: 26px; }
      .log-actions { flex-direction: column; align-items: stretch; }
      .log-actions-hint { display: none; }
      .log-actions-buttons { justify-content: stretch; }
      .log-actions-buttons button { flex: 1; }
    }
  </style>
</head>
<body>
  ${approvalsTopbarMarkup({
    right: `<span class="session-pill">session <code>${escapeHtml(approval.sessionId.slice(0, 8))}…</code></span>${approvalsThemeToggleHtml()}`
  })}

  <main>
    <header>
      <span class="status ${escapeHtml(status)}">${escapeHtml(status)}</span>
      <div class="eyebrow">human approval requested</div>
      <h1>${escapeHtml(agentHeadline)}</h1>
      <p class="prompt">Review the pending request in the session log below, then approve, reject, or send a comment back to the agent. The session is paused until you respond.</p>
      <div class="meta" id="approval-meta">
        <div class="cell"><span class="label">session</span><code>${escapeHtml(approval.sessionId)}</code></div>
        <div class="cell"><span class="label">project</span><code>${escapeHtml(projectId ?? 'default')}</code></div>
        <div class="cell"><span class="label">agent</span><span class="value">${escapeHtml(agentLabel)}</span></div>
        <div class="cell" id="expires-cell"${approval.expiresAt === undefined ? ' hidden' : ''}><span class="label">expires</span><span class="value" id="expires-value">${approval.expiresAt !== undefined ? escapeHtml(formatApprovalTime(approval.expiresAt)) : ''}</span></div>
      </div>
    </header>

    ${error ? `<p class="notice error">${escapeHtml(error)}</p>` : ''}

    <div class="section-title"><span>session log</span><span class="rule"></span></div>
    <div class="panel">
      <ul id="logs" class="logs">${renderLogItems(initialLogs, { actions, actionable, currentResumeToken: approval.currentResumeToken })}</ul>
    </div>

    ${actionable ? '' : `
    <div class="inactive-banner">This approval request is not accepting decisions right now.</div>`}

    <p id="result" class="notice"></p>
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
  </dialog>` : ''}

  <script>
    const token = ${JSON.stringify(token)};
    const project = ${JSON.stringify(projectId)};
    // The active gate's resumeToken at page render. Each await_human gate mints
    // a fresh token; if the page was opened on gate N's URL but the agent has
    // moved on to gate N+1, this rotates and refreshStatus redirects to the new
    // approval URL. /decision is sent with the current token, not the URL token,
    // so it stays valid across gates within the same session.
    let currentResumeToken = ${JSON.stringify(approval.currentResumeToken ?? token)};
    const approvalActions = ${JSON.stringify(actions)};
    let pendingActionable = ${JSON.stringify(actionable)};
    const statusEl = document.querySelector('.status');
    const logsEl = document.getElementById('logs');

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
    function formatTime(value) {
      return value ? new Date(value).toLocaleTimeString() : '';
    }
    // Logs accumulate monotonically across the session. The /status endpoint
    // can return fewer (or zero) entries during the approval handoff window,
    // so we merge by id instead of overwriting.
    const renderedLogs = new Map();
    const initialEntries = ${JSON.stringify(initialLogs)};
    for (const entry of initialEntries) {
      if (entry && entry.id != null) renderedLogs.set(String(entry.id), entry);
    }
    function logDetailsHtml(details) {
      if (!details) return '';
      const rows = [];
      if (details.prompt) rows.push(['prompt', details.prompt]);
      if (details.summary) rows.push(['summary', details.summary]);
      if (details.context) rows.push(['context', details.context]);
      if (details.risk) rows.push(['risk / notes', details.risk]);
      if (details.draft) rows.push(['draft', details.draft]);
      if (details.draftUrl) rows.push(['draft url', details.draftUrl, 'link']);
      if (details.artifactUrl) rows.push(['artifact url', details.artifactUrl, 'link']);
      if (details.decisionStatus) {
        const reviewer = details.decisionReviewer ? ' by ' + details.decisionReviewer : '';
        rows.push(['decision', details.decisionStatus + reviewer]);
      }
      if (details.decisionComment) rows.push(['comment', details.decisionComment]);
      if (details.errorMessage) rows.push(['error', details.errorMessage]);
      if (rows.length === 0) return '';
      return '<div class="log-details">' + rows.map(function (row) {
        const label = '<span class="log-detail-label">' + escapeText(row[0]) + '</span>';
        const value = row[2] === 'link'
          ? '<a class="log-detail-link" href="' + escapeText(row[1]) + '" target="_blank" rel="noopener noreferrer">' + escapeText(row[1]) + '</a>'
          : escapeText(row[1]);
        return '<div class="log-detail">' + label + '<div class="log-detail-value">' + value + '</div></div>';
      }).join('') + '</div>';
    }
    function detailsKey(details) {
      return details ? JSON.stringify(details) : '';
    }
    function logActionsHtml(entry) {
      if (!pendingActionable) return '';
      if (entry.status !== 'pending' || !entry.details) return '';
      if (currentResumeToken && entry.details.resumeToken !== currentResumeToken) return '';
      if (!Array.isArray(approvalActions) || approvalActions.length === 0) return '';
      const buttons = approvalActions.map(function (action) {
        const cls = action && action.style ? escapeText(action.style) : '';
        const id = escapeText(action && action.id || '');
        const label = escapeText(action && action.label || '');
        return '<button class="' + cls + '" data-action="' + id + '">' + label + '</button>';
      }).join('');
      return '<div class="log-actions" data-actions-row>' +
        '<div class="log-actions-hint">' +
          '<span class="kbd">⌘⏎</span> approve <span class="kbd">esc</span> reject <span class="kbd">c</span> comment' +
        '</div>' +
        '<div class="log-actions-buttons">' + buttons + '</div>' +
      '</div>';
    }
    function logEntryHtml(entry) {
      return '<li class="log-item ' + escapeText(entry.status || '') + '">' +
        '<span class="log-time">' + escapeText(formatTime(entry.time)) + '</span>' +
        '<span class="log-marker">⋮</span>' +
        '<span class="log-main"><span class="log-title">' + escapeText(entry.title) + '</span>' +
        logDetailsHtml(entry.details) +
        logActionsHtml(entry) +
        (entry.message ? '<pre>' + escapeText(entry.message) + '</pre>' : '') +
        '</span></li>';
    }
    function renderLogs(logs) {
      let changed = false;
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
      submittingDecision = false;
      for (const b of document.querySelectorAll('button[data-action]')) b.disabled = false;
      // Keep the URL in sync so a refresh lands on the active gate.
      if (approval.approvalUrl) {
        try { history.replaceState(null, '', approval.approvalUrl); } catch {}
      }
    }
    async function refreshStatus() {
      try {
        const url = new URL(location.pathname + '/status', location.origin);
        url.searchParams.set('token', token);
        if (project) url.searchParams.set('project', project);
        const response = await fetch(url);
        const payload = await response.json();
        if (!response.ok || !payload.success) return;
        const status = payload.status || payload.approval?.sessionStatus || 'unknown';
        statusEl.textContent = status;
        statusEl.className = 'status ' + status;
        const nextToken = payload.approval?.currentResumeToken;
        if (nextToken && nextToken !== currentResumeToken && status === 'waiting') {
          currentResumeToken = nextToken;
          renderActiveGate(payload.approval);
        }
        renderLogs(payload.logs || payload.approval?.logs || []);
      } catch {}
    }
    refreshStatus();
    setInterval(refreshStatus, 1500);

    let submittingDecision = false;
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
        const response = await fetch(location.pathname + '/decision', {
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

    // Buttons are re-rendered with the log on every poll, so use delegation
    // anchored at the logs container instead of binding each button directly.
    logsEl.addEventListener('click', (e) => {
      const target = e.target instanceof Element ? e.target.closest('button[data-action]') : null;
      if (!target || target.disabled) return;
      const action = target.dataset.action;
      if (!action) return;
      if (action === 'comment') openCommentDialog();
      else submitDecision(action);
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
  </script>
</body>
</html>`;
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
  root: string;
  envFile: string;
  agentFiles: string[];
}

function collectDir(value: string, previous: string[]): string[] {
  return previous.concat([value]);
}

function resolveProjectFromPath(rawPath: string, idOverride?: string): Omit<Project, 'agentFiles'> {
  const root = resolve(expandHome(rawPath));
  if (!existsSync(root)) {
    throw new Error(`Directory not found: ${root}`);
  }
  const envLocal = resolve(root, '.env.local');
  const envFile = existsSync(envLocal) ? envLocal : resolve(root, '.env');
  const id = idOverride ?? basename(root);
  return { id, root, envFile };
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
    .option("-C, --directory <path>", "Project directory (repeat for multi-project). Overrides config.serve.projects.", collectDir, [] as string[])
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

      // Check if any requested project root is already served
      const existingServers = listServers();
      for (const p of projectSeeds) {
        const clash = existingServers.find((s) => {
          if (s.projects && s.projects.length > 0) return s.projects.some((sp) => sp.root === p.root);
          return s.projectRoot === p.root;
        });
        if (clash) {
          console.error(chalk.red(`\nError: a server is already running for project at ${p.root}.`));
          console.error(chalk.dim(`\n  PID:  ${clash.pid}`));
          console.error(chalk.dim(`  Port: ${clash.port}`));
          console.error(chalk.dim(`\nTo see all running servers: agentuse serve ps`));
          process.exit(1);
        }
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
        const agentPath = resolve(project.root, schedule.agentPath);

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
          agentPath: schedule.agentPath, // Use relative path
          projectRoot: project.root,
          timeout: agent.config.timeout,
          maxSteps: agent.config.maxSteps,
          debug: options.debug,
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
          cwd: seed.root,
          ignore: ["node_modules/**", "tmp/**", ".git/**"],
        });
        projects.push({ ...seed, agentFiles });

        for (const agentFile of agentFiles) {
          try {
            const agentPath = resolve(seed.root, agentFile);
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
          envFile: project.envFile,

          onAgentAdded: async (relativePath: string) => {
            try {
              const agentPath = resolve(project.root, relativePath);
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
              const agentPath = resolve(project.root, relativePath);
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

      const activeApprovalResumes = new Set<string>();
      const loggedApprovalRequests = new Set<string>();

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
          approvalLog.resumeFailed(decision.sessionId, Date.now() - resumeStart, result.error.message);
          throw new Error(result.error.message);
        }
        approvalLog.resumeCompleted(decision.sessionId, Date.now() - resumeStart);
      };

      let slackApprovalSocket: SlackApprovalSocket | null = null;
      const slackBotToken = process.env.SLACK_BOT_TOKEN;
      const slackAppToken = process.env.SLACK_APP_TOKEN;
      if (slackBotToken && slackAppToken) {
        slackApprovalSocket = new SlackApprovalSocket({
          botToken: slackBotToken,
          appToken: slackAppToken,
          onDecision: resumeSuspendedSession,
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
                item.notification?.type === 'slack-message' &&
                item.notification.channel &&
                item.notification.ts &&
                item.prompt
              ) {
                void updateSlackApprovalRequestStatus({
                  botToken: slackBotToken,
                  channelId: item.notification.channel,
                  ts: item.notification.ts,
                  prompt: item.prompt,
                  sessionId: item.sessionId,
                  projectId: project.id,
                  ...(item.notification.url && { approvalUrl: item.notification.url }),
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
        const isApprovalRoute = requestUrl.pathname.startsWith('/approvals/');

        // CORS headers
        res.setHeader("Access-Control-Allow-Origin", "*");
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Auth check
        if (apiKey && !isApprovalRoute && !validateApiKey(req, apiKey)) {
          sendError(res, 401, "UNAUTHORIZED", "Invalid or missing Authorization header. Use: Authorization: Bearer <key>");
          return;
        }

        // GET / returns server info
        if (req.method === "GET" && (req.url === "/" || req.url === "")) {
          const info = {
            version: packageVersion,
            default: effectiveDefault ?? (multiProject ? null : projects[0].id),
            projects: projects.map((p) => ({
              id: p.id,
              path: p.root,
              agentCount: agentCounts.get(p.id) ?? 0,
              scheduleCount: scheduler.list().filter((s) => s.projectId === p.id).length,
            })),
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(info));
          return;
        }

        if (req.method === "GET" && requestUrl.pathname === '/approvals') {
          type ProjectRow = { projectId: string; multiProject: boolean; approval: ApprovalSummary };
          const rows: ProjectRow[] = [];
          const errors: Array<{ projectId: string; message: string }> = [];

          for (const project of projects) {
            const projectWorker = workers.get(project.id);
            if (!projectWorker) {
              errors.push({ projectId: project.id, message: 'Worker unavailable' });
              continue;
            }
            const result = await projectWorker.listApprovals(project.root);
            if (!result.success) {
              errors.push({ projectId: project.id, message: result.error.message });
              continue;
            }
            for (const approval of result.approvals) {
              rows.push({ projectId: project.id, multiProject, approval });
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

          if (wantsJson(requestUrl, req)) {
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
              errors
            });
            return;
          }

          sendHTML(res, 200, renderApprovalsListPage({ buckets, errors, multiProject }));
          return;
        }

        const approvalPageMatch = req.method === "GET" ? requestUrl.pathname.match(/^\/approvals\/([^/?#]+)$/) : null;
        if (approvalPageMatch) {
          const sessionId = decodeURIComponent(approvalPageMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;
          if (!token) {
            sendHTML(res, 401, '<!doctype html><title>AgentUse Approval</title><p>Missing approval token.</p>');
            return;
          }

          const project = resolveResumeProject(projectId);
          if (!project) {
            sendHTML(res, 404, '<!doctype html><title>AgentUse Approval</title><p>Project not found for approval request.</p>');
            return;
          }

          const projectWorker = workers.get(project.id);
          if (!projectWorker) {
            sendHTML(res, 500, '<!doctype html><title>AgentUse Approval</title><p>Worker unavailable for approval request.</p>');
            return;
          }

          const info = await projectWorker.getApprovalInfo({
            projectRoot: project.root,
            sessionId,
            resumeToken: token,
            allowHistorical: true,
          });
          if (!info.success) {
            sendHTML(res, info.error.code === 'RESUME_TOKEN_INVALID' ? 401 : 404, `<!doctype html><title>AgentUse Approval</title><p>${escapeHtml(info.error.message)}</p>`);
            return;
          }

          const activeKey = `${project.id}:${sessionId}`;
          sendHTML(res, 200, renderApprovalPage({
            approval: info.approval,
            token,
            projectId: project.id,
            resuming: activeApprovalResumes.has(activeKey),
          }));
          return;
        }

        const approvalRequestedMatch = req.method === "POST" ? requestUrl.pathname.match(/^\/approvals\/([^/?#]+)\/requested$/) : null;
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

            const project = resolveResumeProject(projectId);
            if (!project) {
              sendError(res, 404, "PROJECT_NOT_FOUND", "Project not found for approval request");
              return;
            }

            const projectWorker = workers.get(project.id);
            if (!projectWorker) {
              sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
              return;
            }

            const info = await projectWorker.getApprovalInfo({
              projectRoot: project.root,
              sessionId,
              resumeToken: token
            });
            if (!info.success) {
              sendError(res, info.error.code === 'RESUME_TOKEN_INVALID' ? 401 : 404, info.error.code, info.error.message);
              return;
            }

            const logKey = `${project.id}:${sessionId}:${token}`;
            if (!loggedApprovalRequests.has(logKey)) {
              loggedApprovalRequests.add(logKey);
              const filePath = info.approval.agent.filePath;
              const agentLabel = filePath
                ? relative(project.root, filePath)
                : info.approval.agent.name;
              approvalLog.sent(
                multiProject ? `${project.id}/${agentLabel}` : agentLabel,
                info.approval.approvalUrl ?? approvalUrl,
                sessionId
              );
            }

            sendJSON(res, 200, { success: true, status: "logged", sessionId });
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        const approvalStatusMatch = req.method === "GET" ? requestUrl.pathname.match(/^\/approvals\/([^/?#]+)\/status$/) : null;
        if (approvalStatusMatch) {
          const sessionId = decodeURIComponent(approvalStatusMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;
          if (!token) {
            sendError(res, 401, "RESUME_TOKEN_REQUIRED", "Missing approval token");
            return;
          }

          const project = resolveResumeProject(projectId);
          if (!project) {
            sendError(res, 404, "PROJECT_NOT_FOUND", "Project not found for approval request");
            return;
          }

          const projectWorker = workers.get(project.id);
          if (!projectWorker) {
            sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
            return;
          }

          const info = await projectWorker.getApprovalInfo({
            projectRoot: project.root,
            sessionId,
            resumeToken: token,
            allowHistorical: true,
          });
          if (!info.success) {
            sendError(res, info.error.code === 'RESUME_TOKEN_INVALID' ? 401 : 404, info.error.code, info.error.message);
            return;
          }

          const activeKey = `${project.id}:${sessionId}`;
          const status = activeApprovalResumes.has(activeKey)
            ? 'resuming'
            : info.approval.sessionStatus === 'suspended'
              ? 'waiting'
              : info.approval.sessionStatus;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            sessionId,
            status,
            approval: info.approval,
            logs: info.approval.logs ?? [],
            decision: info.approval.decision
          }));
          return;
        }

        const approvalDecisionMatch = req.method === "POST" ? requestUrl.pathname.match(/^\/approvals\/([^/?#]+)\/decision$/) : null;
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

            const project = resolveResumeProject(projectId);
            if (!project) {
              sendError(res, 404, "PROJECT_NOT_FOUND", "Project not found for approval request");
              return;
            }

            const projectWorker = workers.get(project.id);
            if (!projectWorker) {
              sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
              return;
            }

            const activeKey = `${project.id}:${sessionId}`;
            if (activeApprovalResumes.has(activeKey)) {
              sendError(res, 409, "APPROVAL_RESUMING", "Approval decision has already been submitted and the session is resuming");
              return;
            }

            const info = await projectWorker.getApprovalInfo({
              projectRoot: project.root,
              sessionId,
              resumeToken: token
            });
            if (!info.success) {
              sendError(res, info.error.code === 'RESUME_TOKEN_INVALID' ? 401 : 404, info.error.code, info.error.message);
              return;
            }
            if (info.approval.sessionStatus !== 'suspended') {
              sendError(res, 409, "SESSION_NOT_SUSPENDED", `Session is ${info.approval.sessionStatus}`);
              return;
            }
            if (info.approval.expiresAt !== undefined && info.approval.expiresAt <= Date.now()) {
              sendError(res, 410, "APPROVAL_EXPIRED", "Approval request has expired");
              return;
            }

            activeApprovalResumes.add(activeKey);
            approvalLog.received('web', status, sessionId, 'web');
            const resumeStart = Date.now();
            approvalLog.resumeStarted(sessionId);
            const slackNotification = info.approval.notification?.type === 'slack-message' &&
              info.approval.notification.channel &&
              info.approval.notification.ts &&
              slackBotToken
              ? {
                channelId: info.approval.notification.channel,
                ts: info.approval.notification.ts,
                approvalUrl: info.approval.notification.url
              }
              : undefined;
            if (slackNotification && info.approval.prompt) {
              void updateSlackApprovalRequestStatus({
                botToken: slackBotToken!,
                channelId: slackNotification.channelId,
                ts: slackNotification.ts,
                prompt: info.approval.prompt,
                sessionId,
                projectId: project.id,
                ...(slackNotification.approvalUrl && { approvalUrl: slackNotification.approvalUrl }),
                ...(info.approval.expiresAt && { expiresAt: new Date(info.approval.expiresAt).toISOString() }),
                status: 'resuming',
                decision: status
              }).catch((err) => logger.warn(`Slack approval status update failed: ${(err as Error).message}`));
            }
            projectWorker.execute({
              projectRoot: project.root,
              sessionId,
              toolResult: {
                status,
                ...(comment && { comment }),
                reviewer: { username: 'web' }
              },
              resumeToken: token,
              debug: options.debug,
            }).then(result => {
              if (!result.success) {
                approvalLog.resumeFailed(sessionId, Date.now() - resumeStart, result.error.message);
                logger.warn(`Approval resume ${sessionId} failed: ${result.error.message}`);
                if (slackNotification && info.approval.prompt) {
                  void updateSlackApprovalRequestStatus({
                    botToken: slackBotToken!,
                    channelId: slackNotification.channelId,
                    ts: slackNotification.ts,
                    prompt: info.approval.prompt,
                    sessionId,
                    projectId: project.id,
                    ...(slackNotification.approvalUrl && { approvalUrl: slackNotification.approvalUrl }),
                    ...(info.approval.expiresAt && { expiresAt: new Date(info.approval.expiresAt).toISOString() }),
                    status: 'failed',
                    decision: status,
                    error: result.error.message
                  }).catch((err) => logger.warn(`Slack approval status update failed: ${(err as Error).message}`));
                }
              } else {
                approvalLog.resumeCompleted(sessionId, Date.now() - resumeStart);
                if (slackNotification && info.approval.prompt) {
                  void updateSlackApprovalRequestStatus({
                    botToken: slackBotToken!,
                    channelId: slackNotification.channelId,
                    ts: slackNotification.ts,
                    prompt: info.approval.prompt,
                    sessionId,
                    projectId: project.id,
                    ...(slackNotification.approvalUrl && { approvalUrl: slackNotification.approvalUrl }),
                    ...(info.approval.expiresAt && { expiresAt: new Date(info.approval.expiresAt).toISOString() }),
                    status: 'completed',
                    decision: status
                  }).catch((err) => logger.warn(`Slack approval status update failed: ${(err as Error).message}`));
                }
              }
            }).finally(() => {
              activeApprovalResumes.delete(activeKey);
            });

            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessionId, status: "resuming" }));
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        const resumeMatch = req.method === "POST" ? req.url?.match(/^\/resume\/([^/?#]+)/) : null;
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

        if (req.method !== "POST" || req.url !== "/run") {
          sendError(res, 404, "NOT_FOUND", "Endpoint not found. Use POST /run or GET /");
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
          const agentPath = resolve(project.root, body.agent);
          if (!existsSync(agentPath)) {
            sendError(res, 404, "AGENT_NOT_FOUND", `Agent file not found: ${body.agent}`);
            return;
          }

          // Security: ensure agent is within project root
          if (!agentPath.startsWith(project.root)) {
            sendError(res, 400, "INVALID_PATH", "Agent path must be within project root");
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
            agentPath: body.agent, // Use relative path, worker resolves from projectRoot
            projectRoot: project.root,
            prompt: body.prompt,
            model: body.model,
            timeout: timeoutSeconds,
            maxSteps: body.maxSteps,
            debug: options.debug,
            sessionId: body.sessionId,
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
          console.error(chalk.dim(`  • See running servers:  agentuse serve ps`));
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
          console.log(`  ${chalk.dim("Directory")} ${projects[0].root}`);
        } else {
          console.log(`  ${chalk.dim("Projects")}  ${projects.length}`);
          for (const p of projects) {
            const scheduleN = schedules.filter((s) => s.projectId === p.id).length;
            const marker = effectiveDefault === p.id ? chalk.green(' (default)') : '';
            console.log(`    ${chalk.cyan(p.id.padEnd(20))} ${chalk.dim(p.root)}  ${chalk.dim(`${p.agentFiles.length} agents, ${scheduleN} scheduled`)}${marker}`);
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

function createPsSubcommand(): Command {
  return new Command("ps")
    .description("List running agentuse serve instances")
    .option("--json", "Output as JSON")
    .action((options: { json?: boolean }) => {
      const servers = listServers();

      if (options.json) {
        console.log(JSON.stringify(servers, null, 2));
        return;
      }

      if (servers.length === 0) {
        console.log(chalk.dim("No running agentuse serve instances found."));
        console.log(chalk.dim("\nStart a server with: agentuse serve"));
        return;
      }

      console.log(formatPsTable(servers));
      console.log();
      console.log(chalk.dim(`${servers.length} server${servers.length === 1 ? "" : "s"} running`));
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
      console.error(chalk.red(`No running agentuse serve instance with pid ${pid}.`));
      console.error(chalk.dim(`Use \`agentuse serve ps\` to see running servers.`));
      return null;
    }
    return found;
  }
  if (servers.length === 0) {
    console.error(chalk.dim("No running agentuse serve instances found."));
    return null;
  }
  if (servers.length > 1) {
    console.error(chalk.red("Multiple servers running; specify a pid."));
    console.error();
    console.error(formatPsTable(servers));
    return null;
  }
  return servers[0];
}

function createLogsSubcommand(): Command {
  return new Command("logs")
    .description("Show the log file for a running agentuse serve instance")
    .argument("[pid]", "PID of the server to tail (omit when only one server is running)")
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
