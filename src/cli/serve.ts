import { Command } from "commander";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { dirname, join, resolve, basename, relative } from "path";
import { existsSync } from "fs";
import { readFile } from "fs/promises";
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
import { Scheduler, type Schedule } from "../scheduler";
import { FileWatcher } from "../watcher";
import { telemetry, parseModel } from "../telemetry";
import { version as packageVersion } from "../../package.json";
import { registerServer, unregisterServer, updateServer, listServers, formatUptime, getDefaultLogFilePath, type ServerEntry, type ServerProjectEntry } from "../utils/server-registry";
import { startLogFile, type LogFileHandle } from "../utils/log-file";
import { loadGlobalConfig, expandHome, getGlobalConfigPath, getGlobalEnvPath, loadGlobalEnv, type GlobalConfig } from "../utils/global-config";
import { SlackApprovalSocket, updateSlackApprovalRequestStatus, type SlackApprovalDecision } from "../slack/approval";
import { homedir } from "os";
import { StoreFileSchema } from "../store/schema";
import type { StoreItem } from "../store/types";

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

function isJsonLikeContent(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed || (!trimmed.startsWith('{') && !trimmed.startsWith('['))) return false;
  try {
    JSON.parse(trimmed);
    return true;
  } catch {
    return false;
  }
}

function looksLikeMarkdown(value: string): boolean {
  const trimmed = value.trim();
  if (!trimmed) return false;
  return /(^|\n)(#{1,6}\s|\s*[-*+]\s|\s*\d+\.\s|>\s|```|\|.+\|)/.test(trimmed) ||
    /\[[^\]]+\]\([^)]+\)/.test(trimmed) ||
    /\*\*[^*]+\*\*/.test(trimmed) ||
    /https?:\/\/[^\s)]+/.test(trimmed) ||
    /`[^`]+`/.test(trimmed);
}

function renderInlineMarkdown(value: string): string {
  return escapeHtml(value)
    .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
    .replace(/`([^`]+)`/g, '<code>$1</code>')
    .replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>')
    .replace(/(^|[\s(])(https?:\/\/[^\s<)]+)/g, '$1<a href="$2" target="_blank" rel="noopener noreferrer">$2</a>');
}

function renderMarkdownTextBlock(value: string): string {
  const lines = value.split(/\r?\n/);
  const html: string[] = [];
  let paragraph: string[] = [];
  let list: { type: 'ul' | 'ol'; items: string[] } | null = null;
  let quote: string[] = [];

  const flushParagraph = () => {
    if (paragraph.length === 0) return;
    html.push(`<p>${paragraph.map(renderInlineMarkdown).join('<br>')}</p>`);
    paragraph = [];
  };
  const flushList = () => {
    if (!list) return;
    html.push(`<${list.type}>${list.items.map(item => `<li>${renderInlineMarkdown(item)}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  const flushQuote = () => {
    if (quote.length === 0) return;
    html.push(`<blockquote>${quote.map(line => `<p>${renderInlineMarkdown(line)}</p>`).join('')}</blockquote>`);
    quote = [];
  };
  const flushAll = () => {
    flushParagraph();
    flushList();
    flushQuote();
  };

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      flushAll();
      continue;
    }
    const heading = trimmed.match(/^(#{1,6})\s+(.+)$/);
    if (heading) {
      flushAll();
      const level = Math.min(6, heading[1].length + 1);
      html.push(`<h${level}>${renderInlineMarkdown(heading[2])}</h${level}>`);
      continue;
    }
    const unordered = trimmed.match(/^[-*+]\s+(.+)$/);
    if (unordered) {
      flushParagraph();
      flushQuote();
      if (!list || list.type !== 'ul') {
        flushList();
        list = { type: 'ul', items: [] };
      }
      list.items.push(unordered[1]);
      continue;
    }
    const ordered = trimmed.match(/^\d+\.\s+(.+)$/);
    if (ordered) {
      flushParagraph();
      flushQuote();
      if (!list || list.type !== 'ol') {
        flushList();
        list = { type: 'ol', items: [] };
      }
      list.items.push(ordered[1]);
      continue;
    }
    const blockquote = trimmed.match(/^>\s?(.*)$/);
    if (blockquote) {
      flushParagraph();
      flushList();
      quote.push(blockquote[1]);
      continue;
    }
    flushList();
    flushQuote();
    paragraph.push(trimmed);
  }
  flushAll();
  return html.join('');
}

function renderMarkdownBlock(value: string): string {
  const html: string[] = [];
  let cursor = 0;
  const fencePattern = /```([A-Za-z0-9_-]+)?\s*\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;
  while ((match = fencePattern.exec(value)) !== null) {
    const before = value.slice(cursor, match.index);
    if (before.trim()) html.push(renderMarkdownTextBlock(before));
    const language = match[1] ? ` data-language="${escapeHtml(match[1])}"` : '';
    html.push(`<pre class="content-code"${language}><code>${escapeHtml(match[2].trim())}</code></pre>`);
    cursor = match.index + match[0].length;
  }
  const rest = value.slice(cursor);
  if (rest.trim()) html.push(renderMarkdownTextBlock(rest));
  return `<div class="content-markdown">${html.join('')}</div>`;
}

function isReadableJsonString(value: string): boolean {
  return value.length > 120 || value.includes('\n') || value.includes('\t');
}

function renderJsonFieldValue(value: unknown): string {
  if (typeof value === 'string') {
    if (isReadableJsonString(value)) {
      return `<pre class="content-code text decoded-json-string"><code>${escapeHtml(value)}</code></pre>`;
    }
    return `<code class="json-inline-string">${escapeHtml(JSON.stringify(value))}</code>`;
  }
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return `<code class="json-inline-literal">${escapeHtml(JSON.stringify(value))}</code>`;
  }
  return `<pre class="content-code json"><code>${escapeHtml(JSON.stringify(value, null, 2))}</code></pre>`;
}

function renderSmartJsonBlock(parsed: unknown): string {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return `<pre class="content-code json"><code>${escapeHtml(JSON.stringify(parsed, null, 2))}</code></pre>`;
  }
  const entries = Object.entries(parsed as Record<string, unknown>);
  if (!entries.some(([, value]) => typeof value === 'string' && isReadableJsonString(value))) {
    return `<pre class="content-code json"><code>${escapeHtml(JSON.stringify(parsed, null, 2))}</code></pre>`;
  }
  return `<div class="json-object-block" role="group" aria-label="JSON object">${entries.map(([key, fieldValue]) => `
    <div class="json-field">
      <div class="json-field-key">${escapeHtml(key)}</div>
      <div class="json-field-value">${renderJsonFieldValue(fieldValue)}</div>
    </div>
  `).join('')}</div>`;
}

function renderLogContentValue(value: string, options?: { forceMarkdown?: boolean }): string {
  if (isJsonLikeContent(value)) {
    return renderSmartJsonBlock(JSON.parse(value));
  }
  if (options?.forceMarkdown || looksLikeMarkdown(value)) {
    return renderMarkdownBlock(value);
  }
  return `<pre class="content-code text"><code>${escapeHtml(value)}</code></pre>`;
}

function valueAsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function storeItemTitle(item: StoreItem): string {
  if (item.title) return item.title;
  const data = valueAsRecord(item.data);
  const candidates = ['title', 'name', 'headline', 'subject', 'url'];
  for (const key of candidates) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return item.id;
}

function storeItemPreview(item: StoreItem, max = 180): string {
  const data = valueAsRecord(item.data);
  const candidates = ['summary', 'description', 'note_excerpt', 'excerpt', 'draft', 'body', 'content', 'why_engage'];
  for (const key of candidates) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) {
      const compact = value.trim().replace(/\s+/g, ' ');
      return compact.length > max ? `${compact.slice(0, max)}…` : compact;
    }
  }
  const json = JSON.stringify(item.data);
  return json.length > max ? `${json.slice(0, max)}…` : json;
}

function parseStoreToolPayload(message?: string): Record<string, unknown> | undefined {
  if (!message || !isJsonLikeContent(message)) return undefined;
  try {
    const parsed = JSON.parse(message);
    return valueAsRecord(parsed);
  } catch {
    return undefined;
  }
}

function storeToolEvent(entry: ApprovalLogEntry, projectId?: string): { store?: string; itemId?: string; item?: StoreItem; href?: string } | undefined {
  if (!entry.tool?.startsWith('store_')) return undefined;
  const payload = parseStoreToolPayload(entry.message);
  if (!payload) return undefined;
  const item = valueAsRecord(payload.item) as unknown as StoreItem;
  const store = typeof payload.store === 'string' && payload.store ? payload.store : undefined;
  const itemId = typeof payload.itemId === 'string' && payload.itemId
    ? payload.itemId
    : typeof item.id === 'string' && item.id
      ? item.id
      : undefined;
  const params = new URLSearchParams();
  if (projectId) params.set('project', projectId);
  if (itemId) params.set('highlight', itemId);
  const href = store
    ? `/stores/${encodeURIComponent(store)}${params.toString() ? `?${params.toString()}` : ''}`
    : undefined;
  return {
    ...(store ? { store } : {}),
    ...(itemId ? { itemId } : {}),
    ...(typeof item.id === 'string' ? { item } : {}),
    ...(href ? { href } : {})
  };
}

function renderStoreToolEvent(entry: ApprovalLogEntry, projectId?: string): string {
  const event = storeToolEvent(entry, projectId);
  if (!event) return '';
  const item = event.item;
  const summary = item
    ? `<div class="store-event-title">${escapeHtml(storeItemTitle(item))}</div>
       <div class="store-event-meta">
        ${item.type ? `<span>${escapeHtml(item.type)}</span>` : ''}
        ${item.status ? `<span>${escapeHtml(item.status)}</span>` : ''}
        ${event.itemId ? `<code>${escapeHtml(event.itemId)}</code>` : ''}
       </div>
       <div class="store-event-preview">${escapeHtml(storeItemPreview(item))}</div>`
    : `<div class="store-event-title">${escapeHtml(event.itemId ?? 'Store operation')}</div>`;
  return `<div class="store-event">
    <div>
      ${event.store ? `<div class="store-event-store">Store: <code>${escapeHtml(event.store)}</code></div>` : ''}
      ${summary}
    </div>
    ${event.href ? `<a class="store-event-link" href="${escapeHtml(event.href)}">Open in Store</a>` : ''}
  </div>`;
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
  options?: { actions?: ApprovalActionDef[]; actionable?: boolean; currentResumeToken?: string | undefined; projectId?: string | undefined }
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
    const isApprovalEntry = entry.status === 'pending' && Boolean(entry.details?.resumeToken);
    const expandable = entry.type === 'tool' && !isApprovalEntry;
    const expanded = !expandable;
    const resumeTokenAttr = entry.details?.resumeToken
      ? ` data-resume-token="${escapeHtml(entry.details.resumeToken)}"`
      : '';
    const storeEventHtml = renderStoreToolEvent(entry, options?.projectId);
    return `
        <li class="log-item ${escapeHtml(entry.status ?? '')}${expandable ? ' expandable' : ''}${expanded ? ' expanded' : ''}" data-log-id="${escapeHtml(entry.id)}" data-log-type="${escapeHtml(entry.type)}"${resumeTokenAttr}${expandable ? ` aria-expanded="${expanded ? 'true' : 'false'}" tabindex="0"` : ''}>
          <span class="log-time">${escapeHtml(formatLogTime(entry.time))}</span>
          <span class="log-marker">⋮</span>
          <span class="log-main">
            <span class="log-title">${escapeHtml(entry.title)}</span>
            <span class="log-content">
              ${storeEventHtml}
              ${entry.details ? renderApprovalDetailBlock(entry.details) : ''}
              ${entry.message && !storeEventHtml ? renderLogContentValue(entry.message, { forceMarkdown: entry.type === 'text' }) : ''}
            </span>
            ${showActions ? renderInlineActions(actions) : ''}
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
      position: sticky;
      top: 0;
      z-index: 50;
      display: grid;
      grid-template-columns: 1fr auto 1fr;
      align-items: center;
      padding: 16px 24px;
      border-bottom: 1px solid var(--line);
      background: var(--bg);
      font-size: 12px;
      color: var(--muted);
    }
    .topbar .brand { display: inline-flex; align-items: center; color: var(--fg); font-weight: 500; letter-spacing: 0.02em; }
    .topbar .brand-name { color: var(--fg); }
    .topbar .nav-wrap { justify-self: center; }
    .topbar .nav {
      display: inline-flex;
      gap: 4px;
      align-items: center;
      padding: 2px;
      border: 1px solid var(--line);
      border-radius: 999px;
      background: var(--panel);
    }
    .topbar .nav-item {
      display: inline-flex;
      align-items: center;
      min-height: 24px;
      padding: 0 10px;
      border: 0;
      border-radius: 999px;
      color: var(--muted-2);
      text-decoration: none;
      transition: color 120ms ease, background 120ms ease;
    }
    .topbar .nav a.nav-item:hover { opacity: 1; color: var(--muted-3); background: var(--panel-hover); }
    .topbar .nav-item.active { color: var(--fg); background: var(--bg); border: 1px solid var(--line); }
    .topbar .right { display: inline-flex; gap: 18px; align-items: center; justify-self: end; }
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
      .topbar { padding: 12px 16px; grid-template-columns: 1fr auto; gap: 10px; }
      .topbar .nav-wrap { grid-column: 1 / -1; grid-row: 2; justify-self: center; }
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

function approvalsTopbarMarkup(opts: { right?: string; isCurrentPage?: boolean; currentPage?: 'approvals' | 'stores' }): string {
  const currentPage = opts.currentPage ?? (opts.isCurrentPage ? 'approvals' : undefined);
  const approvalsMarkup = `<a class="nav-item${currentPage === 'approvals' ? ' active' : ''}" href="/approvals"${currentPage === 'approvals' ? ' aria-current="page"' : ''}>approvals</a>`;
  const storesMarkup = `<a class="nav-item${currentPage === 'stores' ? ' active' : ''}" href="/stores"${currentPage === 'stores' ? ' aria-current="page"' : ''}>stores</a>`;
  return `<div class="topbar">
    <span class="brand"><span class="brand-name">agentuse</span></span>
    <span class="nav-wrap"><span class="nav" role="navigation" aria-label="AgentUse serve">${approvalsMarkup}${storesMarkup}</span></span>
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

interface StoreBrowserSummary {
  projectId: string;
  name: string;
  itemCount: number;
  updatedAt?: number;
  types: string[];
  statuses: string[];
}

interface StoreBrowserRows {
  projectId: string;
  storeName: string;
  items: StoreItem[];
}

interface StoreProjectRef {
  id: string;
  root: string;
}

function isSafeStoreName(storeName: string): boolean {
  return Boolean(storeName) &&
    !storeName.includes('\0') &&
    !storeName.split('/').some((part) => part === '' || part === '..');
}

function resolveStoreRoot(projectRoot: string): string {
  return join(projectRoot, '.agentuse', 'store');
}

async function readStoreItems(projectRoot: string, storeName: string): Promise<StoreItem[]> {
  if (!isSafeStoreName(storeName)) throw new Error('Invalid store name');
  const storePath = join(resolveStoreRoot(projectRoot), storeName, 'items.json');
  const parsed = StoreFileSchema.parse(JSON.parse(await readFile(storePath, 'utf-8')));
  return parsed.items as StoreItem[];
}

async function listProjectStores(project: StoreProjectRef): Promise<{ stores: StoreBrowserSummary[]; errors: Array<{ storeName?: string; message: string }> }> {
  const storeRoot = resolveStoreRoot(project.root);
  if (!existsSync(storeRoot)) return { stores: [], errors: [] };
  const stores: StoreBrowserSummary[] = [];
  const errors: Array<{ storeName?: string; message: string }> = [];
  const files = await glob('**/items.json', { cwd: storeRoot, nodir: true, dot: true });

  for (const file of files.sort()) {
    const storeName = dirname(file);
    if (!isSafeStoreName(storeName)) continue;
    try {
      const items = await readStoreItems(project.root, storeName);
      const timestamps = items
        .map((item) => Date.parse(item.updatedAt))
        .filter((value) => Number.isFinite(value));
      const types = [...new Set(items.map((item) => item.type).filter((value): value is string => Boolean(value)))].sort();
      const statuses = [...new Set(items.map((item) => item.status).filter((value): value is string => Boolean(value)))].sort();
      stores.push({
        projectId: project.id,
        name: storeName,
        itemCount: items.length,
        ...(timestamps.length > 0 && { updatedAt: Math.max(...timestamps) }),
        types,
        statuses
      });
    } catch (err) {
      errors.push({ storeName, message: (err as Error).message });
    }
  }

  stores.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.name.localeCompare(b.name));
  return { stores, errors };
}

async function listStoreRows(project: StoreProjectRef, storeName: string): Promise<StoreBrowserRows> {
  const items = await readStoreItems(project.root, storeName);
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { projectId: project.id, storeName, items };
}

async function findStoreItem(project: StoreProjectRef, storeName: string, itemId: string): Promise<StoreItem | null> {
  const items = await readStoreItems(project.root, storeName);
  return items.find((item) => item.id === itemId) ?? null;
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
    .store-table th { color: var(--muted-2); font-size: 11px; letter-spacing: 0.12em; text-transform: uppercase; font-weight: 500; background: var(--panel); }
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
    @media (max-width: 760px) {
      .store-table th:nth-child(4), .store-table td:nth-child(4),
      .store-table th:nth-child(5), .store-table td:nth-child(5) { display: none; }
      h1 { font-size: 28px; }
    }
  `;
}

function renderStoresIndexPage(options: {
  stores: StoreBrowserSummary[];
  errors: Array<{ projectId: string; storeName?: string; message: string }>;
  multiProject: boolean;
}): string {
  const rows = options.stores.map((store) => {
    const params = new URLSearchParams();
    if (options.multiProject) params.set('project', store.projectId);
    const href = `/stores/${encodeURIComponent(store.name)}${params.toString() ? `?${params.toString()}` : ''}`;
    return `<tr>
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
      ${rows ? `<table class="store-table">
        <thead><tr><th>Store</th><th>Items</th><th>Updated</th><th>Types</th><th>Status</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">No stores found for this serve instance.</div>'}
    </div>
  </main>
  <script>${approvalsThemeToggleScript()}</script>
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
  const allRows = options.rows.flatMap((group) => group.items.map((item) => ({ projectId: group.projectId, item })));
  const rows = allRows.map(({ projectId, item }) => {
    const highlighted = options.highlight && item.id === options.highlight;
    const params = new URLSearchParams();
    if (options.multiProject) params.set('project', projectId);
    const href = `/stores/${encodeURIComponent(options.storeName)}/${encodeURIComponent(item.id)}${params.toString() ? `?${params.toString()}` : ''}`;
    return `<tr id="store-item-${escapeHtml(item.id)}" class="clickable${highlighted ? ' highlighted' : ''}" data-store-item-id="${escapeHtml(item.id)}" data-href="${escapeHtml(href)}">
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
      <p class="lede">${allRows.length} item${allRows.length === 1 ? '' : 's'} visible in this serve instance.</p>
    </header>
    ${errors}
    <div class="panel">
      ${rows ? `<table class="store-table">
        <thead><tr><th>Item</th><th>Status / type</th><th>Updated</th><th>Created by</th><th>ID</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>` : '<div class="empty">No items found in this store.</div>'}
    </div>
  </main>
  <script>
    ${approvalsThemeToggleScript()}
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
    currentPage: 'approvals',
    right: approvalsThemeToggleHtml()
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
      <ul id="logs" class="logs">${renderLogItems(initialLogs, { actions, actionable, currentResumeToken: approval.currentResumeToken, projectId })}</ul>
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
    function logDetailsHtml(details) {
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
    function objectValue(value) {
      return value && typeof value === 'object' && !Array.isArray(value) ? value : {};
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
      const isApprovalEntry = entry.status === 'pending' && Boolean(entry.details && entry.details.resumeToken);
      const expandable = entry.type === 'tool' && !isApprovalEntry;
      const expanded = !expandable || expandedLogIds.has(String(entry.id));
      const resumeTokenAttr = entry.details && entry.details.resumeToken
        ? ' data-resume-token="' + escapeText(entry.details.resumeToken) + '"'
        : '';
      const storeHtml = storeEventHtml(entry);
      return '<li class="log-item ' + escapeText(entry.status || '') + (expandable ? ' expandable' : '') + (expanded ? ' expanded' : '') + '" data-log-id="' + escapeText(entry.id) + '" data-log-type="' + escapeText(entry.type) + '"' + resumeTokenAttr + (expandable ? ' aria-expanded="' + String(expanded) + '" tabindex="0"' : '') + '>' +
        '<span class="log-time">' + escapeText(formatTime(entry.time)) + '</span>' +
        '<span class="log-marker">⋮</span>' +
        '<span class="log-main"><span class="log-title">' + escapeText(entry.title) + '</span>' +
        '<span class="log-content">' +
        storeHtml +
        logDetailsHtml(entry.details) +
        (entry.message && !storeHtml ? renderLogContentValue(entry.message, { forceMarkdown: entry.type === 'text' }) : '') +
        '</span>' +
        logActionsHtml(entry) +
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
      scrollToActiveApproval();
    }
    let lastScrolledResumeToken = null;
    function activeApprovalElement() {
      if (currentResumeToken) {
        return logsEl.querySelector('[data-resume-token="' + CSS.escape(currentResumeToken) + '"]');
      }
      return logsEl.querySelector('.log-item.pending') || logsEl.lastElementChild;
    }
    function scrollToActiveApproval(force) {
      const target = activeApprovalElement();
      if (!target) return;
      const tokenForScroll = currentResumeToken || 'latest';
      if (!force && lastScrolledResumeToken === tokenForScroll) return;
      lastScrolledResumeToken = tokenForScroll;
      requestAnimationFrame(function () {
        target.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      submittingDecision = false;
      for (const b of document.querySelectorAll('button[data-action]')) b.disabled = false;
      // Keep the URL in sync so a refresh lands on the active gate.
      if (approval.approvalUrl) {
        try { history.replaceState(null, '', approval.approvalUrl); } catch {}
      }
      scrollToActiveApproval(true);
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
    scrollToActiveApproval();
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

      // Check if any requested project root is already served
      const existingServers = listServers();
      for (const p of projectSeeds) {
        const clash = existingServers.find((s) => {
          const servedRoots = s.projects && s.projects.length > 0
            ? s.projects.flatMap((sp) => [sp.root, ...(sp.scopeRoot ? [sp.scopeRoot] : [])])
            : [s.projectRoot];
          return servedRoots.some((servedRoot) =>
            servedRoot === p.root ||
            servedRoot === p.scopeRoot ||
            isPathInside(servedRoot, p.scopeRoot) ||
            isPathInside(p.scopeRoot, servedRoot)
          );
        });
        if (clash) {
          console.error(chalk.red(`\nError: a server is already running for ${p.scopeRoot}.`));
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
              ...(p.scopeRoot !== p.root && { scope: p.scopeRoot }),
              agentCount: agentCounts.get(p.id) ?? 0,
              scheduleCount: scheduler.list().filter((s) => s.projectId === p.id).length,
            })),
          };
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(info));
          return;
        }

        if (req.method === "GET" && requestUrl.pathname === '/stores') {
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

          if (wantsJson(requestUrl, req)) {
            sendJSON(res, 200, { success: true, stores, errors });
            return;
          }

          sendHTML(res, 200, renderStoresIndexPage({ stores, errors, multiProject: selectedProjects.length > 1 }));
          return;
        }

        const storePageMatch = req.method === "GET" ? requestUrl.pathname.match(/^\/stores\/([^/?#]+)$/) : null;
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

          if (wantsJson(requestUrl, req)) {
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

        const storeItemPageMatch = req.method === "GET" ? requestUrl.pathname.match(/^\/stores\/([^/?#]+)\/([^/?#]+)$/) : null;
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

          if (wantsJson(requestUrl, req)) {
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
          console.log(`  ${chalk.dim("Project")}   ${projects[0].root}`);
          if (projects[0].scopeRoot !== projects[0].root) {
            console.log(`  ${chalk.dim("Scope")}     ${projects[0].scopeRoot}`);
          }
          console.log(`  ${chalk.dim("Store")}     ${join(projects[0].root, '.agentuse', 'store')}`);
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
