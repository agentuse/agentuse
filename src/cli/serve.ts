import { Command } from "commander";
import { createServer, IncomingMessage, ServerResponse } from "http";
import { timingSafeEqual } from "crypto";
import { spawn, type ChildProcess } from "child_process";
import { join, resolve, basename, relative, extname, dirname } from "path";
import { createReadStream, existsSync, realpathSync } from "fs";
import { readFile, stat } from "fs/promises";
import { glob } from "glob";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import chalk from "chalk";
import * as dotenv from "dotenv";
import { parseAgent } from "../parser";
import { formatScheduleHuman } from "../scheduler/parser";
import { type AgentChunk } from "../runner";
import { findProjectRoot, resolveProjectContext } from "../utils/project";
import { logger, LogLevel, executionLog, approvalLog } from "../utils/logger";
import { printLogo } from "../utils/branding";
import { getSessionStorageDir, initStorage } from "../storage/index.js";
import { findGateSnapshotFile } from "../session/gate-artifacts.js";
import { getXdgDataDir } from "../storage/paths.js";
import { Scheduler, type Schedule, type SerializedSchedule } from "../scheduler";
import { FileWatcher } from "../watcher";
import {
  telemetry,
  classifyExecution,
  configuredFeatureUsage,
  emptyToolCallMetrics,
  parseModel,
  type ToolCallMetrics,
  type OnboardingRoute,
  type OnboardingStep,
  type WebUIClientSurface,
  type WebUITelemetryEvent,
} from "../telemetry";
import { version as packageVersion } from "../../package.json";
import { getCachedAvailableUpdate, refreshUpdateCacheInBackground } from "../update-check";
import { registerServer, unregisterServer, updateServer, listServers, formatUptime, getDefaultLogFilePath, type ServerEntry, type ServerProjectEntry } from "../utils/server-registry";
import { acquireSchedulerLock, releaseSchedulerLock } from "../utils/scheduler-lock";
import { startLogFile, type LogFileHandle } from "../utils/log-file";
import { loadGlobalConfig, applyGlobalConfigEnv, expandHome, getGlobalConfigPath, getGlobalEnvPath, getManagedProjectsRoot, loadGlobalEnv, type GlobalConfig } from "../utils/global-config";
import { createManagedProjectTransaction, ManagedProjectError } from "../utils/managed-project";
import { SlackApprovalSocket, updateSlackApprovalRequestStatus, type SlackApprovalDecision, type SlackApprovalThreadComment, type SlackApprovalThreadCommentResult, type SlackRunThreadCommentResult } from "../slack/approval";
import { getSlackWebClient } from "../slack/lifecycle";
import { saveManualLearning, LearningStore, effectiveCap, partitionLearnings, consolidateLearnings, undoConsolidation, readTidyRecord, writeTidyRecord, clearTidyRecord, strandedLearningsFile, type LearningConfig, type ConsolidationResult, type TidyProgress } from "../learning";
import { homedir } from "os";
import type { StoreItem } from "../store/types";
import type { ActiveContextUsage, SessionTrigger } from "../session/types";
import type { DescendantBreadcrumb, ImportantDescendantEvent, ImportantDescendantKind, ImportantDescendantSummary } from "../session/important-descendants";
import { ulid } from "ulid";
import { sessionViewToken, validateSessionToken } from "../utils/session-token";
import { readArtifactManifest, getManifestPath } from "../tools/artifact-manifest";
import {
  approvalListThemeStyles,
  escapeHtml,
  renderMarkdownArtifact,
  normalizeApiPath
} from "./serve/ui";
import { FAVICON_SVG, TOUCH_ICON_180_PNG_BASE64, ICON_192_PNG_BASE64, ICON_512_PNG_BASE64, webManifestJson } from "./serve/brand";

// Decoded once; brand.ts itself stays Buffer-free because the web bundle
// shares it (see the note in brand.ts).
const TOUCH_ICON_180_PNG = Buffer.from(TOUCH_ICON_180_PNG_BASE64, "base64");
const ICON_192_PNG = Buffer.from(ICON_192_PNG_BASE64, "base64");
const ICON_512_PNG = Buffer.from(ICON_512_PNG_BASE64, "base64");
import { WebAssets, renderWebAssetsMissingPage } from "./serve/static";
import { readAbout, type AboutInfo } from "./serve/about";
import { PushService, SERVICE_WORKER_JS, type PushCategory, type PushPayload } from "./serve/push";
import { ApprovalEventHub, ApprovalListEventHub, NotificationEventHub } from "./serve/sse";
import {
  findStoreItem,
  isSafeStoreName,
  listProjectStores,
  listStoreRows,
  type StoreBrowserRows,
  type StoreBrowserSummary
} from "./serve/stores";
// Type-only, so this stays erased at compile and adds nothing to the bundle.
// The context payload is elaborate enough that a hand-kept local copy (as the
// older session types above are) would drift from the page that consumes it.
import type { SessionContextPayload } from "./serve/types";
import { startOrphanReconcileLoop } from "./serve/orphan-reconcile";
import { ONBOARDING_AGENT_ID, ONBOARDING_AGENT_SOURCE } from "../onboarding";
import { openBrowser } from "../utils/open-browser";

const APPROVAL_LIST_SSE_INTERVAL_MS = 10_000;
const SESSION_LIST_SSE_INTERVAL_MS = 10_000;
/** Faster session-list cadence while any session is live, so the dashboard tracks runs in near-real-time. */
const SESSION_LIST_SSE_LIVE_INTERVAL_MS = 2_000;

/**
 * A tidy-up in flight, or one this process finished recently.
 *
 * The pass is minutes of model work on a large corrections file, far too long to
 * hold a request open for: the browser or a proxy times out and the user is left
 * with two rewritten files and no idea what happened. So the request starts a
 * job and returns its id, and the page polls this registry.
 */
interface TidyJob {
  id: string;
  project: string;
  path: string;
  agentFilePath: string;
  stateRoot: string;
  startedAt: number;
  finishedAt?: number;
  status: 'running' | 'done' | 'error' | 'undone';
  phase: TidyProgress['phase'];
  step: number;
  total: number;
  round: number;
  maxRounds: number;
  projectedActive: number;
  cap: number;
  dryRun: boolean;
  result?: ConsolidationResult;
  error?: string;
}

const tidyJobs = new Map<string, TidyJob>();
/** How long a finished job stays queryable in memory. Beyond this the page
 *  falls back to the record on disk, which is what survives a daemon restart. */
const TIDY_JOB_RETENTION_MS = 6 * 60 * 60 * 1000;

function pruneTidyJobs(now = Date.now()): void {
  for (const [id, job] of tidyJobs) {
    if (job.finishedAt && now - job.finishedAt > TIDY_JOB_RETENTION_MS) tidyJobs.delete(id);
  }
}

/** The running job for this agent, if any. A second Tidy up press joins the
 *  first rather than starting a competing pass over the same two files. */
function runningTidyJob(project: string, path: string): TidyJob | undefined {
  for (const job of tidyJobs.values()) {
    if (job.status === 'running' && job.project === project && job.path === path) return job;
  }
  return undefined;
}

/** Same question asked by agent file, for the list payload — which knows the
 *  file it is describing but not which project id was used to reach it. */
function runningTidyJobForFile(agentFilePath: string): TidyJob | undefined {
  for (const job of tidyJobs.values()) {
    if (job.status === 'running' && job.agentFilePath === agentFilePath) return job;
  }
  return undefined;
}

function tidyJobView(job: TidyJob) {
  return {
    id: job.id,
    project: job.project,
    path: job.path,
    status: job.status,
    phase: job.phase,
    step: job.step,
    total: job.total,
    round: job.round,
    maxRounds: job.maxRounds,
    projectedActive: job.projectedActive,
    cap: job.cap,
    dryRun: job.dryRun,
    startedAt: job.startedAt,
    ...(job.finishedAt ? { finishedAt: job.finishedAt } : {}),
    ...(job.error ? { error: job.error } : {}),
  };
}

interface RunRequest {
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

function webUIClientSurface(value: string | string[] | undefined): WebUIClientSurface {
  const header = Array.isArray(value) ? value[0] : value;
  return header === 'mac_app' || header === 'mac_setup' ? header : 'web';
}

function reportedSurfaceForRun(body: RunRequest, clientSurface: WebUIClientSurface = 'web'): 'web_ui' | 'mac_app' | 'api' {
  if (body.reportedSurface !== 'web_ui') return 'api';
  return clientSurface === 'mac_app' ? 'mac_app' : 'web_ui';
}

const WEB_UI_TELEMETRY_PAGES = new Set([
  'home', 'agents', 'schedules', 'sessions', 'approvals', 'stores', 'settings', 'learnings', 'other',
]);
const ONBOARDING_TELEMETRY_EVENTS = new Set([
  'onboarding_started', 'onboarding_step_completed', 'onboarding_step_failed', 'onboarding_completed',
]);
const ONBOARDING_ROUTES = new Set<OnboardingRoute>(['web', 'desktop']);
const ONBOARDING_STEPS = new Set<OnboardingStep>([
  'desktop_setup', 'project_created', 'sample_run_completed', 'agent_prompt_copied', 'agent_detected', 'agent_opened',
]);
const ONBOARDING_ERROR_CODES = new Set([
  'project_create_failed', 'sample_run_failed', 'provider_status_failed', 'agent_check_failed',
  'cli_launcher_add_failed', 'desktop_setup_failed',
]);
const CLI_LAUNCHER_STATUSES = new Set(['already_available', 'added', 'skipped', 'conflict']);
const PROVIDER_READINESS = new Set(['ready', 'not_ready', 'unknown']);
const DETECTION_METHODS = new Set(['poll', 'manual_check']);

function boundedTelemetryNumber(value: unknown, max: number): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.min(Math.round(value), max)
    : undefined;
}

function parseWebUITelemetryBody(
  body: Record<string, unknown>,
  clientSurface: WebUIClientSurface = 'web',
): WebUITelemetryEvent | undefined {
  if (body.event === 'page_viewed') {
    if (typeof body.page !== 'string' || !WEB_UI_TELEMETRY_PAGES.has(body.page)) return undefined;
    return {
      event: 'page_viewed',
      page: body.page as Extract<WebUITelemetryEvent, { event: 'page_viewed' }>['page'],
      clientSurface,
    };
  }
  if (body.event === 'desktop_app_launched') {
    if (clientSurface !== 'mac_app'
      || (body.launch_mode !== 'interactive' && body.launch_mode !== 'login_item_hidden')
      || typeof body.onboarding_complete !== 'boolean'
      || typeof body.login_item_enabled !== 'boolean') {
      return undefined;
    }
    return {
      event: 'desktop_app_launched',
      clientSurface,
      launchMode: body.launch_mode,
      onboardingComplete: body.onboarding_complete,
      loginItemEnabled: body.login_item_enabled,
    };
  }
  if (typeof body.event !== 'string' || !ONBOARDING_TELEMETRY_EVENTS.has(body.event)
    || typeof body.onboarding_route !== 'string' || !ONBOARDING_ROUTES.has(body.onboarding_route as OnboardingRoute)) {
    return undefined;
  }
  const durationMs = boundedTelemetryNumber(body.duration_ms, 24 * 60 * 60 * 1_000);
  const agentCount = boundedTelemetryNumber(body.agent_count, 100);
  const common = {
    onboardingRoute: body.onboarding_route as OnboardingRoute,
    clientSurface,
    ...(durationMs === undefined ? {} : { durationMs }),
    ...(agentCount === undefined ? {} : { agentCount }),
    ...(typeof body.detection_method === 'string' && DETECTION_METHODS.has(body.detection_method)
      ? { detectionMethod: body.detection_method as 'poll' | 'manual_check' }
      : {}),
  };
  if (body.event === 'onboarding_started' || body.event === 'onboarding_completed') {
    return { event: body.event, ...common };
  }
  if (typeof body.step !== 'string' || !ONBOARDING_STEPS.has(body.step as OnboardingStep)) return undefined;
  return {
    event: body.event as 'onboarding_step_completed' | 'onboarding_step_failed',
    ...common,
    step: body.step as OnboardingStep,
    ...(typeof body.error_code === 'string' && ONBOARDING_ERROR_CODES.has(body.error_code)
      ? { errorCode: body.error_code as Extract<WebUITelemetryEvent, { event: 'onboarding_step_failed' }>['errorCode'] }
      : {}),
    ...(typeof body.launch_at_login_enabled === 'boolean'
      ? { launchAtLoginEnabled: body.launch_at_login_enabled }
      : {}),
    ...(typeof body.cli_launcher_status === 'string' && CLI_LAUNCHER_STATUSES.has(body.cli_launcher_status)
      ? { cliLauncherStatus: body.cli_launcher_status as 'already_available' | 'added' | 'skipped' | 'conflict' }
      : {}),
    ...(typeof body.provider_readiness === 'string' && PROVIDER_READINESS.has(body.provider_readiness)
      ? { providerReadiness: body.provider_readiness as 'ready' | 'not_ready' | 'unknown' }
      : {}),
  };
}

function webUITelemetryDedupeKey(value: WebUITelemetryEvent): string {
  if (value.event === 'page_viewed') return `${value.clientSurface}:page:${value.page}`;
  if (value.event === 'desktop_app_launched') return 'mac_app:desktop_app_launched';
  // A Desktop onboarding route moves from mac_setup to the shared mac_app UI.
  // Dedupe across that surface boundary so the route has one lifecycle event.
  return [value.onboardingRoute, value.event, 'step' in value ? value.step : ''].join(':');
}

const WEB_UI_TELEMETRY_DEDUPE_MS = 15 * 60 * 1000;
const WEB_UI_TELEMETRY_RATE_CAPACITY = 20;
const WEB_UI_TELEMETRY_RATE_PER_MS = WEB_UI_TELEMETRY_RATE_CAPACITY / 60_000;

interface WebUITelemetryGuard {
  events: Map<string, number>;
  tokens: number;
  lastRefillAt: number;
}

function createWebUITelemetryGuard(now = Date.now()): WebUITelemetryGuard {
  return { events: new Map(), tokens: WEB_UI_TELEMETRY_RATE_CAPACITY, lastRefillAt: now };
}

/** Daemon-wide guard: limits requests and deduplicates fixed event keys across tabs/reloads. */
function acceptWebUITelemetry(
  guard: WebUITelemetryGuard,
  key: string,
  now = Date.now(),
  deduplicate = true,
): boolean {
  const elapsed = Math.max(0, now - guard.lastRefillAt);
  guard.tokens = Math.min(
    WEB_UI_TELEMETRY_RATE_CAPACITY,
    guard.tokens + elapsed * WEB_UI_TELEMETRY_RATE_PER_MS,
  );
  guard.lastRefillAt = now;
  if (guard.tokens < 1) return false;
  guard.tokens -= 1;
  if (!deduplicate) return true;

  const lastReportedAt = guard.events.get(key);
  if (lastReportedAt !== undefined && now - lastReportedAt < WEB_UI_TELEMETRY_DEDUPE_MS) return false;
  guard.events.set(key, now);
  return true;
}

function canSubmitWebUITelemetry(options: {
  apiKey?: string | undefined;
  authorization?: string | undefined;
  requestOrigin?: string | undefined;
  crossOrigin: boolean;
}): boolean {
  if (!options.apiKey) return !options.crossOrigin;
  if (validateApiKeyHeader(options.authorization, options.apiKey)) return true;
  return !!options.requestOrigin && options.requestOrigin !== 'null' && !options.crossOrigin;
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
  /** In-memory agent definition used by the zero-file onboarding run. */
  agentContent?: string;
  agentName?: string;
  projectRoot: string;
  prompt?: string | undefined;
  model?: string | undefined;
  timeout?: number | undefined;
  maxSteps?: number | undefined;
  debug?: boolean | undefined;
  sessionId?: string | undefined;
  /** Pre-assigned id for a fresh `execute` (detached run). */
  newSessionId?: string | undefined;
  toolResult?: unknown;
  resumeToken?: string | undefined;
  trigger?: SessionTrigger | undefined;
  signal?: AbortSignal | undefined;
}

interface WorkerExecuteResult {
  success: true;
  /** The reporting worker's RSS when the run settled (see worker recycling). */
  workerRssBytes?: number;
  telemetry?: {
    toolCalls: ToolCallMetrics;
    steps: number;
  };
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
  /** The reporting worker's RSS when the run settled (see worker recycling). */
  workerRssBytes?: number;
  telemetry?: WorkerExecuteResult['telemetry'];
  error: {
    code: string;
    message: string;
  };
  /** Final output remains useful when report_incomplete ends the run. */
  result?: WorkerExecuteResult['result'];
}

function workerExecutionErrorResponse(error: WorkerExecuteError): {
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

interface WorkerApprovalInfoResult {
  success: true;
  approval: ApprovalPageInfo;
}

interface WorkerSessionStatusResult {
  success: true;
  session: SessionStatusInfo;
}

interface WorkerSessionContextResult {
  success: true;
  context: SessionContextPayload;
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
type SessionStatusFilter = 'running' | 'suspended' | 'completed' | 'error' | 'incomplete';
/** Triage axis, orthogonal to status: has an ended run been reviewed-and-discarded yet? */
type SessionTriageFilter = 'undismissed' | 'dismissed';
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
  /** The gate offers a pick-among-options menu; one-tap approve is not enough. */
  hasOptions?: boolean;
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
  /** Present only when the caller opted into cursor pagination. */
  nextCursor?: string;
  limit?: number;
}

function isPendingApprovalVisible(
  projectId: string,
  approval: Pick<ApprovalSummary, 'sessionId' | 'status'>,
  activeResumes: { has(key: string): boolean }
): boolean {
  return approval.status === 'pending'
    && !activeResumes.has(`${projectId}:${approval.sessionId}`);
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
  /** Reviewer discarded this ended failed run; needs-attention surfaces skip it. */
  dismissedAt?: number;
  mock?: boolean;
  /** Suspended parent parked on a running delegated child (see serve/types). */
  subagentActive?: boolean;
  finalResponse?: string;
}

type SessionRow = SessionSummary & { project: string };

interface SessionsPayload {
  success: true;
  sessions: SessionRow[];
  window: { value: string; days?: number | 'all'; hours?: number; updatedAfter?: number };
  agent?: string;
  status?: string;
  triage?: SessionTriageFilter;
  trigger?: SessionTrigger;
  approval?: string;
  errors: Array<{ projectId: string; message: string }>;
  /** Present only when the caller opted into cursor pagination. */
  nextCursor?: string;
  limit?: number;
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
  mock?: boolean;
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

interface WorkerSessionFinalResponsesResult {
  success: true;
  responses: Record<string, string>;
}

interface WorkerStopSessionResult {
  success: true;
  stopped: Array<{
    sessionId: string;
    agentId: string;
    agentName: string;
    wasStatus: string;
    stopped: boolean;
    /** Already-ended failed session acknowledged (dismissedAt stamped) instead of stopped. */
    dismissed?: boolean;
  }>;
}

interface WorkerReopenGateResult {
  success: true;
  agentId: string;
}

interface WorkerReconcileResult {
  success: true;
  reconciled: Array<{
    sessionId: string;
    agentId: string;
    agentName: string;
    /** 'interrupted': killed mid-run. 'stranded': parked on a child that ended
     *  with nothing usable. 'finishable': parked on a child whose durable
     *  result can still complete the chain — serve drives finish-cascade. */
    reason?: 'interrupted' | 'stranded' | 'finishable';
  }>;
}

interface ApprovalPageInfo {
  sessionId: string;
  sessionStatus: string;
  /** Resolved project id, stamped by the serve daemon (see findApprovalInfo). */
  project?: string;
  /** Absolute directory watched for agent files, stamped by the serve daemon. */
  projectPath?: string;
  createdAt?: number;
  model?: string;
  agent: {
    id: string;
    name: string;
    filePath?: string;
    /** Scope-relative path of the agent file, stamped by the serve daemon so the
     *  session page can link to the agent detail hub (see findApprovalInfo). */
    runPath?: string;
    description?: string;
  };
  learning?: {
    capture: boolean;
    apply: boolean;
  };
  prompt?: string;
  summary?: string;
  draft?: string;
  changes?: Array<{ label?: string; content: string }>;
  reference?: { label?: string; author?: string; title?: string; url?: string; excerpt?: string };
  options?: Array<{ id: string; label: string; description?: string; recommended?: boolean }>;
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
  importantDescendants?: ImportantDescendantSummary[];
  importantDescendantEvents?: ImportantDescendantEvent[];
  originAgent?: {
    id: string;
    name: string;
    filePath?: string;
    description?: string;
  };
  viewOnly?: boolean;
  rootSessionId?: string;
  parentSessionId?: string;
  parentAgentName?: string;
  parentHref?: string;
  tokenUsage?: SessionTokenUsage;
  logs?: ApprovalLogEntry[];
  mock?: boolean;
}

interface SessionTokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  context?: ActiveContextUsage;
}

interface ApprovalLogEntry {
  id: string;
  type: string;
  tool?: string;
  status?: string;
  /** Severity for `type: 'log'` entries; carried through the worker IPC. */
  level?: 'debug' | 'info' | 'warn' | 'error' | 'system';
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
  parentSessionId?: string;
  depth?: number;
  breadcrumb?: DescendantBreadcrumb[];
  durationMs?: number;
  kinds?: ImportantDescendantKind[];
  important?: boolean;
  phase?: 'revising' | 'awaiting-approval';
  label?: string;
  gateLabel?: string;
  attemptLabel?: string;
  events?: LogSubagentEvent[];
  children?: LogSubagentSession[];
}

type LogSubagentEvent = ImportantDescendantEvent & {
  href?: string;
  displayStatus: string;
};

interface ApprovalLogDetails {
  resumeToken?: string;
  prompt?: string;
  /** Model-declared goal of this call (the injected `intent` parameter). */
  intent?: string;
  input?: string;
  output?: string;
  tokenUsage?: {
    input: number;
    output: number;
    cachedInput: number;
    sharedCalls?: number;
  };
  summary?: string;
  context?: string;
  risk?: string;
  draft?: string;
  changes?: Array<{ label?: string; content: string }>;
  reference?: { label?: string; author?: string; title?: string; url?: string; excerpt?: string };
  options?: Array<{ id: string; label: string; description?: string; recommended?: boolean }>;
  draftUrl?: string;
  artifactUrl?: string;
  /** Project-root-relative paths to local file artifacts, viewable via /sessions/:id/artifacts/*. */
  artifactPaths?: string[];
  decisionStatus?: string;
  decisionComment?: string;
  decisionChoice?: string;
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
    resolve: (value: WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSessionStatusResult | WorkerSessionContextResult | WorkerSweepExpiredResult | WorkerListApprovalsResult | WorkerListSessionsResult | WorkerSessionFinalResponsesResult | WorkerStopSessionResult) => void;
    timeoutId?: NodeJS.Timeout;
  }> = new Map();
  private requestCounter = 0;
  /** Ids of the run requests (execute/resume/continue) in flight right now.
   *  Shutdown uses this to tell a busy worker from an idle one. */
  private activeRuns = new Set<string>();
  private released = false;
  private spawnedAt = 0;
  private recycling = false;
  private ready = false;
  private readyPromise: Promise<void> | null = null;
  private readyResolve: (() => void) | null = null;
  private readyReject: ((error: Error) => void) | null = null;
  private spawnPromise: Promise<void> | null = null;
  private shuttingDown = false;
  private respawnTimer: NodeJS.Timeout | null = null;
  private respawnAttempts = 0;
  /** Invoked whenever the worker becomes ready — the initial spawn AND every
   *  respawn — with the ready timestamp. serve uses it to reconcile sessions the
   *  dead worker left stuck as 'running'. Must never throw. */
  onReady?: (readyAt: number) => void;

  constructor(private envOverrides: NodeJS.ProcessEnv = {}) {}

  /**
   * Spawn the worker process. Must be called during server startup (sync context).
   */
  spawn(): Promise<void> {
    if (this.process && this.ready) return Promise.resolve();
    if (this.spawnPromise) return this.spawnPromise;
    this.shuttingDown = false;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }

    // Fork the same CLI with --internal-worker flag
    // This avoids needing a separate worker bundle - more elegant for npm package
    const cliPath = process.argv[1];

    this.readyPromise = new Promise((resolve, reject) => {
      this.readyResolve = resolve;
      this.readyReject = reject;

      // Timeout if worker doesn't become ready within 10 seconds
      const startupTimeout = setTimeout(() => {
        if (!this.ready) {
          reject(new Error("Worker failed to start within 10 seconds"));
          this.process?.kill("SIGTERM");
        }
      }, 10000);

      // Clear timeout when ready
      const originalResolve = this.readyResolve;
      this.readyResolve = () => {
        clearTimeout(startupTimeout);
        this.readyReject = null;
        originalResolve?.();
        // Fire after resolve so a reconciliation kicked off here can't wedge the
        // spawn promise. onReady must never throw, but guard anyway.
        try { this.onReady?.(Date.now()); } catch {/* ignore */}
      };
    });

    this.spawnedAt = Date.now();
    const child = spawn(process.execPath, [cliPath, "--internal-worker"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.envOverrides,
      },
    });
    this.process = child;

    this.readline = createInterface({
      input: child.stdout!,
      terminal: false,
    });

    this.readline.on("line", (line) => {
      this.handleWorkerMessage(line);
    });

    child.stderr?.on("data", (data) => {
      logger.debug(`[Worker stderr] ${data.toString().trim()}`);
    });

    child.on("error", (err) => {
      if (this.process !== child) return;
      logger.error(`Worker process error: ${err.message}`);
      this.handleWorkerDeath();
    });

    child.on("exit", (code) => {
      if (this.process !== child) return;
      logger.warn(`Worker process exited with code ${code}`);
      this.handleWorkerDeath();
    });

    this.spawnPromise = this.readyPromise
      .then(() => {
        this.respawnAttempts = 0;
      })
      .finally(() => {
        this.spawnPromise = null;
      });
    return this.spawnPromise;
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
    if (this.readyReject) {
      this.readyReject(new Error("Worker process died before becoming ready"));
      this.readyReject = null;
      this.readyResolve = null;
    }

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
    this.activeRuns.clear();
    this.scheduleRespawn();
  }

  private scheduleRespawn() {
    if (this.shuttingDown || this.respawnTimer || this.spawnPromise) return;
    const delayMs = Math.min(30_000, 500 * 2 ** this.respawnAttempts);
    this.respawnAttempts += 1;
    this.respawnTimer = setTimeout(() => {
      this.respawnTimer = null;
      this.spawn().catch((error) => {
        logger.warn(`Worker respawn failed: ${(error as Error).message}`);
        this.scheduleRespawn();
      });
    }, delayMs);
    this.respawnTimer.unref?.();
  }

  /**
   * Execute an agent via the worker process.
   */
  execute(options: WorkerExecuteOptions): Promise<WorkerExecuteResult | WorkerExecuteError> {
    return this.request({
      type: options.sessionId && !options.agentPath && !options.agentContent ? "resume" : "execute",
      agentPath: options.agentPath,
      agentContent: options.agentContent,
      agentName: options.agentName,
      projectRoot: options.projectRoot,
      prompt: options.prompt,
      model: options.model,
      timeout: options.timeout,
      maxSteps: options.maxSteps,
      debug: options.debug,
      sessionId: options.sessionId,
      newSessionId: options.newSessionId,
      toolResult: options.toolResult,
      resumeToken: options.resumeToken,
      trigger: options.trigger,
    }, { signal: options.signal }) as Promise<WorkerExecuteResult | WorkerExecuteError>;
  }

  stopSession(options: {
    projectRoot: string;
    sessionId: string;
    reason?: string | undefined;
    /** Reviewer-initiated stop: an already-ended failed session is stamped
     *  dismissedAt (reviewed) instead of being a no-op. Never set on automatic
     *  stops (client-disconnect, timeouts) — those must not acknowledge
     *  failures no human has seen. */
    dismissEnded?: boolean | undefined;
  }): Promise<WorkerStopSessionResult | WorkerExecuteError> {
    return this.request({
      type: "stop-session",
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      reason: options.reason,
      ...(options.dismissEnded && { dismissEnded: true }),
      timeout: 30,
    }) as Promise<WorkerStopSessionResult | WorkerExecuteError>;
  }

  reopenGate(options: {
    projectRoot: string;
    sessionId: string;
  }): Promise<WorkerReopenGateResult | WorkerExecuteError> {
    return this.request({
      type: "reopen-gate",
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      timeout: 30,
    }) as Promise<WorkerReopenGateResult | WorkerExecuteError>;
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

  getSessionContext(options: {
    projectRoot: string;
    sessionId: string;
  }): Promise<WorkerSessionContextResult | WorkerExecuteError> {
    return this.request({
      type: "session-context",
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      timeout: 30,
    }) as Promise<WorkerSessionContextResult | WorkerExecuteError>;
  }

  sweepExpired(projectRoot: string): Promise<WorkerSweepExpiredResult | WorkerExecuteError> {
    return this.request({
      type: "sweep-expired",
      projectRoot,
      timeout: 30,
    }) as Promise<WorkerSweepExpiredResult | WorkerExecuteError>;
  }

  /**
   * Finish a cascade stranded between a delegated child ending and its
   * ancestors being resumed (issue #199): the worker rebuilds the child's
   * result from storage and runs the normal walk-up. A long-running run
   * request on purpose — it resumes real agent sessions, so it must count
   * toward activeRuns and be released (not killed) on shutdown like any run.
   */
  finishCascade(projectRoot: string, sessionId: string): Promise<WorkerExecuteResult | WorkerExecuteError> {
    return this.request({
      type: "finish-cascade",
      projectRoot,
      sessionId,
    }) as Promise<WorkerExecuteResult | WorkerExecuteError>;
  }

  reconcileOrphans(projectRoot: string, cutoff: number): Promise<WorkerReconcileResult | WorkerExecuteError> {
    return this.request({
      type: "reconcile-orphans",
      projectRoot,
      reconcileCutoff: cutoff,
      timeout: 30,
    }) as Promise<WorkerReconcileResult | WorkerExecuteError>;
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
    options: { updatedAfter?: number; includeSubagents?: boolean; limit?: number; perAgent?: number; mock?: 'exclude' | 'include' | 'only' } = {}
  ): Promise<WorkerListSessionsResult | WorkerExecuteError> {
    return this.request({
      type: "list-sessions",
      projectRoot,
      sessionsUpdatedAfter: options.updatedAfter,
      includeSubagents: options.includeSubagents,
      sessionsLimit: options.limit,
      sessionsPerAgent: options.perAgent,
      sessionsMock: options.mock,
      timeout: 30,
    }) as Promise<WorkerListSessionsResult | WorkerExecuteError>;
  }

  /** Drop this project's cached lists after an out-of-process run changed state.
   *  `externalActivity` additionally keeps the lists hot for a short window, for
   *  pokes that land before the change they announce is readable. */
  invalidateLists(
    projectRoot: string,
    options: { externalActivity?: boolean } = {}
  ): Promise<WorkerExecuteResult | WorkerExecuteError> {
    return this.request({
      type: "invalidate-lists",
      projectRoot,
      ...(options.externalActivity && { externalActivity: true }),
      timeout: 10,
    }) as Promise<WorkerExecuteResult | WorkerExecuteError>;
  }

  getSessionFinalResponses(
    projectRoot: string,
    sessions: Array<{ sessionId: string; agentId: string }>
  ): Promise<WorkerSessionFinalResponsesResult | WorkerExecuteError> {
    return this.request({
      type: "session-final-responses",
      projectRoot,
      sessionRefs: sessions,
      timeout: 30,
    }) as Promise<WorkerSessionFinalResponsesResult | WorkerExecuteError>;
  }

  private async request(
    options: Record<string, unknown> & { timeout?: number | undefined },
    requestOptions: { signal?: AbortSignal | undefined } = {}
  ): Promise<WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSessionStatusResult | WorkerSessionContextResult | WorkerSweepExpiredResult | WorkerListApprovalsResult | WorkerListSessionsResult | WorkerSessionFinalResponsesResult | WorkerStopSessionResult> {
    // A recycle hands the old child its release line and immediately spawns a
    // replacement; a request landing in that sub-second window should wait for
    // the new worker rather than fail. Only ever waits on a spawn already under
    // way (bounded by its own 10s startup timeout) -- a dead worker in respawn
    // backoff has no spawn promise and still answers NOT_READY at once.
    if (!this.ready && this.spawnPromise && !requestOptions.signal?.aborted) {
      await this.spawnPromise.catch(() => {/* fall through to the NOT_READY reply */});
    }
    return new Promise((resolve) => {
      if (requestOptions.signal?.aborted) {
        resolve({
          success: false,
          error: { code: "ABORTED", message: "Request aborted" },
        });
        return;
      }

      if (!this.process || !this.ready) {
        resolve({
          success: false,
          error: { code: "WORKER_NOT_READY", message: "Worker process not ready" },
        });
        return;
      }

      const id = `req-${++this.requestCounter}`;
      const longRunningRequest = options.type === "execute" || options.type === "resume" || options.type === "continue-session" || options.type === "finish-cascade";
      if (longRunningRequest) this.activeRuns.add(id);
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

      const abortHandler = () => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        if (pending.timeoutId) clearTimeout(pending.timeoutId);
        this.pendingRequests.delete(id);
        pending.resolve({
          success: false,
          error: { code: "ABORTED", message: "Request aborted" },
        });
      };
      requestOptions.signal?.addEventListener("abort", abortHandler, { once: true });

      this.pendingRequests.set(id, {
        resolve: (value) => {
          this.activeRuns.delete(id);
          requestOptions.signal?.removeEventListener("abort", abortHandler);
          resolve(value);
          // After the caller has its answer: every worker reply carries its RSS,
          // so any settled request is a chance to retire a worker that banked a
          // run's peak heap and then went idle. Checking only when a *run*
          // settled missed that worker for good -- whatever failed the guard at
          // that one instant (a dashboard poll still in flight) never came round
          // again, because the next run might be days away. The periodic
          // approval sweep now doubles as the idle heartbeat.
          const rssBytes = (value as { workerRssBytes?: number }).workerRssBytes;
          void this.recycleIfBloated(rssBytes, this.envOverrides.AGENTUSE_PROJECT_ID ?? "worker");
        },
        timeoutId,
      });

      const request = {
        id,
        ...options,
      };

      this.process.stdin!.write(JSON.stringify(request) + "\n");
    });
  }

  /** Agent runs executing in this worker right now. */
  activeRunCount(): number {
    return this.activeRuns.size;
  }

  /** Every request whose worker response has not settled yet, runs included. */
  activeRequestCount(): number {
    return this.pendingRequests.size;
  }

  /**
   * Cut the worker loose instead of killing it: it finishes the runs it already
   * has, writes them to storage exactly as it would have, and exits on its own.
   *
   * This is what makes `pm2 restart` (or systemd, or Ctrl-C) survivable. Every
   * result reaches the dashboard through storage rather than this pipe, so the
   * only thing lost by walking away mid-run is the reply we would have thrown
   * away anyway. The released process keeps its pid, and sessions record their
   * owner's pid, so the next daemon's reconciliation sweep reads those runs as
   * alive and leaves them alone (see reconcileOrphanedSessions).
   *
   * Returns false if the worker cannot be released and must be killed instead.
   */
  release(): boolean {
    const child = this.process;
    if (!child || !this.ready || this.released) return false;
    // No respawn: this worker is no longer ours, and the process is exiting.
    this.shuttingDown = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
    try {
      child.stdin!.write(JSON.stringify({ id: `req-${++this.requestCounter}`, type: "release" }) + "\n");
    } catch {
      return false;
    }
    this.released = true;
    // Deliberately NOT ending stdin: EOF is one of the tethers the worker reads
    // as "serve died", and it is about to stop honouring it, but closing the
    // pipe before the release line is consumed would race that.
    child.unref?.();
    if (this.readline) {
      this.readline.close();
      this.readline = null;
    }
    this.ready = false;
    return true;
  }

  /**
   * Retire a bloated idle worker and bring up a fresh one in its place.
   *
   * Built on release rather than a kill so it stays safe if a run slips in
   * between the idle check and here: the old process finishes whatever it holds
   * and exits on its own, while the replacement takes new work immediately.
   *
   * Returns false when the worker is not a candidate (busy, too young, already
   * recycling, or recycling disabled).
   */
  async recycleIfBloated(rssBytes: number | undefined, projectId: string): Promise<boolean> {
    if (this.recycling || this.released) return false;
    if (!shouldRecycleWorker({
      rssBytes,
      activeRuns: this.activeRuns.size,
      activeRequests: this.pendingRequests.size,
      ageMs: Date.now() - this.spawnedAt,
    })) return false;
    const rssMb = (rssBytes ?? 0) / (1024 * 1024);

    this.recycling = true;
    try {
      if (!this.release()) return false;
      // release() marked us shutting-down; spawn() clears it and replaces the
      // child, and the old one's exit handler no-ops once this.process moves on.
      this.released = false;
      await this.spawn();
      logger.info(`Recycled ${projectId} worker holding ${rssMb.toFixed(0)}MB (threshold ${WORKER_RECYCLE_MB}MB); a fresh one is serving now.`);
      return true;
    } catch (error) {
      logger.warn(`Worker recycle for ${projectId} failed: ${(error as Error).message}`);
      return false;
    } finally {
      this.recycling = false;
    }
  }

  /**
   * Shutdown the worker process.
   */
  shutdown() {
    this.shuttingDown = true;
    if (this.respawnTimer) {
      clearTimeout(this.respawnTimer);
      this.respawnTimer = null;
    }
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

class RequestBodyTooLargeError extends Error {
  constructor(limitBytes: number) {
    super(`Request body too large; limit is ${limitBytes} bytes`);
    this.name = "RequestBodyTooLargeError";
  }
}

const MAX_JSON_BODY_BYTES = 1_000_000;
const LOGGED_APPROVAL_REQUEST_TTL_MS = 24 * 60 * 60 * 1000;
// How long shutdown waits for in-flight approval resumes / session continuations
// to settle before killing workers, so a graceful restart mid-resume finishes (or
// rolls back) cleanly instead of orphaning the session as a stuck 'running'.
const SHUTDOWN_DRAIN_MS = 8_000;

// Retire a worker once an idle one is holding this much memory. A fresh worker
// is ~130MB; one that has run an agent settles at 350-450MB and stays there for
// the daemon's lifetime, so the cost is paid per project that ever ran anything
// and never given back. Recycling an *idle* worker is close to free -- release
// lets it exit on its own and the respawn is warm long before the next run
// arrives -- so the threshold sits just above where a single run's high-water
// mark lands. Set AGENTUSE_WORKER_RECYCLE_MB=0 to disable.
const WORKER_RECYCLE_MB = (() => {
  const raw = Number(process.env.AGENTUSE_WORKER_RECYCLE_MB);
  if (Number.isFinite(raw) && raw >= 0) return raw;
  return 300;
})();
// Floor on how often a worker may be recycled, so a project whose every run
// crosses the threshold respawns on a timer rather than on each request.
const WORKER_RECYCLE_MIN_AGE_MS = 2 * 60 * 1000;

/**
 * Whether an idle worker has banked enough memory to be worth replacing.
 * Pure so the guards are testable without standing up a daemon.
 */
function shouldRecycleWorker(state: {
  rssBytes: number | undefined;
  activeRuns: number;
  activeRequests?: number;
  ageMs: number;
  thresholdMb?: number;
  minAgeMs?: number;
}): boolean {
  const thresholdMb = state.thresholdMb ?? WORKER_RECYCLE_MB;
  if (thresholdMb <= 0) return false;                       // disabled
  if (state.rssBytes === undefined) return false;           // worker did not report
  if (state.activeRuns > 0) return false;                   // busy; try again next settle
  if ((state.activeRequests ?? 0) > 0) return false;         // another RPC still needs this worker
  if (state.ageMs < (state.minAgeMs ?? WORKER_RECYCLE_MIN_AGE_MS)) return false;  // too young
  return state.rssBytes / (1024 * 1024) >= thresholdMb;
}

function shouldLogApprovalRequest(logged: Map<string, number>, key: string, now = Date.now()): boolean {
  for (const [existingKey, loggedAt] of logged) {
    if (now - loggedAt > LOGGED_APPROVAL_REQUEST_TTL_MS) {
      logged.delete(existingKey);
    }
  }
  if (logged.has(key)) return false;
  logged.set(key, now);
  return true;
}

function readRequestBody(req: IncomingMessage, limitBytes = MAX_JSON_BODY_BYTES): Promise<string> {
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

function parseRequestBody(req: IncomingMessage): Promise<RunRequest> {
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

function parseJSONBody(req: IncomingMessage): Promise<Record<string, unknown>> {
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

// Compact transcript of what the agent did in a run — its text output, tool
// calls (name + truncated input/output), and any reviewed draft — pulled from
// the session log the daemon already holds in-process. Used to ground a manual
// instruction in the run the reviewer was looking at.
function buildRunTranscript(logs: ApprovalLogEntry[] | undefined, maxChars = 6000): string {
  if (!logs || logs.length === 0) return '';
  const clip = (s: string | undefined, n: number): string => {
    if (!s) return '';
    const t = s.trim();
    return t.length > n ? t.slice(0, n) + '…' : t;
  };
  const lines: string[] = [];
  for (const e of logs) {
    if (e.type === 'text' && e.message?.trim()) {
      lines.push(`Agent output:\n${e.message.trim()}`);
    } else if (e.type === 'tool') {
      const io = [
        e.details?.input ? `input ${clip(e.details.input, 300)}` : '',
        e.details?.output ? `output ${clip(e.details.output, 500)}` : '',
      ].filter(Boolean).join(' → ');
      lines.push(`Tool ${e.tool ?? e.title}${io ? `: ${io}` : ''}`);
    } else if (e.details?.draft?.trim()) {
      lines.push(`Reviewed work:\n${clip(e.details.draft, 1500)}`);
    }
  }
  const out = lines.join('\n\n');
  return out.length > maxChars ? out.slice(0, maxChars) + '\n…(truncated)' : out;
}

function sendJSON(res: ServerResponse, status: number, data: unknown) {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function sendError(res: ServerResponse, status: number, code: string, message: string) {
  sendJSON(res, status, { success: false, error: { code, message } });
}

function sendRequestParseError(res: ServerResponse, err: unknown): boolean {
  if (err instanceof RequestBodyTooLargeError) {
    sendError(res, 413, "REQUEST_TOO_LARGE", err.message);
    return true;
  }
  return false;
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

// The worker's list-response cache (src/index.ts) keys on the resolved
// createdAfter cutoff. Deriving that cutoff from a raw Date.now() yields a
// distinct value on every request, so the 5-minute cache and its in-flight
// promise coalescing never hit: every approvals/sessions poll and every SSE tick
// re-runs a full O(sessions-in-window) scan, and on a large project those
// uncoalesced concurrent scans saturate the single-threaded worker and trip the
// 30s request timeout. Quantizing the clock to a coarse bucket makes requests
// within the same bucket share one cutoff, so they coalesce onto a single scan
// and the cache actually holds. 60s granularity is immaterial to 7d/30d windows.
const LIST_WINDOW_BUCKET_MS = 60_000;
function listWindowNow(): number {
  return Math.floor(Date.now() / LIST_WINDOW_BUCKET_MS) * LIST_WINDOW_BUCKET_MS;
}

function approvalListCreatedAfter(requestUrl: URL, now = listWindowNow()): number | undefined {
  return listCreatedAfter(requestUrl, APPROVAL_LIST_DEFAULT_DAYS, now);
}

function sessionListUpdatedAfter(requestUrl: URL, now = listWindowNow()): number | undefined {
  const filter = sessionWindowFilterValue(requestUrl);
  if (filter === 'all') return undefined;
  const amount = Number(filter.slice(0, -1));
  const unit = filter[filter.length - 1];
  const multiplier = unit === 'h' ? 60 * 60 * 1000 : 24 * 60 * 60 * 1000;
  return now - amount * multiplier;
}

function listCreatedAfter(requestUrl: URL, defaultDays: number, now = listWindowNow()): number | undefined {
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
  return value === 'running' || value === 'suspended' || value === 'completed' || value === 'error' || value === 'incomplete'
    ? value
    : undefined;
}

function parseSessionTriageFilter(value: string | undefined): SessionTriageFilter | undefined {
  return value === 'undismissed' || value === 'dismissed' ? value : undefined;
}

/**
 * `incomplete` is a user-facing outcome label, persisted as an error with the
 * INCOMPLETE code. Keep the API filter aligned with the label shown in the Web
 * UI instead of treating it as a separate on-disk session status.
 */
function sessionMatchesStatusFilter(
  session: Pick<SessionSummary, 'status' | 'errorCode'>,
  filter: SessionStatusFilter | undefined
): boolean {
  if (!filter) return true;
  if (filter === 'incomplete') return session.status === 'error' && session.errorCode === 'INCOMPLETE';
  return session.status === filter;
}

/**
 * Triage state, independent of status: `undismissed` = not yet reviewed-and-
 * discarded (the default operator view); `dismissed` = waved off. Compose with
 * a status filter to get e.g. undismissed errors (the home "attention" set).
 */
function sessionMatchesTriageFilter(
  session: Pick<SessionSummary, 'dismissedAt'>,
  filter: SessionTriageFilter | undefined
): boolean {
  if (!filter) return true;
  return filter === 'dismissed' ? session.dismissedAt !== undefined : session.dismissedAt === undefined;
}

type SessionMockFilter = 'exclude' | 'include' | 'only';

function parseSessionMockFilter(value: string | undefined): SessionMockFilter {
  return value === 'include' || value === 'only' ? value : 'exclude';
}

/** Every filter captured by the first SSE subscriber must partition the hub. */
function sessionListStreamKey(requestUrl: URL): string {
  return [
    'sessions',
    requestUrl.searchParams.get('window') ?? '',
    requestUrl.searchParams.get('days') ?? '',
    requestUrl.searchParams.get('hours') ?? '',
    requestUrl.searchParams.get('status') ?? '',
    requestUrl.searchParams.get('triage') ?? '',
    requestUrl.searchParams.get('trigger') ?? '',
    requestUrl.searchParams.get('agent') ?? '',
    requestUrl.searchParams.get('approval') ?? '',
    requestUrl.searchParams.get('mock') ?? '',
    requestUrl.searchParams.get('detail') ?? '',
    requestUrl.searchParams.get('limit') ?? '',
    requestUrl.searchParams.get('cursor') ?? '',
  ].join(':');
}

/**
 * Mock/test runs are excluded from every list-backed surface (home aggregates,
 * agent sparklines, the sessions view) unless explicitly requested, so ops
 * views reflect only real runs. Session DETAIL routes are unaffected: a mock
 * session's page stays reachable by id for test-loop inspection.
 */
function sessionMatchesMockFilter(
  session: Pick<SessionSummary, 'mock'>,
  filter: SessionMockFilter
): boolean {
  if (filter === 'include') return true;
  return filter === 'only' ? session.mock === true : session.mock !== true;
}

function parseApprovalSessionFilter(value: string | undefined): ApprovalSessionFilter | undefined {
  return value === 'pending' || value === 'completed' || value === 'errored'
    ? value
    : undefined;
}

const LIST_PAGE_DEFAULT_LIMIT = 50;
const LIST_PAGE_MAX_LIMIT = 100;
const SESSION_LOG_DEFAULT_LIMIT = 400;
const SESSION_LOG_MAX_LIMIT = 5_000;

function sessionLogLimit(requestUrl: URL): number {
  const parsed = Number(requestUrl.searchParams.get('logsLimit'));
  return Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), SESSION_LOG_MAX_LIMIT)
    : SESSION_LOG_DEFAULT_LIMIT;
}

type CursorPage<T> = { items: T[]; nextCursor?: string; limit?: number };

/**
 * Cursor pagination is deliberately opt-in: integrations which omit `limit`
 * keep receiving the historical complete arrays. Cursors carry the complete
 * sort key plus a filter fingerprint, preventing a cursor for one filtered
 * view from silently skipping rows in another.
 */
function cursorPage<T>(
  requestUrl: URL,
  fingerprint: string,
  rows: T[],
  key: (row: T) => string
): CursorPage<T> {
  const rawLimit = requestUrl.searchParams.get('limit');
  if (rawLimit === null) return { items: rows };
  const parsed = Number(rawLimit);
  const limit = Number.isFinite(parsed) && parsed > 0
    ? Math.min(Math.floor(parsed), LIST_PAGE_MAX_LIMIT)
    : LIST_PAGE_DEFAULT_LIMIT;
  const rawCursor = requestUrl.searchParams.get('cursor');
  let start = 0;
  if (rawCursor) {
    try {
      const decoded = JSON.parse(Buffer.from(rawCursor, 'base64url').toString('utf8')) as { f?: string; k?: string };
      if (decoded.f !== fingerprint || typeof decoded.k !== 'string') throw new Error('mismatched cursor');
      const index = rows.findIndex((row) => key(row) === decoded.k);
      if (index < 0) throw new Error('cursor row no longer exists');
      start = index + 1;
    } catch {
      // A stale cursor is safe to restart from the current first page. This is
      // friendlier than failing a dashboard reload after retention cleanup.
      start = 0;
    }
  }
  const items = rows.slice(start, start + limit);
  const last = items.at(-1);
  const nextCursor = last && start + items.length < rows.length
    ? Buffer.from(JSON.stringify({ f: fingerprint, k: key(last) })).toString('base64url')
    : undefined;
  return { items, ...(nextCursor && { nextCursor }), limit };
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
  '.avif': 'image/avif',
  '.svg': 'image/svg+xml'
};

/** Audio/video artifacts: streamed with Range support (native <video>/<audio>
 *  scrubbing) instead of buffered whole, and exempt from the 10MB preview cap. */
const ARTIFACT_AV_MIME: Record<string, string> = {
  '.mp4': 'video/mp4',
  '.m4v': 'video/mp4',
  '.webm': 'video/webm',
  '.mov': 'video/quicktime',
  '.mp3': 'audio/mpeg',
  '.m4a': 'audio/mp4',
  '.wav': 'audio/wav',
  '.ogg': 'audio/ogg'
};
const MAX_AV_ARTIFACT_BYTES = 512 * 1024 * 1024;

/** Stream an audio/video artifact, honoring a single-range Range header. */
function serveAvArtifact(res: ServerResponse, resolved: string, mime: string, size: number, rangeHeader?: string): void {
  const base: Record<string, string> = {
    'Content-Type': mime,
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    'X-Frame-Options': 'SAMEORIGIN',
    'Accept-Ranges': 'bytes',
  };
  const range = rangeHeader ? /^bytes=(\d*)-(\d*)$/.exec(rangeHeader.trim()) : null;
  if (range && (range[1] !== '' || range[2] !== '')) {
    const start = range[1] === '' ? Math.max(0, size - Number(range[2])) : Number(range[1]);
    const end = range[1] !== '' && range[2] !== '' ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (!Number.isFinite(start) || !Number.isFinite(end) || start > end || start >= size) {
      res.writeHead(416, { ...base, 'Content-Range': `bytes */${size}` });
      res.end();
      return;
    }
    res.writeHead(206, {
      ...base,
      'Content-Range': `bytes ${start}-${end}/${size}`,
      'Content-Length': String(end - start + 1),
    });
    createReadStream(resolved, { start, end }).pipe(res);
    return;
  }
  res.writeHead(200, { ...base, 'Content-Length': String(size) });
  createReadStream(resolved).pipe(res);
}

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
.content-code .json-key { color: var(--cyan); }
.content-code .json-string { color: var(--green); }
.content-code .json-number { color: var(--amber); }
.content-code .json-literal { color: var(--amber); }
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

async function serveResolvedArtifactFile(res: ServerResponse, resolved: string, theme?: string, rangeHeader?: string): Promise<void> {
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
  const avMime = ARTIFACT_AV_MIME[extname(resolved).toLowerCase()];
  if (avMime) {
    if (fileStat.size > MAX_AV_ARTIFACT_BYTES) {
      sendHTML(res, 413, '<!doctype html><title>Artifact</title><p>Media artifact is too large to stream (over 512 MB).</p>');
      return;
    }
    serveAvArtifact(res, resolved, avMime, fileStat.size, rangeHeader);
    return;
  }
  const MAX_BYTES = 10 * 1024 * 1024;
  if (fileStat.size > MAX_BYTES) {
    sendHTML(res, 413, '<!doctype html><title>Artifact</title><p>Artifact is too large to preview (over 10 MB).</p>');
    return;
  }

  const ext = extname(resolved).toLowerCase();
  const title = basename(resolved);
  const content = await readFile(resolved);
  const rawMime = ARTIFACT_RAW_MIME[ext];
  if (rawMime) {
    const headers: Record<string, string> = {
      'Content-Type': rawMime,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    };
    // The in-page preview iframe sandboxes the artifact (allow-scripts, no
    // same-origin), but the "open in tab" link loads this same URL as a
    // top-level document where the iframe sandbox no longer applies. Deliver the
    // `sandbox` directive as an HTTP-header CSP (it is ignored via <meta>) so a
    // directly-opened HTML artifact still gets an opaque origin and cannot reach
    // the serve app's same-origin cookies/storage.
    //
    // Cross-origin framing of the token-bearing URL is blocked with CSP
    // frame-ancestors, NOT X-Frame-Options: the `sandbox` directive gives the
    // response an opaque origin, so XFO SAMEORIGIN can never match and would
    // block the session page's own preview iframe too. frame-ancestors compares
    // the ancestor's URL origin against this resource's URL origin instead.
    if (rawMime.startsWith('text/html')) {
      headers['Content-Security-Policy'] = `${ARTIFACT_HTML_CSP}; frame-ancestors 'self'; sandbox allow-scripts`;
    } else if (rawMime === 'image/svg+xml') {
      headers['Content-Security-Policy'] = `${ARTIFACT_SVG_CSP}; frame-ancestors 'self'`;
    } else {
      headers['X-Frame-Options'] = 'SAMEORIGIN';
    }
    res.writeHead(200, headers);
    res.end(content);
    return;
  }
  // Anything that isn't a raw-streamed type previews as text when the bytes
  // actually are text (sniffed, not extension-guessed), so new text formats
  // work without being enumerated here. The sniff only ever routes into the
  // escaped/rendered HTML documents, never the script-capable raw branches
  // above, so it cannot widen the CSP-sandboxed surface.
  const text = decodeArtifactText(content);
  if (text !== null) {
    const isMarkdown = ext === '.md' || ext === '.markdown' || ext === '.agentuse';
    const body = isMarkdown
      ? renderMarkdownArtifact(text)
      : `<pre class="artifact-raw">${escapeHtml(text)}</pre>`;
    sendHTML(res, 200, renderArtifactDocument(title, body, theme));
    return;
  }
  // Binary content: hand it to the browser as a download rather than guess.
  res.writeHead(200, {
    'Content-Type': 'application/octet-stream',
    'Cache-Control': 'no-store',
    'Content-Disposition': `attachment; filename="${title.replace(/["\\]/g, '')}"`
  });
  res.end(content);
}

/**
 * Decode artifact bytes as text for preview, or return null for binary
 * content. Uses the git-style heuristic (a NUL byte in the leading window
 * means binary) plus a strict UTF-8 decode so mojibake never renders.
 */
function decodeArtifactText(content: Buffer): string | null {
  if (content.subarray(0, 8192).includes(0)) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

/**
 * Resolve, authorize, and serve a local file artifact referenced by an
 * `await_human` gate. The path is interpreted relative to the project root and
 * must resolve inside it (no traversal), and a small denylist keeps secrets and
 * internal session state out of reach even if a prompt coaxed the agent into
 * pointing the gate at them. html/images/pdf are streamed raw for the iframe to
 * display; anything whose bytes sniff as UTF-8 text renders as a themed doc
 * (markdown-family extensions get the markdown renderer); binaries download.
 */
async function serveSessionArtifact(
  res: ServerResponse,
  projectRoot: string,
  rawPath: string,
  theme?: string,
  opts?: { sessionId?: string | undefined; snapHash?: string | undefined; rangeHeader?: string | undefined }
): Promise<void> {
  // A gate-time snapshot takes priority over the live workspace path: the
  // reviewer must see the exact bytes the approval covers. Snapshot files are
  // hash-named inside the session's own storage, so no traversal or denylist
  // concerns apply. A declared snapshot that is missing fails closed; only
  // legacy gates with no snapshot hash may use the live-path compatibility path.
  if (opts?.snapHash && opts.sessionId) {
    const snapshotFile = await findGateSnapshotFile(projectRoot, opts.sessionId, opts.snapHash);
    if (snapshotFile) {
      await serveResolvedArtifactFile(res, snapshotFile, theme, opts.rangeHeader);
      return;
    }
    sendHTML(
      res,
      410,
      '<!doctype html><title>Artifact unavailable</title><p>The immutable approval snapshot is unavailable. The live workspace file was not substituted.</p>'
    );
    return;
  }
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
  // Apply the secret/internal-state denylist to the canonical target too. A
  // lexical in-project alias must not make .env, .git, or .agentuse state
  // reviewable through a symlink.
  const policyRoot = realResolved ? realRoot : projectRoot;
  const policyPath = realResolved ?? resolved;
  const rel = relative(policyRoot, policyPath);
  const segments = rel.split(/[\\/]+/);
  const blockedRoots = new Set(['.git', 'node_modules']);
  const isBlocked = segments.some((seg) => seg.startsWith('.env'))
    || blockedRoots.has(segments[0])
    || (segments[0] === '.agentuse' && (segments[1] === 'store' || segments[1] === 'sessions' || segments[1] === 'env'));
  if (isBlocked) {
    sendHTML(res, 403, '<!doctype html><title>Artifact</title><p>This artifact path is not viewable.</p>');
    return;
  }
  await serveResolvedArtifactFile(res, resolved, theme, opts?.rangeHeader);
}

async function serveSessionToolOutputArtifact(
  res: ServerResponse,
  projectRoot: string,
  sessionId: string,
  rawPath: string,
  theme?: string
): Promise<void> {
  const decoded = (() => { try { return decodeURIComponent(rawPath); } catch { return rawPath; } })();
  const storageRoot = await getSessionStorageDir(projectRoot);
  const resolved = resolve(storageRoot, decoded);
  const realRoot = (() => { try { return realpathSync(storageRoot); } catch { return storageRoot; } })();
  const realResolved = (() => { try { return realpathSync(resolved); } catch { return null; } })();

  if (!isPathInside(storageRoot, resolved) || (realResolved && !isPathInside(realRoot, realResolved))) {
    sendHTML(res, 403, '<!doctype html><title>Artifact</title><p>This tool output path is outside session storage.</p>');
    return;
  }

  const rel = relative(storageRoot, resolved);
  const segments = rel.split(/[\\/]+/);
  const sessionSegment = segments.find((segment) => segment.startsWith(`${sessionId}-`));
  const artifactIndex = segments.lastIndexOf('artifact');
  const fileName = segments[segments.length - 1] ?? '';
  if (!sessionSegment || artifactIndex < 0 || !fileName.startsWith('tool-output-')) {
    sendHTML(res, 403, '<!doctype html><title>Artifact</title><p>This tool output path is not viewable for this session.</p>');
    return;
  }

  await serveResolvedArtifactFile(res, resolved, theme);
}

function compareStoreBrowserSummaries(a: StoreBrowserSummary, b: StoreBrowserSummary): number {
  return (b.updatedAt ?? 0) - (a.updatedAt ?? 0)
    || a.name.localeCompare(b.name)
    || a.projectId.localeCompare(b.projectId);
}

interface AgentSummary {
  projectId: string;
  /** Path relative to the project root (tree layout + `?agent=` filter). */
  path: string;
  /** Scope-relative path, the exact `agent` value POST /run accepts. */
  runPath: string;
  name: string;
  description?: string;
  model: string;
  /** Raw schedule expression when the agent declares one. */
  schedule?: string;
  /** Human-readable form of `schedule` (e.g. "At 09:00 AM, only on Monday"). */
  scheduleHuman?: string;
  /** Free-form frontmatter `metadata:`, passed through untouched for the UI. */
  metadata?: Record<string, unknown>;
  /** Declared subagent targets, normalized project-relative (see serve/types). */
  subagents?: string[];
  /** Advisory `dependsOn` targets, normalized project-relative (never runtime). */
  dependsOn?: string[];
  /** Shared store name when `store:` is a string; isolated (`true`) omitted. */
  store?: string;
  /** Frontmatter `type:` when declared (currently only 'manager'). */
  type?: string;
  /** Server-computed relationship lint findings (dangling/self/cycle). */
  warnings?: string[];
}

interface CollectAgentsResult {
  agents: AgentSummary[];
  errors: Array<{ projectId: string; path: string; message: string }>;
}

type CachedAgentSummary =
  | { mtimeMs: number; size: number; summary: AgentSummary }
  | { mtimeMs: number; size: number; error: string };
const agentSummaryCache = new Map<string, CachedAgentSummary>();

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
        const absPath = resolveScopedAgentPath(project, agentFile);
        const fileStat = await stat(absPath);
        const cached = agentSummaryCache.get(absPath);
        if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
          if ('error' in cached) errors.push({ projectId: project.id, path: agentFile, message: cached.error });
          else agents.push({ ...cached.summary, projectId: project.id, path: toProjectRelativeAgentPath(project, agentFile), runPath: agentFile });
          continue;
        }
        const parsed = await parseAgent(absPath);
        // Relationship targets normalize to the same project-relative notation
        // as `path`, so the client can match edges by string equality. Targets
        // escaping the project root keep their `../` form and render as
        // external ghosts rather than resolving to another row.
        const agentDir = dirname(absPath);
        const toRel = (p: string) => relative(project.root, resolve(agentDir, p));
        const subagents = parsed.config.subagents?.map((s) => toRel(s.path));
        const dependsOn = parsed.config.dependsOn?.map(toRel);
        const summary: AgentSummary = {
          projectId: project.id,
          path: toProjectRelativeAgentPath(project, agentFile),
          runPath: agentFile,
          name: parsed.name,
          ...(parsed.config.description && { description: parsed.config.description }),
          model: parsed.config.model,
          ...(parsed.config.schedule && { schedule: parsed.config.schedule, scheduleHuman: formatScheduleHuman(parsed.config.schedule) }),
          ...(parsed.config.metadata && { metadata: parsed.config.metadata }),
          ...(subagents?.length && { subagents }),
          ...(dependsOn?.length && { dependsOn }),
          ...(typeof parsed.config.store === 'string' && { store: parsed.config.store }),
          ...(parsed.config.type && { type: parsed.config.type }),
        };
        agentSummaryCache.set(absPath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, summary });
        agents.push(summary);
      } catch (err) {
        const message = (err as Error).message;
        errors.push({ projectId: project.id, path: agentFile, message });
      }
    }
  }
  agents.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.path.localeCompare(b.path));
  annotateRelationshipWarnings(agents);
  return { agents, errors };
}

/**
 * Cross-row lint for declared `dependsOn` edges: dangling targets, self
 * references, and cycles. Computed per request over the assembled list (cheap,
 * in-memory) rather than cached per file, because every finding depends on
 * OTHER rows existing — a cached warning would go stale when a neighbor is
 * added or deleted. Mutates rows in place; `warnings` is absent when clean.
 */
function annotateRelationshipWarnings(agents: AgentSummary[]): void {
  const byProject = new Map<string, Map<string, AgentSummary>>();
  for (const agent of agents) {
    let rows = byProject.get(agent.projectId);
    if (!rows) byProject.set(agent.projectId, rows = new Map());
    rows.set(agent.path, agent);
    delete agent.warnings; // cached rows may carry findings from a previous pass
  }
  for (const agent of agents) {
    if (!agent.dependsOn) continue;
    const rows = byProject.get(agent.projectId)!;
    const warnings: string[] = [];
    for (const target of agent.dependsOn) {
      if (target === agent.path) warnings.push('dependsOn includes itself');
      else if (target.startsWith('..')) continue; // outside the project: rendered as external, not lintable
      else if (!rows.has(target)) warnings.push(`dependsOn target not found: ${target}`);
    }
    if (warnings.length) agent.warnings = warnings;
  }
  // Cycle pass: DFS over dependsOn edges within each project.
  for (const rows of byProject.values()) {
    const state = new Map<string, 'visiting' | 'done'>();
    const flagCycle = (path: string, stack: string[]): void => {
      const s = state.get(path);
      if (s === 'done') return;
      if (s === 'visiting') {
        for (const member of stack.slice(stack.indexOf(path))) {
          const row = rows.get(member)!;
          const note = 'dependsOn forms a cycle';
          if (!row.warnings?.includes(note)) (row.warnings ??= []).push(note);
        }
        return;
      }
      state.set(path, 'visiting');
      stack.push(path);
      for (const target of rows.get(path)?.dependsOn ?? []) {
        if (rows.has(target)) flagCycle(target, stack);
      }
      stack.pop();
      state.set(path, 'done');
    };
    for (const path of rows.keys()) flagCycle(path, []);
  }
}

/**
 * ABOUT.md files describing the directories the agents page renders (#156):
 * every project root (as path '.') plus each project-relative folder that
 * groups agents, ancestors included so nested groups can carry names too.
 * Only directories that actually have the file get an entry; the rest keep
 * rendering as ids and paths. Display identity only, never behavior.
 */
async function collectDirAbouts(
  projects: Project[],
  agents: AgentSummary[]
): Promise<Array<{ projectId: string; path: string; about: AboutInfo }>> {
  // NOTE: keys use dirname() output, matched client-side against
  // agent.path.lastIndexOf('/'): both derive from the same relative() paths,
  // which are POSIX-separated everywhere serve runs today (mirrors the
  // pre-existing '/' assumption in agents.tsx agentDirectory()).
  const dirsByProject = new Map<string, Set<string>>(projects.map((p) => [p.id, new Set(['.'])]));
  for (const agent of agents) {
    let dir = dirname(agent.path);
    const dirs = dirsByProject.get(agent.projectId);
    if (!dirs) continue;
    while (dir && dir !== '.' && dir !== '/' && !dir.startsWith('..')) {
      dirs.add(dir);
      dir = dirname(dir);
    }
  }
  const out: Array<{ projectId: string; path: string; about: AboutInfo }> = [];
  await Promise.all(projects.map(async (project) => {
    const dirs = dirsByProject.get(project.id) ?? new Set<string>();
    await Promise.all([...dirs].map(async (dir) => {
      const about = await readAbout(resolve(project.root, dir));
      if (about) out.push({ projectId: project.id, path: dir, about });
    }));
  }));
  out.sort((a, b) => a.projectId.localeCompare(b.projectId) || a.path.localeCompare(b.path));
  return out;
}

/**
 * Curated, display-ready view of an agent's capabilities for the detail page.
 * A summary of the parsed config (NOT the raw config) so the UI can render
 * "what can this thing touch / how does it run" without re-deriving it.
 */
interface AgentDetailMeta {
  filesystem?: string[];          // permissions in use: read | write | edit
  bashCommands?: number;          // count of auto-run bash command patterns (commands)
  gated?: string[];               // bash patterns that run only after human approval
  awaitHuman?: boolean;           // tools.await_human gate
  skills: { auto: boolean; trusted: boolean; explicit: string[] };
  mcpServers: string[];
  subagents: string[];
  approval?: boolean;             // declarative suspension gate present
  channels: string[];             // external surfaces, e.g. slack
  timeout?: number;
  maxSteps?: number;
  version?: string;
}

interface AgentDetail {
  projectId: string;
  path: string;
  runPath: string;
  name: string;
  description?: string;
  model: string;
  schedule?: string;
  scheduleHuman?: string;
  metadata?: Record<string, unknown>;
  source: string;
  meta: AgentDetailMeta;
}

/** Parse one agent and build its detail payload (capabilities + raw source). */
async function collectAgentDetail(project: Project, runPath: string): Promise<AgentDetail> {
  const absPath = resolveScopedAgentPath(project, runPath);
  const [parsed, source] = await Promise.all([parseAgent(absPath), readFile(absPath, 'utf8')]);
  const config = parsed.config;

  const fsPerms = new Set<string>();
  for (const entry of config.tools?.filesystem ?? []) {
    for (const perm of entry.permissions) fsPerms.add(perm);
  }
  const skills = config.skills ?? { auto: true, trusted: false, explicit: {} };

  const meta: AgentDetailMeta = {
    ...(fsPerms.size > 0 && { filesystem: ['read', 'write', 'edit'].filter((p) => fsPerms.has(p)) }),
    ...(config.tools?.bash && { bashCommands: config.tools.bash.commands.length }),
    ...(config.tools?.bash?.gated?.length && { gated: config.tools.bash.gated }),
    ...(config.tools?.await_human && { awaitHuman: true }),
    skills: { auto: skills.auto, trusted: skills.trusted, explicit: Object.keys(skills.explicit ?? {}) },
    mcpServers: Object.keys(config.mcpServers ?? {}),
    subagents: (config.subagents ?? []).map((s) => s.name || s.path),
    ...(config.approval && { approval: true }),
    channels: Object.keys(config.channels ?? {}),
    ...(config.timeout !== undefined && { timeout: config.timeout }),
    ...(config.maxSteps !== undefined && { maxSteps: config.maxSteps }),
    ...(config.version && { version: config.version }),
  };

  return {
    projectId: project.id,
    path: toProjectRelativeAgentPath(project, runPath),
    runPath,
    name: parsed.name,
    ...(config.description && { description: config.description }),
    model: config.model,
    ...(config.schedule && {
      schedule: config.schedule,
      scheduleHuman: formatScheduleHuman(config.schedule),
    }),
    ...(config.metadata && { metadata: config.metadata }),
    source,
    meta,
  };
}

/**
 * Strip the raw `.agentuse` body from a detail payload (serve.hideAgentSource):
 * the capabilities summary stays, `source` is replaced by `sourceHidden: true`
 * so the web UI knows to drop the Source tab rather than render an empty one.
 */
function redactAgentDetailSource(detail: AgentDetail): Omit<AgentDetail, 'source'> & { sourceHidden: true } {
  const { source: _source, ...rest } = detail;
  return { ...rest, sourceHidden: true };
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
  if (child.status === 'error' && child.errorCode === 'INCOMPLETE') return 'incomplete';
  return child.status;
}

function enrichChildSessionForLog(
  child: ChildSessionSummary,
  childSessionHref?: (sessionId: string) => string,
  details: Partial<LogSubagentSession> = {}
): LogSubagentSession {
  return {
    ...child,
    ...details,
    displayStatus: details.phase ?? renderChildSessionStatus(child),
    command: `agentuse sessions show ${child.sessionId.substring(0, 12)} --all-search`,
    ...(childSessionHref && { href: childSessionHref(child.sessionId) }),
  };
}

function importantDescendantTree(
  childSessions: ChildSessionSummary[],
  importantDescendants: ImportantDescendantSummary[] = [],
  childSessionHref?: (sessionId: string) => string,
  root?: { sessionId: string; agentName: string },
  importantDescendantEvents: ImportantDescendantEvent[] = []
): LogSubagentSession[] {
  const nodes = new Map<string, LogSubagentSession>();
  const directIds = new Set(childSessions.map((child) => child.sessionId));

  for (const child of childSessions) {
    const terminal = child.status === 'completed' || child.status === 'error';
    nodes.set(child.sessionId, enrichChildSessionForLog(child, childSessionHref, {
      ...(terminal && child.updatedAt >= child.createdAt && { durationMs: child.updatedAt - child.createdAt }),
      ...(root && {
        parentSessionId: root.sessionId,
        depth: 1,
        breadcrumb: [{ sessionId: root.sessionId, agentName: root.agentName }],
      }),
    }));
  }
  for (const descendant of importantDescendants) {
    const existing = nodes.get(descendant.sessionId);
    const child: ChildSessionSummary = existing ?? descendant;
    nodes.set(descendant.sessionId, enrichChildSessionForLog(child, childSessionHref, {
      parentSessionId: descendant.parentSessionId,
      depth: descendant.depth,
      breadcrumb: descendant.breadcrumb,
      ...(descendant.durationMs !== undefined && { durationMs: descendant.durationMs }),
      kinds: descendant.kinds,
      important: descendant.important,
      ...(descendant.phase && { phase: descendant.phase }),
      ...(descendant.label && { label: descendant.label }),
      ...(descendant.gateLabel && { gateLabel: descendant.gateLabel }),
      ...(descendant.attemptLabel && { attemptLabel: descendant.attemptLabel }),
    }));
  }

  for (const descendant of importantDescendants) {
    if (directIds.has(descendant.sessionId)) continue;
    const node = nodes.get(descendant.sessionId);
    const parent = nodes.get(descendant.parentSessionId);
    if (!node || !parent) continue;
    parent.children = [...(parent.children ?? []), node];
  }
  for (const event of importantDescendantEvents) {
    const owner = nodes.get(event.ownerSessionId);
    if (!owner) continue;
    const ownerHref = childSessionHref?.(event.ownerSessionId);
    const projected: LogSubagentEvent = {
      ...event,
      displayStatus: event.type === 'reviewer-feedback'
        ? 'commented'
        : event.verdict === 'pass' ? 'passed' : event.verdict === 'fail' ? 'failed' : 'error',
      ...(ownerHref && { href: `${ownerHref}#log-${encodeURIComponent(event.sourceLogId)}` }),
    };
    owner.events = [...(owner.events ?? []), projected];
  }
  for (const node of nodes.values()) {
    node.children?.sort((a, b) => a.createdAt - b.createdAt || a.sessionId.localeCompare(b.sessionId));
    node.events?.sort((a, b) => a.time - b.time || a.id.localeCompare(b.id));
  }
  return childSessions.map((child) => nodes.get(child.sessionId)!).filter(Boolean);
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
  childSessionHref?: (sessionId: string) => string,
  importantDescendants: ImportantDescendantSummary[] = [],
  root?: { sessionId: string; agentName: string },
  importantDescendantEvents: ImportantDescendantEvent[] = []
): ApprovalLogEntry[] {
  if (childSessions.length === 0) return logs;

  const childTree = importantDescendantTree(
    childSessions,
    importantDescendants,
    childSessionHref,
    root,
    importantDescendantEvents
  );

  const matchedChildIds = new Set<string>();
  const enrichedLogs = logs.map((entry) => {
    if (entry.subagentSession) {
      matchedChildIds.add(entry.subagentSession.sessionId);
      const current = childTree.find((candidate) => candidate.sessionId === entry.subagentSession?.sessionId);
      return current ? { ...entry, subagentSession: current } : entry;
    }
    const child = childTree
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
      subagentSession: child,
    };
  });

  for (const child of childTree) {
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
 * subroutes `/sessions/:id/{decision,continue,status,stop,started,finished,
 * reopen,learnings}`, the artifact
 * listing `/sessions/:id/artifacts-list`, and artifact
 * viewer subpaths `/sessions/:id/{artifacts,tool-artifacts}/*`. These carry their own capability
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
  return /^\/sessions\/[^/?#]+(?:\/(?:decision|continue|status|stop|started|finished|reopen|events|learnings|learnings\/[^/?#]+\/discard|artifacts-list|artifacts\/.+|tool-artifacts\/.+|context|context-stack))?$/.test(routePath);
}

/**
 * GET routes that render a browser page and therefore serve the SPA shell
 * (the client routes by URL and fetches its own data). Mirrors the set of
 * server-rendered pages: home, agents (+single-project view), schedules,
 * stores (+item/detail), sessions, the approvals list, and the client-local
 * settings page. The single-project
 * route `/agents/:project` is one segment; the detail hub `/agents/:project/:agent*`
 * is two or more. `/approvals/:id` is excluded so it keeps
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
    case '/settings':
    /** The tidy-up progress/result page, addressed by ?project=&path=&job=
     *  rather than by path segments so an agent path containing slashes stays
     *  unambiguous against the `/agents/:project/:agent*` hub. */
    case '/learnings/tidy':
      return true;
  }
  if (/^\/stores\/[^/?#]+(?:\/[^/?#]+)?$/.test(routePath)) return true; // /stores/:s and /stores/:s/:item
  if (/^\/agents\/[^/?#]+$/.test(routePath)) return true; // /agents/:project (single-project view)
  if (/^\/agents\/[^/?#]+\/.+$/.test(routePath)) return true; // /agents/:project/:agent* (detail hub)
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

function validateApiKeyHeader(
  authHeader: string | undefined,
  expectedKey: string | undefined
): boolean {
  if (!expectedKey) return true;

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

function validateApiKey(req: IncomingMessage, expectedKey: string | undefined): boolean {
  return validateApiKeyHeader(req.headers.authorization, expectedKey);
}

/** A session capability can review a run, but only an operator may rewrite its agent file. */
function sessionLearningTidyAllowed(
  authorization: string | undefined,
  apiKey: string | undefined,
): boolean {
  return validateApiKeyHeader(authorization, apiKey);
}

function isSessionCapabilityAuthorized(options: {
  authorization?: string | undefined;
  sessionToken?: string | undefined;
  sessionId: string;
  apiKey?: string | undefined;
}): boolean {
  const { authorization, sessionToken, sessionId, apiKey } = options;
  return !apiKey
    || validateApiKeyHeader(authorization, apiKey)
    || validateSessionToken(sessionToken, sessionId, apiKey);
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

function selectSessionProjects<T extends { id: string }>(
  projects: readonly T[],
  projectId?: string
):
  | { success: true; projects: T[] }
  | { success: false; status: 404; code: 'PROJECT_NOT_FOUND'; message: string } {
  const selected = projectId
    ? projects.filter((project) => project.id === projectId)
    : [...projects];
  if (selected.length > 0) return { success: true, projects: selected };
  return {
    success: false,
    status: 404,
    code: 'PROJECT_NOT_FOUND',
    message: projectId
      ? `Project not found: ${projectId}`
      : 'Project not found for session request',
  };
}

/**
 * Whose learnings a session view shows: always THIS session's agent, never the
 * cascade's origin agent.
 *
 * A manager parked on a delegated child ran under its own learnings. They are
 * what the log's "N of M applied" badge counts, and the page is titled with that
 * agent, so they are the rules a reviewer is judging the run against. Reading
 * the leaf's store instead showed nothing at all whenever the leaf had not
 * captured anything yet, which hid the manager's own over-cap warning on the one
 * page where it changes a decision.
 *
 * A `remember` correction left at the gate still belongs to `originAgent`: that
 * note is about the draft on screen, so it goes to whoever wrote it. The two
 * deliberately differ, and the panel names the agent it is showing.
 */
function sessionLearningTargetAgent<T>(approval: { agent: T; originAgent?: T }): T {
  return approval.agent;
}

function resolveScopedAgentPath(project: Project | Omit<Project, 'agentFiles'>, agentPath: string): string {
  return resolve(project.scopeRoot, agentPath);
}

function toProjectRelativeAgentPath(project: Project | Omit<Project, 'agentFiles'>, agentPath: string): string {
  return relative(project.root, resolveScopedAgentPath(project, agentPath));
}

/**
 * The scope-relative path the agent detail hub addresses, for a session's
 * (absolute) agent file. Returns undefined when the file is not one of the
 * project's loaded agents, so the session page only links where a hub exists.
 */
function toAgentRunPath(project: Project, filePath: string | undefined): string | undefined {
  if (!filePath) return undefined;
  const runPath = relative(project.scopeRoot, filePath);
  return project.agentFiles.includes(runPath) ? runPath : undefined;
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

async function bareServeMigrationWarning(cwd: string): Promise<string | undefined> {
  const [agentFile] = await glob("**/*.agentuse", {
    cwd,
    ignore: ["node_modules/**", "tmp/**", ".git/**"],
    nodir: true,
  });
  if (!agentFile) return undefined;

  return (
    `Warning: no project was loaded. v0.19 no longer adopts the current directory ` +
    `for a bare "agentuse serve" (found ${agentFile}). Restart with ` +
    `"agentuse serve -C ." or add this directory to serve.projects.`
  );
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
    .option("--open", "Open the Web UI in the default browser after startup")
    .option("--hide-agent-source", "Hide raw agent source in the dashboard and /api/agents/detail; capability summaries stay visible (or config.serve.hideAgentSource)")
    .action(async (options: { port?: string; host?: string; publicUrl?: string; directory: string[]; default?: string; debug?: boolean; auth: boolean; logFile: boolean; open?: boolean; hideAgentSource?: boolean }) => {
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
      // Apply config.json `env` after .env so .env wins; pass the already-loaded
      // config to avoid a second read (and second malformed-config throw path).
      const appliedConfigEnv = applyGlobalConfigEnv(globalConfig);
      if (appliedConfigEnv.length > 0 && options.debug) {
        logger.debug(`Applied env from global config: ${appliedConfigEnv.join(', ')}`);
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
      // Flag can only turn hiding ON (no --no variant): a deployment that hides
      // source in config should not be re-exposable by a forgotten CLI flag.
      const effectiveHideAgentSource = options.hideAgentSource === true || (serveCfg?.hideAgentSource ?? false);

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

      // Resolve projects: explicit CLI scopes, then saved projects. A bare
      // `serve` deliberately does not turn the launch directory into a project;
      // the Web UI will offer a managed first project instead.
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
        const migrationWarning = await bareServeMigrationWarning(process.cwd());
        if (migrationWarning) console.error(chalk.yellow(migrationWarning));
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

      let multiProject = projectSeeds.length > 1;

      // CLI --default > config.serve.default.
      let effectiveDefault = options.default ?? serveCfg?.default;

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
      await telemetry.init(packageVersion, { batchDelivery: true });
      refreshUpdateCacheInBackground(packageVersion);

      // Spawn one worker per project. Each worker loads its own project's
      // .env / .env.local on each execute request, so per-project env stays
      // isolated from the parent process and from sibling projects.
      const workers = new Map<string, AgentWorker>();
      const activeCascadeRecoveries = new Set<string>();
      // Recover sessions a dead worker left stuck 'running' with no live process.
      // A replacement's first pass intentionally skips released predecessors
      // that are still alive. Keep sweeping so a predecessor that dies later is
      // reconciled without requiring another daemon restart.
      const reconcileWorkerOrphans = async (worker: AgentWorker, projectId: string, projectRoot: string, cutoff: number): Promise<void> => {
        const r = await worker.reconcileOrphans(projectRoot, cutoff);
        if (!r.success || r.reconciled.length === 0) return;
        const finishable = r.reconciled.filter((o) => o.reason === 'finishable');
        const stranded = r.reconciled.filter((o) => o.reason === 'stranded').length;
        const interrupted = r.reconciled.length - finishable.length - stranded;
        if (interrupted > 0) {
          logger.warn(`Recovered ${interrupted} interrupted session(s) in ${projectId} (stuck 'running' after a worker restart)`);
        }
        if (stranded > 0) {
          logger.warn(`Ended ${stranded} stranded session(s) in ${projectId} (parked on a delegated sub-agent that had already ended)`);
        }
        // A restart killed the worker between a delegated child finishing and
        // its manager being resumed. The child's result is durable, so finish
        // the chain instead of orphaning it (issue #199). Keep one local driver;
        // the worker's durable claim arbitrates with other daemon processes.
        for (const orphan of finishable) {
          const recoveryKey = `${projectId}:${orphan.sessionId}`;
          if (activeCascadeRecoveries.has(recoveryKey)) continue;
          activeCascadeRecoveries.add(recoveryKey);
          logger.warn(`Resuming ${orphan.agentName} (${orphan.sessionId}) in ${projectId}: its delegated sub-agent finished, folding the result in`);
          void worker.finishCascade(projectRoot, orphan.sessionId).then((res) => {
            if (!res.success) {
              logger.warn(`Cascade finish for ${orphan.sessionId} failed: ${res.error.message}`);
            } else {
              logger.info(`Cascade finished for ${orphan.agentName} (${orphan.sessionId})`);
            }
          }).catch(() => {/* best-effort recovery */}).finally(() => {
            activeCascadeRecoveries.delete(recoveryKey);
          });
        }
      };
      // When each project's worker last became ready. That instant, not "now", is
      // the orphan cutoff: a worker owns every session touched since it came up,
      // so `Date.now()` would make the guard vacuous and force a full owner probe
      // on sessions the live worker is running right now.
      const workerReadyAt = new Map<string, number>();
      const orphanReconcileLoop = startOrphanReconcileLoop(async () => {
        await Promise.all(projectSeeds.map(async (project) => {
          const worker = workers.get(project.id);
          if (!worker?.isReady()) return;
          const cutoff = workerReadyAt.get(project.id) ?? Date.now();
          await reconcileWorkerOrphans(worker, project.id, project.root, cutoff);
        }));
      }, {
        onError: (error) => logger.debug(`Orphan reconciliation failed: ${(error as Error).message}`),
      });
      const spawnProjectWorker = async (p: Omit<Project, 'agentFiles'>): Promise<AgentWorker> => {
        const w = new AgentWorker({
          AGENTUSE_RESUME_PUBLIC_URL: effectivePublicUrl,
          AGENTUSE_PROJECT_ID: p.id,
        });
        // Assigned before spawn so the initial ready records its timestamp too;
        // the sweep it requests here no-ops because the worker isn't registered
        // yet, and the explicit runNow below drives the real startup pass.
        // Respawns request an immediate pass; overlapping requests collapse into
        // one trailing sweep in the loop coordinator.
        w.onReady = (readyAt) => {
          workerReadyAt.set(p.id, readyAt);
          orphanReconcileLoop.runNow();
        };
        try {
          await w.spawn();
        } catch (err) {
          throw new Error(`Failed to spawn worker for ${p.id}: ${(err as Error).message}`);
        }
        workers.set(p.id, w);
        return w;
      };
      for (const p of projectSeeds) {
        try {
          await spawnProjectWorker(p);
        } catch (err) {
          console.error(chalk.red((err as Error).message));
          for (const live of workers.values()) live.shutdown();
          process.exit(1);
        }
      }
      orphanReconcileLoop.runNow();
      logger.debug(`Spawned ${workers.size} agent worker(s)`);

      // Execution stats tracking
      const serverStartTime = Date.now();
      let totalExecutions = 0;
      let successfulExecutions = 0;
      let failedExecutions = 0;
      let logHandle: LogFileHandle | null = null;

      // Nudges the list SSE hubs to poll fast for a bounded window. Assigned
      // once the hubs exist; a no-op indirection here because the scheduler
      // (and its cron jobs) is armed before the hubs are constructed.
      let wakeListHubs: () => void = () => {};

      /**
       * Make the next dashboard read reflect an out-of-process change. Waking
       * the hubs alone isn't enough: they re-read through the worker's list
       * cache, so a stale entry would just be served faster. Drop the cache
       * first, then wake.
       */
      const refreshProjectLists = async (
        project: { id: string; root: string },
        options: { externalActivity?: boolean } = {}
      ): Promise<void> => {
        // Note the two different keys: workers are keyed by project id, while
        // the worker's own list cache is keyed by project root (what it was
        // asked to scan). Mixing them up silently skips the invalidation.
        const worker = workers.get(project.id);
        if (worker) {
          try {
            await worker.invalidateLists(project.root, options);
          } catch (err) {
            logger.debug(`List cache invalidation failed: ${(err as Error).message}`);
          }
        }
        wakeListHubs();
      };

      // Helper function to execute an agent (used by scheduler)
      // Uses subprocess to work around EBADF issue when spawning from async callbacks
      const executeScheduledAgent = async (
        schedule: Schedule
      ): Promise<{ success: boolean; duration: number; error?: string; sessionId?: string; suspended?: boolean }> => {
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
        wakeListHubs();
        const spawnResult = await projectWorker.execute({
          agentPath: toProjectRelativeAgentPath(project, schedule.agentPath),
          projectRoot: project.root,
          timeout: agent.config.timeout,
          maxSteps: agent.config.maxSteps,
          debug: options.debug,
          trigger: 'scheduled',
        });
        wakeListHubs();

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
            classification: classifyExecution({
              agentSource: 'local',
              trigger: 'scheduled',
              isMock: false,
            }),
            toolCalls: spawnResult.telemetry?.toolCalls ?? emptyToolCallMetrics(),
            ...(spawnResult.telemetry && { steps: spawnResult.telemetry.steps }),
            features: configuredFeatureUsage(agent.config, 'schedule'),
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
            ...(spawnResult.result.finishReason === 'suspended' && { suspended: true }),
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
            classification: classifyExecution({
              agentSource: 'local',
              trigger: 'scheduled',
              isMock: false,
            }),
            toolCalls: spawnResult.telemetry?.toolCalls ?? emptyToolCallMetrics(),
            ...(spawnResult.telemetry && { steps: spawnResult.telemetry.steps }),
            errorType: spawnResult.error.code === 'TIMEOUT'
              ? 'timeout'
              : spawnResult.error.code === 'INCOMPLETE'
                ? 'incomplete'
                : 'unknown',
            features: configuredFeatureUsage(agent.config, 'schedule'),
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

      // Per-project scheduler lock (see utils/scheduler-lock.ts): the daemon
      // registry above only sees daemons sharing this XDG data dir, so a
      // daemon launched with a different one (isolated test daemons) would
      // still double-fire real schedules. The lock lives in the project
      // checkout itself, which every daemon resolves identically, so exactly
      // one daemon arms schedules per project. Held locks are re-used, denials
      // are re-checked on every attempt (the holder may have exited), and a
      // denial disables scheduling for that project only, never serving.
      const schedulerLocksHeld = new Set<string>();
      const schedulerLockWarned = new Map<string, string>();
      const canArmSchedules = (projectId: string, projectRoot: string): boolean => {
        if (schedulerLocksHeld.has(projectId)) return true;
        const result = acquireSchedulerLock(projectRoot);
        if (result.acquired) {
          schedulerLocksHeld.add(projectId);
          schedulerLockWarned.delete(projectId);
          return true;
        }
        const lockOwner = result.error
          ?? (result.holder ? `PID ${result.holder.pid}` : 'an unknown lock owner');
        if (schedulerLockWarned.get(projectId) !== lockOwner) {
          schedulerLockWarned.set(projectId, lockOwner);
          console.error(chalk.yellow(
            `Warning: schedules for ${projectId} are unavailable (${lockOwner}). ` +
            `Skipping scheduling here to prevent duplicate runs. Stop the owning daemon and touch an agent file (or restart) to take over.`
          ));
        }
        return false;
      };

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
            if (agent.config.schedule && canArmSchedules(seed.id, seed.root)) {
              scheduler.add(seed.id, agentFile, agent.config.schedule, agent.config.name);
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
      let projectCreationInFlight = false;
      const watchProject = (project: Project): FileWatcher => {
        const watcher = new FileWatcher({
          projectRoot: project.root,
          ...(project.scopeRoot !== project.root && { agentRoot: project.scopeRoot }),
          envFile: project.envFile,

          onAgentAdded: async (relativePath: string) => {
            // agentFiles is the source of truth for the /agents listing
            // (collectAgents iterates it) and the project's agent count.
            // Membership follows *discovery*, not a successful parse: startup
            // globs every .agentuse file (broken ones included), so hot-reload
            // must too. A file that fails to parse then surfaces as an error row
            // via collectAgents (which re-parses live per request) instead of
            // vanishing, and it self-heals the moment it is fixed on disk - no
            // restart needed. Gating membership on a clean parse was why a new
            // agent with a bad frontmatter field stayed invisible until restart.
            if (!project.agentFiles.includes(relativePath)) {
              project.agentFiles.push(relativePath);
              agentCounts.set(project.id, project.agentFiles.length);
              updateRegistryCounts();
            }

            try {
              const agentPath = resolveScopedAgentPath(project, relativePath);
              const agent = await parseAgent(agentPath);
              const schedule = agent.config.schedule && canArmSchedules(project.id, project.root)
                ? scheduler.add(project.id, relativePath, agent.config.schedule, agent.config.name)
                : undefined;
              printHotReload(project.id, "added", relativePath, schedule);
            } catch (err) {
              // Keep it in agentFiles so it shows as an error row and is retried
              // on the next edit/scan; do not drop it.
              logger.warn(`Hot reload: Failed to parse new agent ${project.id}/${relativePath}: ${(err as Error).message}`);
            }
          },

          onAgentChanged: async (relativePath: string) => {
            try {
              const agentPath = resolveScopedAgentPath(project, relativePath);
              const agent = await parseAgent(agentPath);

              // Backfill membership: a file first discovered while unparseable is
              // already in agentFiles (see onAgentAdded); stay self-sufficient in
              // case a change is the first successful parse we see for it.
              if (!project.agentFiles.includes(relativePath)) {
                project.agentFiles.push(relativePath);
                agentCounts.set(project.id, project.agentFiles.length);
              }

              // Without the scheduler lock, pass no schedule: update() then
              // only clears any stale entry instead of arming a new one.
              const schedule = scheduler.update(
                project.id,
                relativePath,
                agent.config.schedule && canArmSchedules(project.id, project.root) ? agent.config.schedule : undefined,
                agent.config.name
              );
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

            // Drop the stale path from the listing source of truth (see
            // onAgentAdded). Without this, collectAgents keeps trying to parse
            // a file that no longer exists and surfaces it as a "File not
            // found" error row.
            const idx = project.agentFiles.indexOf(relativePath);
            if (idx !== -1) project.agentFiles.splice(idx, 1);

            agentCounts.set(project.id, project.agentFiles.length);
            updateRegistryCounts();
          },

          onEnvReloaded: () => {
            // Env changes are picked up by the worker on its next execute,
            // which re-reads the project's .env / .env.local before each run.
          },
        });

        watcher.start();
        fileWatchers.push(watcher);
        return watcher;
      };
      for (const project of projects) {
        watchProject(project);
      }

      /** Attach the first managed project without restarting the daemon. The
       * request handler persists its config entry only after this succeeds. */
      const attachManagedProject = async (id: string, projectRoot: string): Promise<{ project: Project; rollback: () => Promise<void> }> => {
        const envLocal = resolve(projectRoot, '.env.local');
        const seed: Omit<Project, 'agentFiles'> = {
          id,
          root: projectRoot,
          scopeRoot: projectRoot,
          envFile: existsSync(envLocal) ? envLocal : resolve(projectRoot, '.env'),
        };
        await initStorage(projectRoot);
        const worker = await spawnProjectWorker(seed);
        const project: Project = { ...seed, agentFiles: [] };
        let watcher: FileWatcher | undefined;
        const rollback = async (): Promise<void> => {
          if (watcher) {
            await watcher.close().catch(() => {});
            const watcherIndex = fileWatchers.indexOf(watcher);
            if (watcherIndex >= 0) fileWatchers.splice(watcherIndex, 1);
          }
          worker.shutdown();
          workers.delete(id);
          workerReadyAt.delete(id);
          const seedIndex = projectSeeds.indexOf(seed);
          if (seedIndex >= 0) projectSeeds.splice(seedIndex, 1);
          const projectIndex = projects.indexOf(project);
          if (projectIndex >= 0) projects.splice(projectIndex, 1);
          projectsById.delete(id);
          agentCounts.delete(id);
          pathSeen.delete(projectRoot);
          idSeen.delete(id);
          multiProject = projects.length > 1;
          updateRegistryCounts();
        };
        try {
          projectSeeds.push(seed);
          projects.push(project);
          projectsById.set(id, project);
          agentCounts.set(id, 0);
          pathSeen.set(projectRoot, id);
          idSeen.set(id, projectRoot);
          multiProject = projects.length > 1;
          if (projects.length === 1) effectiveDefault = undefined;
          watcher = watchProject(project);
          updateRegistryCounts();
          orphanReconcileLoop.runNow();
          logger.info(`Project ${id}: ${projectRoot}`);
          return { project, rollback };
        } catch (error) {
          await rollback();
          throw error;
        }
      };

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

        if (projects.length === 0) {
          return {
            error: {
              status: 409,
              code: "PROJECT_REQUIRED",
              message: "Create a project before running an agent",
            },
          };
        }

        if (!multiProject) {
          return { project: projects[0]! };
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
            // Stamp the resolved project id so clients that landed on a
            // session URL without ?project= (push links, multi-project
            // daemons) can still address project-scoped endpoints like
            // POST /api/run.
            info.approval.project = project.id;
            info.approval.projectPath = project.scopeRoot;
            // Same idea for the agent's scope-relative path: it is what the
            // agent detail hub is addressed by, and only the daemon knows the
            // served scope the session's absolute file path sits under.
            const agentRunPath = toAgentRunPath(project, info.approval.agent.filePath);
            if (agentRunPath) info.approval.agent.runPath = agentRunPath;
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
        const selection = selectSessionProjects(projects, projectId);
        if (!selection.success) return selection;
        const selectedProjects = selection.projects;

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
            // Stamp the resolved project id so clients that landed on a
            // session URL without ?project= (push links, multi-project
            // daemons) can still address project-scoped endpoints like
            // POST /api/run.
            info.approval.project = project.id;
            info.approval.projectPath = project.scopeRoot;
            // Same idea for the agent's scope-relative path: it is what the
            // agent detail hub is addressed by, and only the daemon knows the
            // served scope the session's absolute file path sits under.
            const agentRunPath = toAgentRunPath(project, info.approval.agent.filePath);
            if (agentRunPath) info.approval.agent.runPath = agentRunPath;
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
        const selection = selectSessionProjects(projects, projectId);
        if (!selection.success) return selection;
        const selectedProjects = selection.projects;

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
      // The last background resume failure per gate (keyed `${projectId}:${sessionId}`),
      // so a failed approve/reject/comment surfaces an error on the still-pending
      // gate instead of silently doing nothing (the resume is fire-and-forget, so
      // the failure lands after the 202 and can't be returned in the response).
      // Cleared when a fresh decision is submitted and when a resume succeeds.
      const approvalResumeErrors = new Map<string, { status: string; message: string; at: number }>();
      // Verb for the surfaced message, per decision status.
      const resumeActionVerb = (status: string): string =>
        status === 'approved' ? 'approve'
          : status === 'rejected' ? 'reject'
            : status === 'comment' ? 'send your comment on'
              : 'act on';
      // Attach any recorded resume failure to a pending gate's approval object as
      // its errorMessage (empty on a live gate), so the existing web gate renders
      // it. No-op once the gate leaves the suspended/waiting state.
      const applyResumeError = <T extends { errorMessage?: string; sessionStatus?: string }>(
        approvalObj: T,
        activeKey: string
      ): T => {
        const failure = approvalResumeErrors.get(activeKey);
        if (!failure) return approvalObj;
        const stillOpen = approvalObj.sessionStatus === undefined
          || approvalObj.sessionStatus === 'suspended'
          || approvalObj.sessionStatus === 'waiting';
        if (!stillOpen) return approvalObj;
        // "try again" only holds when a gate is actually still there to decide on.
        // A resume rejected as CASCADE_GATE_UNRESOLVABLE means the delegated child
        // already ended, so retrying can never work — telling the reviewer to retry
        // sends them into a loop.
        const retryable = !failure.message.includes('CASCADE_GATE_UNRESOLVABLE');
        approvalObj.errorMessage = `Couldn't ${resumeActionVerb(failure.status)} this request: ${failure.message}`
          + (retryable ? ' — the gate is still open, try again.' : '');
        return approvalObj;
      };
      const loggedApprovalRequests = new Map<string, number>();
      // Sessions whose terminal state already produced a push, so runner
      // retries or duplicate pokes can't buzz devices twice.
      const notifiedFinishedSessions = new Map<string, number>();
      const slackBotToken = process.env.SLACK_BOT_TOKEN;
      const slackAppToken = process.env.SLACK_APP_TOKEN;

      const approvalActionSessionId = (info: WorkerApprovalInfoResult, fallbackSessionId: string): string =>
        info.approval.viewOnly && info.approval.rootSessionId
          ? info.approval.rootSessionId
          : fallbackSessionId;

      // Validate a remember request BEFORE the resume kicks off (throws → 400).
      // Returns null when no rule was requested. Does NOT write anything.
      const resolveRememberedLearning = async (
        info: WorkerApprovalInfoResult,
        remember: string | undefined,
        sessionId: string,
      ): Promise<{ agentFilePath: string; stateRoot: string; instruction: string; model?: string | undefined; agentInstructions?: string | undefined; sessionTranscript?: string | undefined; sessionId?: string | undefined; cap?: number | undefined } | null> => {
        const instruction = remember?.trim();
        if (!instruction) return null;
        const targetAgent = info.approval.originAgent ?? info.approval.agent;
        if (!targetAgent.filePath) {
          throw new Error("Cannot remember a learning because this approval does not record an agent file path");
        }
        // A manual "remember" is the reviewer's explicit opt-in, so it does not
        // require learning.apply — the instruction is stored regardless. Whether
        // it is injected into future runs is still governed by learning.apply.
        // Parse the agent to ground the note (via the agent's model +
        // instructions + the work at the gate).
        const agent = await parseAgent(targetAgent.filePath);
        const stateRoot = resolveProjectContext(dirname(targetAgent.filePath), {
          agentFilePath: targetAgent.filePath,
        }).stateRoot;
        return { agentFilePath: targetAgent.filePath, stateRoot, instruction, model: agent.config.model, agentInstructions: agent.instructions, sessionTranscript: buildRunTranscript(info.approval.logs), sessionId, cap: effectiveCap(agent.config.learning) };
      };

      // Persist a resolved manual instruction best-effort: a learnings-file write
      // failure is logged and never aborts the (already kicked-off) resume.
      const persistRememberedLearning = (
        target: { agentFilePath: string; stateRoot: string; instruction: string; model?: string | undefined; agentInstructions?: string | undefined; sessionTranscript?: string | undefined; sessionId?: string | undefined; cap?: number | undefined } | null,
      ): void => {
        if (!target) return;
        void saveManualLearning(target).catch((err) => {
          logger.warn(`Failed to persist remembered learning: ${(err as Error).message}`);
        });
      };

      // Read + normalize the optional `remember` body field (shared by both
      // decision endpoints).
      const readRememberField = (body: Record<string, unknown>): string | undefined =>
        typeof body.remember === 'string' && body.remember.trim().length > 0
          ? body.remember.trim()
          : undefined;

      // Shared choice validation for both decision routes. A gate that published
      // options requires an approve decision to name one of them, so the agent can
      // trust `approved ⇒ choice is a known id`; gates without options reject any
      // choice to catch client bugs early. Returns an error to send, or null when
      // the (status, choice) pair is acceptable.
      const validateDecisionChoice = (
        info: WorkerApprovalInfoResult,
        status: string,
        choice: string | undefined
      ): { code: string; message: string } | null => {
        const gateOptions = info.approval.options;
        // Both spellings reach the worker as an approval ('approve' and
        // 'approved' normalize to the same decision in src/index.ts), so both
        // must validate identically — otherwise 'approved' bypasses
        // CHOICE_REQUIRED and a valid 'approved'+choice is spuriously rejected.
        const isApprove = status === 'approve' || status === 'approved';
        if (choice !== undefined) {
          if (!isApprove) {
            return { code: 'CHOICE_REQUIRES_APPROVE', message: 'A choice can only be submitted with an approve decision' };
          }
          if (!gateOptions?.some((o) => o.id === choice)) {
            return { code: 'CHOICE_INVALID', message: `Choice "${choice}" is not one of this gate's options` };
          }
          return null;
        }
        if (isApprove && gateOptions && gateOptions.length > 0) {
          return { code: 'CHOICE_REQUIRED', message: 'This gate offers options; approve decisions must include a choice (option id)' };
        }
        return null;
      };

      // Shared resume kickoff for both /approvals/:id/decision and the unified
      // /sessions/:id/decision. The caller validates auth + state, then hands us
      // the resolved gate resumeToken; we run the worker resume, update any
      // Slack thread, track the in-flight promise, and write the 202.
      const startApprovalResume = (
        res: ServerResponse,
        params: {
          project: Project;
          sessionId: string;
          info: WorkerApprovalInfoResult;
          resumeToken: string;
          status: string;
          comment?: string | undefined;
          // Option id selected on a pick-among-options gate; validated by the
          // route handler against the gate's published options.
          choice?: string | undefined;
          // Extra fields merged into the 202 body, so alternate entry points
          // (the stop endpoint's reject reroute) can mark how they resolved.
          responseExtra?: Record<string, unknown> | undefined;
          // Invoked when the resume fails for a reason other than the session
          // having already completed. The stop endpoint uses this to fall back
          // to a hard stop so "stop" always ends the session.
          onResumeFailure?: (() => void) | undefined;
        }
      ): void => {
        const { project, sessionId, info, resumeToken, status, comment, choice } = params;
        const projectWorker = workers.get(project.id)!;
        const targetSessionId = approvalActionSessionId(info, sessionId);
        // The resumed run will reach a fresh terminal state; drop any push-dedup
        // entry from a previous completion (reopen-after-error flows) so the new
        // finished poke notifies instead of reporting 'already-notified'.
        notifiedFinishedSessions.delete(targetSessionId);
        const activeKey = `${project.id}:${targetSessionId}`;
        // Fresh decision: drop any error from a previous failed attempt on this gate.
        approvalResumeErrors.delete(activeKey);
        approvalLog.received('web', status, targetSessionId, 'web');
        const resumeStart = Date.now();
        approvalLog.resumeStarted(targetSessionId);
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
            sessionId: targetSessionId,
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
          sessionId: targetSessionId,
          toolResult: {
            status,
            ...(comment && { comment }),
            ...(choice && { choice }),
            reviewer: { username: 'web' }
          },
          resumeToken,
          debug: options.debug,
        })).then(result => {
          if (!result.success) {
            const alreadyCompleted = /SESSION_NOT_SUSPENDED:\s*completed/i.test(result.error.message);
            if (alreadyCompleted) {
              approvalResumeErrors.delete(activeKey);
              approvalLog.resumeCompleted(targetSessionId, Date.now() - resumeStart);
              return;
            }
            // Surface the failure on the still-pending gate (the 202 already went out).
            approvalResumeErrors.set(activeKey, { status, message: result.error.message, at: Date.now() });
            approvalLog.resumeFailed(targetSessionId, Date.now() - resumeStart, result.error.message);
            logger.warn(`Approval resume ${targetSessionId} failed: ${result.error.message}`);
            try {
              params.onResumeFailure?.();
            } catch (hookErr) {
              logger.warn(`Approval resume failure hook for ${targetSessionId} failed: ${(hookErr as Error).message}`);
            }
            if (slackChannelMessage && info.approval.prompt) {
              void updateSlackApprovalRequestStatus({
                botToken: slackBotToken!,
                channelId: slackChannelMessage.channelId,
                ts: slackChannelMessage.ts,
                ...(slackChannelMessage.actionTs && { actionTs: slackChannelMessage.actionTs }),
                prompt: info.approval.prompt,
                sessionId: targetSessionId,
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
            approvalResumeErrors.delete(activeKey);
            approvalLog.resumeCompleted(targetSessionId, Date.now() - resumeStart);
            if (slackChannelMessage && info.approval.prompt) {
              void updateSlackApprovalRequestStatus({
                botToken: slackBotToken!,
                channelId: slackChannelMessage.channelId,
                ts: slackChannelMessage.ts,
                ...(slackChannelMessage.actionTs && { actionTs: slackChannelMessage.actionTs }),
                prompt: info.approval.prompt,
                sessionId: targetSessionId,
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
          void refreshProjectLists(project);
        });
        activeApprovalResumes.set(activeKey, resumePromise);
        wakeListHubs();

        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessionId: targetSessionId, status: "resuming", ...params.responseExtra }));
      };

      // Shared continue kickoff for both /approvals/:id/continue and
      // /sessions/:id/continue.
      const startSessionContinue = (
        res: ServerResponse,
        params: { project: Project; sessionId: string; prompt: string }
      ): void => {
        const { project, sessionId, prompt } = params;
        const projectWorker = workers.get(project.id)!;
        // A continued session finishes again; clear the push dedup from its
        // first completion or the continuation's terminal state sends no push.
        notifiedFinishedSessions.delete(sessionId);
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
            wakeListHubs();
          });
        activeSessionContinuations.set(activeKey, continuePromise);
        wakeListHubs();

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

        const targetSessionId = approvalActionSessionId(info, decision.sessionId);
        const activeKey = `${project.id}:${targetSessionId}`;
        const existingResume = activeApprovalResumes.get(activeKey);
        if (existingResume) {
          await existingResume;
          return;
        }

        const resumePromise = Promise.resolve().then(async () => {
          const resumeStart = Date.now();
          approvalLog.resumeStarted(targetSessionId);
          const result = await projectWorker.execute({
            projectRoot: project.root,
            sessionId: targetSessionId,
            toolResult: decision.toolResult,
            resumeToken: decision.resumeToken,
            debug: options.debug,
          });

          if (!result.success) {
            const alreadyCompleted = /SESSION_NOT_SUSPENDED:\s*completed/i.test(result.error.message);
            if (alreadyCompleted) {
              approvalLog.resumeCompleted(targetSessionId, Date.now() - resumeStart);
              return;
            }
            approvalLog.resumeFailed(targetSessionId, Date.now() - resumeStart, result.error.message);
            throw new Error(result.error.message);
          }
          approvalLog.resumeCompleted(targetSessionId, Date.now() - resumeStart);
        }).finally(() => {
          if (activeApprovalResumes.get(activeKey) === resumePromise) {
            activeApprovalResumes.delete(activeKey);
          }
          wakeListHubs();
        });

        activeApprovalResumes.set(activeKey, resumePromise);
        wakeListHubs();
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

        const channel = approval.channelMessage.channel;
        const threadTs = approval.channelMessage.ts;
        // Already fire-and-forget; the async wrapper is only so the deferred
        // Slack SDK can be awaited without changing this helper's signature.
        void (async () => {
          const web = await getSlackWebClient(slackBotToken);
          await web.chat.postMessage({
            channel,
            thread_ts: threadTs,
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
          });
        })().catch((err) => logger.warn(`Slack approval thread note failed: ${(err as Error).message}`));
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
        void (async () => {
          const web = await getSlackWebClient(slackBotToken);
          await web.chat.postMessage({
            channel: comment.channel,
            thread_ts: comment.threadTs,
            text,
            blocks
          });
        })().catch((err) => logger.warn(`Slack run thread note failed: ${(err as Error).message}`));
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

        wakeListHubs();
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
        void done.finally(wakeListHubs).catch(() => {});

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
              wakeListHubs();
            }
          });
          activeApprovalResumes.set(activeKey, done);
          wakeListHubs();
          return { handled: true, done };
        }

        logger.debug(`Slack thread comment matched no pending approval (reply in ${comment.channel}/${comment.threadTs})`);
        return { handled: false };
      };

      let slackApprovalSocket: SlackApprovalSocket | null = null;
      if (slackBotToken && slackAppToken) {
        slackApprovalSocket = await SlackApprovalSocket.create({
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

      // Deployment brand (config.json serve.brand.name): baked into the HTML
      // shell, the topbar, document titles, and the install manifest so the
      // daemon reads as the company's own operating layer.
      const brandNameCfg = serveCfg?.brand?.name;
      const manifestJson = webManifestJson(brandNameCfg);
      // Serve the built SPA (dist/web): hashed immutable assets at /assets/*,
      // and the tiny no-store HTML shell at every page route. All page data is
      // fetched client-side from the existing /api/* and /sessions/:id/* JSON.
      const staticAssets = new WebAssets(undefined, brandNameCfg, serveCfg?.terms);
      // Web Push to home-screen-installed clients: VAPID keys + device
      // subscriptions persist in the data dir; notifications fire on pending
      // approvals and session completions (see pushService.notify call sites).
      const pushService = new PushService(getXdgDataDir(), (msg) => console.log(msg));
      type NativeNotificationEvent = {
        category: PushCategory;
        payload: Pick<PushPayload, 'title' | 'body' | 'url' | 'tag' | 'appBadge'>;
      };
      const notificationHub = new NotificationEventHub<NativeNotificationEvent>();
      const deliverNotification = (category: PushCategory, payload: PushPayload): Promise<void> => {
        notificationHub.publish({
          category,
          payload: {
            title: payload.title,
            body: payload.body,
            url: payload.url,
            ...(payload.tag && { tag: payload.tag }),
            ...(payload.appBadge !== undefined && { appBadge: payload.appBadge }),
          },
        });
        return pushService.notify(category, payload);
      };
      // Push session/approval state to the SPA over SSE (one worker poll per
      // session, fanned to all subscribed tabs), replacing in-page polling.
      const approvalHub = new ApprovalEventHub();
      const approvalListHub = new ApprovalListEventHub<ApprovalListPayload>({
        intervalMs: APPROVAL_LIST_SSE_INTERVAL_MS,
      });
      const sessionListHub = new ApprovalListEventHub<SessionsPayload>({
        eventName: 'sessions',
        intervalMs: SESSION_LIST_SSE_INTERVAL_MS,
        liveIntervalMs: SESSION_LIST_SSE_LIVE_INTERVAL_MS,
        isLive: (payload) => payload.sessions.some(
          (s) => s.status === 'running' || s.status === 'resuming' || s.status === 'continuing' || s.subagentActive === true
        ),
      });
      // Feed mode reads final assistant text from the durable transcript. Cache
      // non-running sessions by their list-index timestamp so SSE refreshes do
      // not repeatedly walk 50 completed session directories. Running sessions
      // intentionally bypass the cache so streamed text remains live.
      const sessionFinalResponseCache = new Map<string, {
        updatedAt: number;
        finalResponse: string | undefined;
      }>();
      // The list hubs poll on a slow steady cadence; nudge them the moment the
      // daemon knows the lists are about to change (run triggered, decision
      // made, runner announced a state change) so dashboards update in ~1s.
      wakeListHubs = () => {
        sessionListHub.wake();
        approvalListHub.wake();
      };

      const buildSessionsPayload = async (
        requestUrl: URL
      ): Promise<
        | { success: true; payload: SessionsPayload }
        | { success: false; status: number; code: string; message: string }
      > => {
        const agentFilter = requestUrl.searchParams.get('agent') ?? undefined;
        const statusFilter = parseSessionStatusFilter(requestUrl.searchParams.get('status') ?? undefined);
        const triageFilter = parseSessionTriageFilter(requestUrl.searchParams.get('triage') ?? undefined);
        const triggerFilterRaw = requestUrl.searchParams.get('trigger') ?? undefined;
        const triggerFilter: SessionTrigger | undefined =
          triggerFilterRaw === 'scheduled' || triggerFilterRaw === 'manual' || triggerFilterRaw === 'slack' || triggerFilterRaw === 'api' || triggerFilterRaw === 'onboarding'
            ? triggerFilterRaw
            : undefined;
        const approvalFilter = parseApprovalSessionFilter(requestUrl.searchParams.get('approval') ?? undefined);
        const mockFilter = parseSessionMockFilter(requestUrl.searchParams.get('mock') ?? undefined);
        const updatedAfter = sessionListUpdatedAfter(requestUrl);
        const daysFilter = sessionDaysFilterValue(requestUrl);
        const detail = requestUrl.searchParams.get('detail');
        const rawLimit = requestUrl.searchParams.get('limit');
        const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
        const requestedLimit = parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? Math.min(Math.floor(parsedLimit), LIST_PAGE_MAX_LIMIT)
          : rawLimit === null ? undefined : LIST_PAGE_DEFAULT_LIMIT;
        const canPrelimit = requestedLimit !== undefined &&
          !requestUrl.searchParams.get('cursor') &&
          !agentFilter && !statusFilter && !triageFilter && !triggerFilter && !approvalFilter;

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
              ...(updatedAfter !== undefined && { updatedAfter }),
              ...(approvalFilter && { includeSubagents: true }),
              ...(canPrelimit && { limit: requestedLimit }),
              ...(detail === 'agents' && { perAgent: 12 }),
              mock: mockFilter,
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
            const result = await projectWorker.listApprovals(project.root);
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
            if (!sessionMatchesMockFilter(session, mockFilter)) continue;
            if (!sessionMatchesStatusFilter(session, statusFilter)) continue;
            if (!sessionMatchesTriageFilter(session, triageFilter)) continue;
            if (triggerFilter && session.trigger !== triggerFilter) continue;
            if (approvalFilter && !approvalSessionIdsByProject.get(result.project.id)?.has(session.sessionId)) continue;
            if (agentFilter && !sessionMatchesAgentFilter(session, agentFilter)) continue;
            rows.push({ projectId: result.project.id, session });
          }
        }

        // Live runs (actively running, or a parent whose delegated child is
        // running) sort ahead of everything else so in-flight work is never
        // buried below runs that merely finished more recently; within each tier,
        // most-recently-active first. The cursor relocates rows by their stable
        // key (createdAt+id), so this ordering does not affect pagination.
        const isLive = (s: SessionSummary) => s.status === 'running' || s.subagentActive === true;
        rows.sort((a, b) =>
          (isLive(a.session) ? 0 : 1) - (isLive(b.session) ? 0 : 1) ||
          b.session.updatedAt - a.session.updatedAt ||
          b.session.createdAt - a.session.createdAt ||
          a.projectId.localeCompare(b.projectId) ||
          a.session.sessionId.localeCompare(b.session.sessionId)
        );
        // Fingerprint on the window FILTER, not the resolved updatedAfter
        // cutoff: the cutoff is minute-quantized (listWindowNow), so embedding
        // it would silently expire every cursor at the next minute boundary and
        // restart Load more from page 1. A cursor row that slides out of the
        // window is still caught by cursorPage's row-lookup fallback.
        const fingerprint = ['sessions', daysFilter, agentFilter ?? '', statusFilter ?? '', triageFilter ?? '', triggerFilter ?? '', approvalFilter ?? ''].join('\0');
        const page = cursorPage(requestUrl, fingerprint, rows, (row) =>
          `${row.session.createdAt}\0${row.projectId}\0${row.session.sessionId}`
        );

        let pageItems = page.items;
        if (detail === 'feed') {
          const finalResponses = new Map<string, string | undefined>();
          const missingByProject = new Map<string, ProjectSessionRow[]>();

          for (const row of page.items) {
            const cacheKey = `${row.projectId}\0${row.session.sessionId}`;
            const cached = sessionFinalResponseCache.get(cacheKey);
            const stable = row.session.status !== 'running';
            if (stable && cached?.updatedAt === row.session.updatedAt) {
              finalResponses.set(cacheKey, cached.finalResponse);
              continue;
            }
            const projectRows = missingByProject.get(row.projectId) ?? [];
            projectRows.push(row);
            missingByProject.set(row.projectId, projectRows);
          }

          await Promise.all([...missingByProject.entries()].map(async ([projectId, projectRows]) => {
            const projectWorker = workers.get(projectId);
            const project = projects.find((candidate) => candidate.id === projectId);
            if (!projectWorker || !project) return;
            const result = await projectWorker.getSessionFinalResponses(
              project.root,
              projectRows.map((row) => ({
                sessionId: row.session.sessionId,
                agentId: row.session.agent.id,
              }))
            );
            if (!result.success) {
              if (!errors.some((error) => error.projectId === projectId)) {
                errors.push({ projectId, message: `Final responses unavailable: ${result.error.message}` });
              }
              return;
            }
            for (const row of projectRows) {
              const cacheKey = `${projectId}\0${row.session.sessionId}`;
              const finalResponse = result.responses[row.session.sessionId];
              finalResponses.set(cacheKey, finalResponse);
              if (row.session.status !== 'running') {
                sessionFinalResponseCache.set(cacheKey, {
                  updatedAt: row.session.updatedAt,
                  finalResponse,
                });
              }
            }
          }));

          // Keep this process-local optimization bounded even when an operator
          // pages through years of session history.
          while (sessionFinalResponseCache.size > 1_000) {
            const oldest = sessionFinalResponseCache.keys().next().value;
            if (oldest === undefined) break;
            sessionFinalResponseCache.delete(oldest);
          }

          pageItems = page.items.map((row) => {
            const finalResponse = finalResponses.get(`${row.projectId}\0${row.session.sessionId}`);
            return finalResponse === undefined
              ? row
              : { ...row, session: { ...row.session, finalResponse } };
          });
        }

        return {
          success: true,
          payload: {
            success: true,
            sessions: pageItems.map((row) => ({ project: row.projectId, ...row.session })),
            window: {
              value: daysFilter,
              ...(daysFilter === 'all'
                ? { days: 'all' as const }
                : daysFilter.endsWith('h')
                  ? { hours: Number(daysFilter.slice(0, -1)) }
                  : { days: Number(daysFilter.slice(0, -1)) }),
              ...(updatedAfter !== undefined && { updatedAfter })
            },
            ...(agentFilter && { agent: agentFilter }),
            ...(statusFilter && { status: statusFilter }),
            ...(triageFilter && { triage: triageFilter }),
            ...(triggerFilter && { trigger: triggerFilter }),
            ...(approvalFilter && { approval: approvalFilter }),
            ...(page.limit !== undefined && { limit: page.limit }),
            ...(page.nextCursor && { nextCursor: page.nextCursor }),
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
          // A decision is accepted before the worker necessarily rewrites the
          // cached approval projection. The serve process already knows that
          // resume is in flight, so do not keep advertising the old gate while
          // that durable transition catches up. A failed resume removes the
          // active key and restores the pending gate on the following refresh.
          .filter((r) => isPendingApprovalVisible(r.projectId, r.approval, activeApprovalResumes))
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
        // The flat list is the cursor's canonical ordering. Buckets below are
        // derived from its current page, while legacy callers still receive all
        // rows and the historical full buckets.
        const ordered = [...pending, ...completed, ...expired];
        // Fingerprint on the days PARAM, not the resolved createdAfter cutoff —
        // the cutoff is minute-quantized and would expire every cursor at the
        // next minute boundary (see the sessions fingerprint above).
        const fingerprint = ['approvals', requestUrl.searchParams.get('days') ?? String(APPROVAL_LIST_DEFAULT_DAYS), requestedProject ?? ''].join('\0');
        const page = cursorPage(requestUrl, fingerprint, ordered, (row) =>
          `${row.decisionAt ?? row.suspendedAt ?? row.createdAt ?? 0}\0${row.project}\0${row.sessionId}\0${row.status}`
        );
        const paged = page.limit === undefined ? undefined : page.items;
        const pagePending = (paged ?? pending).filter((row) => row.status === 'pending');
        const pageCompleted = (paged ?? completed).filter((row) => row.status === 'approved' || row.status === 'rejected' || row.status === 'commented');
        const pageExpired = (paged ?? expired).filter((row) => row.status === 'expired' || row.status === 'errored');
        const days = requestUrl.searchParams.get('days') === 'all'
          ? 'all' as const
          : Math.floor((Date.now() - createdAfter!) / (24 * 60 * 60 * 1000));
        const bucketsOnly = requestUrl.searchParams.get('view') === 'buckets';

        return {
          success: true,
          payload: {
            success: true,
            multiProject: selectedProjects.length > 1,
            approvals: bucketsOnly ? [] : (paged ?? rows.map(serializeRow)),
            buckets: { pending: pagePending, completed: pageCompleted, expired: pageExpired },
            window: {
              days,
              ...(createdAfter !== undefined && { createdAfter })
            },
            ...(page.limit !== undefined && { limit: page.limit }),
            ...(page.nextCursor && { nextCursor: page.nextCursor }),
            errors
          }
        };
      };

      const webUITelemetryGuard = createWebUITelemetryGuard();
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

        // Origin-based CORS/CSRF hardening. A keyless local daemon has no auth
        // gate (see the `if (apiKey && ...)` check below), so a wildcard ACAO
        // would let any website the user visits read every endpoint and drive
        // POST /run cross-origin. Compare the request Origin's host against the
        // Host the browser used to reach us — same-origin UI requests match
        // regardless of host alias (localhost/127.0.0.1/hostname) or scheme;
        // a cross-site request does not.
        const requestOrigin = req.headers.origin;
        let crossOrigin = false;
        if (requestOrigin && requestOrigin !== "null") {
          try {
            crossOrigin = new URL(requestOrigin).host !== req.headers.host;
          } catch {
            crossOrigin = true;
          }
        }

        // CORS headers
        if (apiKey) {
          // Browsers can't forge the Bearer header and non-browser clients ignore
          // CORS, so a wildcard is safe and keeps programmatic access simple.
          res.setHeader("Access-Control-Allow-Origin", "*");
        } else if (requestOrigin && !crossOrigin) {
          // Keyless daemon: reflect only the caller's own origin, never wildcard.
          res.setHeader("Access-Control-Allow-Origin", requestOrigin);
          res.setHeader("Vary", "Origin");
        }
        res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
        res.setHeader("Access-Control-Allow-Headers", "Content-Type, Accept, Authorization");

        if (req.method === "OPTIONS") {
          res.writeHead(204);
          res.end();
          return;
        }

        // Reject cross-origin state-changing requests on the keyless daemon.
        // The missing ACAO above already blocks a browser from reading responses;
        // this also stops "simple" requests (e.g. a form POST) that skip preflight
        // from reaching side-effecting handlers like /run.
        if (!apiKey && crossOrigin && req.method !== "GET") {
          sendError(res, 403, "FORBIDDEN", "Cross-origin request rejected on local daemon");
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

        // Home-screen install assets: web app manifest + PNG icons (iOS
        // ignores SVG for touch icons). Public like the favicon so Add to
        // Home Screen works from capability (token-only) session links too.
        if (req.method === "GET" && routePath === "/manifest.webmanifest") {
          res.writeHead(200, { "Content-Type": "application/manifest+json", "Cache-Control": "public, max-age=86400" });
          res.end(manifestJson);
          return;
        }
        if (req.method === "GET") {
          const installIcon =
            routePath === "/apple-touch-icon.png" || routePath === "/apple-touch-icon-precomposed.png"
              ? TOUCH_ICON_180_PNG
              : routePath === "/icon-192.png"
                ? ICON_192_PNG
                : routePath === "/icon-512.png"
                  ? ICON_512_PNG
                  : null;
          if (installIcon) {
            res.writeHead(200, { "Content-Type": "image/png", "Cache-Control": "public, max-age=86400" });
            res.end(installIcon);
            return;
          }
        }

        // Service worker for Web Push. Public (browsers fetch it without auth
        // headers) and served at root so its scope covers the whole app.
        // no-cache so worker updates roll out on next page load.
        if (req.method === "GET" && routePath === "/sw.js") {
          res.writeHead(200, { "Content-Type": "text/javascript; charset=utf-8", "Cache-Control": "no-cache" });
          res.end(SERVICE_WORKER_JS);
          return;
        }

        // SPA static assets (hashed, immutable) — public, served before the auth
        // gate so the browser can load the bundle on token-only deep links.
        if (staticAssets.serveAsset(req, res, requestUrl.pathname)) return;

        // The browser reports only a fixed page category to its own local
        // daemon. Same-origin submissions work on API-key/capability daemons
        // without putting a bearer secret into the SPA. Non-browser callers
        // on protected daemons still need the API key. All accepted requests
        // share a daemon-side token bucket and 15-minute page dedupe window.
        if (isApi && routePath === '/telemetry' && req.method === 'POST' && canSubmitWebUITelemetry({
          apiKey,
          authorization: req.headers.authorization,
          requestOrigin,
          crossOrigin,
        })) {
          try {
            const raw = await readRequestBody(req, 1024);
            const event = parseWebUITelemetryBody(
              raw ? JSON.parse(raw) as Record<string, unknown> : {},
              webUIClientSurface(req.headers['x-agentuse-client']),
            );
            if (event && acceptWebUITelemetry(
              webUITelemetryGuard,
              webUITelemetryDedupeKey(event),
              Date.now(),
              event.event !== 'desktop_app_launched',
            )) {
              telemetry.captureWebUITelemetry(event);
            }
          } catch {
            // Invalid, oversized, duplicate, or rate-limited reports are silent.
          }
          res.writeHead(204);
          res.end();
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
          isSessionCapabilityAuthorized({
            authorization: req.headers.authorization,
            sessionToken: token,
            sessionId,
            apiKey,
          });

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

        // Web Push subscription management, operator surface (behind the
        // header gate above). Subscriptions are per browser+device; prefs
        // pick which event categories that device gets.
        if (isApi && routePath === "/push/public-key" && req.method === "GET") {
          sendJSON(res, 200, { publicKey: pushService.publicKey });
          return;
        }
        if (isApi && routePath === "/push/subscription") {
          if (req.method === "GET") {
            const endpoint = requestUrl.searchParams.get("endpoint");
            if (!endpoint) {
              sendError(res, 400, "INVALID_REQUEST", "Missing endpoint query parameter");
              return;
            }
            const record = pushService.get(endpoint);
            if (!record) {
              sendError(res, 404, "NOT_FOUND", "No subscription for this endpoint");
              return;
            }
            sendJSON(res, 200, { prefs: record.prefs });
            return;
          }
          if (req.method === "POST") {
            try {
              const body = await parseJSONBody(req);
              const sub = body.subscription as { endpoint?: unknown; keys?: { p256dh?: unknown; auth?: unknown } } | undefined;
              if (
                typeof sub?.endpoint !== "string" ||
                !/^https?:\/\//.test(sub.endpoint) ||
                typeof sub.keys?.p256dh !== "string" ||
                typeof sub.keys?.auth !== "string"
              ) {
                sendError(res, 400, "INVALID_REQUEST", "subscription must include endpoint and p256dh/auth keys");
                return;
              }
              const prefs: Partial<{ approvals: boolean; sessions: boolean }> = {};
              if (typeof body.prefs === "object" && body.prefs !== null) {
                const raw = body.prefs as Record<string, unknown>;
                if (typeof raw.approvals === "boolean") prefs.approvals = raw.approvals;
                if (typeof raw.sessions === "boolean") prefs.sessions = raw.sessions;
              }
              const record = pushService.upsert(
                { endpoint: sub.endpoint, keys: { p256dh: sub.keys.p256dh, auth: sub.keys.auth } },
                prefs,
                req.headers["user-agent"]
              );
              // A device with every category off has no reason to stay registered.
              if (!record.prefs.approvals && !record.prefs.sessions) {
                pushService.remove(record.endpoint);
                sendJSON(res, 200, { subscribed: false });
                return;
              }
              sendJSON(res, 200, { subscribed: true, prefs: record.prefs });
            } catch (err) {
              if (sendRequestParseError(res, err)) return;
              sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
            }
            return;
          }
        }
        if (isApi && routePath === "/push/unsubscribe" && req.method === "POST") {
          try {
            const body = await parseJSONBody(req);
            const endpoint = typeof body.endpoint === "string" ? body.endpoint : null;
            if (!endpoint) {
              sendError(res, 400, "INVALID_REQUEST", "Missing endpoint");
              return;
            }
            sendJSON(res, 200, { removed: pushService.remove(endpoint) });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // GET /api returns server-info JSON; GET / serves the HTML dashboard.
        // Both share the same project rollup so the two surfaces never drift.
        if (req.method === "GET" && routePath === "/") {
          const defaultProject = effectiveDefault ?? (projects.length === 1 ? projects[0]!.id : null);
          // ABOUT.md at the project root names the project for the UI (#156):
          // display identity only, read per request (mtime-cached) so edits
          // show up without a restart.
          const projectInfo = await Promise.all(projects.map(async (p) => ({
            id: p.id,
            path: p.root,
            ...(p.scopeRoot !== p.root && { scope: p.scopeRoot }),
            agentCount: agentCounts.get(p.id) ?? 0,
            scheduleCount: scheduler.list().filter((s) => s.projectId === p.id).length,
            ...await readAbout(p.root).then((about) => (about ? { about } : {})),
          })));

          if (isApi) {
            // The helper enforces the 24-hour cache interval. Calling it from
            // the polled info route lets a daemon discover releases that land
            // weeks after startup without introducing a separate live timer.
            refreshUpdateCacheInBackground(packageVersion);
            res.writeHead(200, { "Content-Type": "application/json" });
            const update = getCachedAvailableUpdate(packageVersion);
            res.end(JSON.stringify({
              version: packageVersion,
              ...(update && { update }),
              brand: { name: brandNameCfg ?? "AgentUse" },
              default: defaultProject,
              projects: projectInfo,
            }));
            return;
          }
        }

        if (req.method === "GET" && routePath === '/agents') {
          const { agents, errors } = await collectAgents(projects);
          if (isApi) {
            const dirs = await collectDirAbouts(projects, agents);
            sendJSON(res, 200, { success: true, agents, errors, ...(dirs.length > 0 && { dirs }) });
            return;
          }
        }

        // GET /api/agents/detail?project=<id>&path=<runPath>: capabilities
        // summary + raw `.agentuse` source for the agent hub page. Behind the
        // same header gate as the rest of the operator surface (not a capability
        // route), so anyone who can list/run agents can read them, UNLESS
        // serve.hideAgentSource / --hide-agent-source strips the source from
        // the payload (capabilities summary still served). The file is
        // matched against the project's already-loaded `agentFiles` set, so an
        // arbitrary `path` cannot escape the served scope.
        if (req.method === "GET" && routePath === '/agents/detail') {
          const requestedProject = requestUrl.searchParams.get('project') ?? undefined;
          const requestedPath = requestUrl.searchParams.get('path') ?? undefined;
          if (!requestedProject || !requestedPath) {
            sendError(res, 400, "MISSING_PARAMS", "Both project and path query params are required");
            return;
          }
          const project = projects.find((p) => p.id === requestedProject);
          if (!project) {
            sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${requestedProject}`);
            return;
          }
          if (!project.agentFiles.includes(requestedPath)) {
            sendError(res, 404, "AGENT_NOT_FOUND", `Agent not loaded: ${requestedPath}`);
            return;
          }
          try {
            const detail = await collectAgentDetail(project, requestedPath);
            sendJSON(res, 200, { success: true, ...(effectiveHideAgentSource ? redactAgentDetailSource(detail) : detail) });
          } catch (err) {
            sendError(res, 500, "AGENT_READ_FAILED", (err as Error).message);
          }
          return;
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
        // ?triage=<undismissed|dismissed> ?trigger= ?approval=
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
          // The poll closure below captures the FIRST subscriber's full URL, so
          // every param that shapes the payload must be part of the key —
          // including limit/cursor, or a limitless Home subscriber would share
          // (and be truncated by) a limit-50 sessions-list snapshot.
          const streamKey = sessionListStreamKey(requestUrl);
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
        // The optional trailing segment is the context-stack diagnostic subpage;
        // it is a client route, so it serves the same shell and is preserved
        // across the token-minting redirect.
        const sessionPageMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)(\/context)?$/) : null;
        if (sessionPageMatch) {
          const sessionId = decodeURIComponent(sessionPageMatch[1]);
          const sessionSubPath = sessionPageMatch[2] ?? '';
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
              const target = new URL(`/sessions/${encodeURIComponent(sessionId)}${sessionSubPath}`, serverUrl);
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
          const logsLimit = sessionLogLimit(requestUrl);
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
            const allLogs = logsWithChildSessions(
              found.info.approval.logs ?? [],
              found.info.approval.childSessions ?? [],
              (childSessionId) => {
                const params = new URLSearchParams();
                const childToken = sessionViewToken(childSessionId, apiKey);
                if (childToken) params.set('token', childToken);
                params.set('project', found.project.id);
                return `/sessions/${encodeURIComponent(childSessionId)}?${params.toString()}`;
              },
              found.info.approval.importantDescendants ?? [],
              { sessionId, agentName: found.info.approval.agent.name },
              found.info.approval.importantDescendantEvents ?? []
            );
            const logs = allLogs.slice(-logsLimit);
            const approval = { ...found.info.approval };
            delete approval.logs;
            if (approval.parentSessionId) {
              const params = new URLSearchParams();
              const parentToken = sessionViewToken(approval.parentSessionId, apiKey);
              if (parentToken) params.set('token', parentToken);
              params.set('project', found.project.id);
              approval.parentHref = `/sessions/${encodeURIComponent(approval.parentSessionId)}?${params.toString()}`;
            }
            applyResumeError(approval, activeKey);
            return { ok: true, snapshot: { status, approval, logs } };
          };
          if (!approvalHub.subscribe({ key: `${sessionId}:logs:${logsLimit}`, sessionId, poll, req, res })) {
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
          const logsLimit = sessionLogLimit(requestUrl);
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
              approval: applyResumeError({ ...found.session }, activeKey)
            }));
            return;
          }

          const found = await findSessionInfo(sessionId, projectId);
          if (!found.success) {
            sendError(res, found.status, found.code, found.message);
            return;
          }
          const statusSessionId = approvalActionSessionId(found.info, sessionId);
          const activeKey = `${found.project.id}:${statusSessionId}`;
          const status = activeApprovalResumes.has(activeKey)
            ? 'resuming'
            : activeSessionContinuations.has(activeKey)
              ? 'continuing'
              : found.info.approval.sessionStatus === 'suspended'
                ? 'waiting'
                : found.info.approval.sessionStatus;
          const allLogs = logsWithChildSessions(
            found.info.approval.logs ?? [],
            found.info.approval.childSessions ?? [],
            (childSessionId) => {
              const params = new URLSearchParams();
              const childToken = sessionViewToken(childSessionId, apiKey);
              if (childToken) params.set('token', childToken);
              params.set('project', found.project.id);
              return `/sessions/${encodeURIComponent(childSessionId)}?${params.toString()}`;
            },
            found.info.approval.importantDescendants ?? [],
            { sessionId, agentName: found.info.approval.agent.name },
            found.info.approval.importantDescendantEvents ?? []
          );
          const logs = allLogs.slice(-logsLimit);
          const parentSid = found.info.approval.parentSessionId;
          let parentHref: string | undefined;
          if (parentSid) {
            const params = new URLSearchParams();
            const parentToken = sessionViewToken(parentSid, apiKey);
            if (parentToken) params.set('token', parentToken);
            params.set('project', found.project.id);
            parentHref = `/sessions/${encodeURIComponent(parentSid)}?${params.toString()}`;
          }
          // The log array is shipped once, at the top level. Leaving a copy on
          // `approval` doubles the payload of the SPA's busiest poll.
          const approval = { ...found.info.approval };
          delete approval.logs;
          if (parentHref) approval.parentHref = parentHref;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            sessionId,
            status,
            approval: applyResumeError(approval, activeKey),
            logs,
            logsTotal: allLogs.length,
            decision: found.info.approval.decision
          }));
          return;
        }

        // GET /sessions/:id/artifacts-list: project artifacts this run produced,
        // read from the artifact manifest. Token-gated like the rest of the
        // session page data so the SPA fetches it with ?token=. The file bytes are
        // served separately by /sessions/:id/artifacts/<path>.
        const sessionArtifactsListMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/artifacts-list$/) : null;
        if (sessionArtifactsListMatch) {
          const sessionId = decodeURIComponent(sessionArtifactsListMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;
          if (!sessionAuthorized(sessionId, token)) {
            sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
            return;
          }
          // Resolving an artifact list needs only the owning project. The old
          // path rebuilt the complete transcript/approval view before reading
          // the manifest, multiplying that work during live log bursts.
          const found = await findSessionStatusInfo(sessionId, projectId);
          if (!found.success) {
            sendError(res, found.status, found.code, found.message);
            return;
          }
          const manifest = await readArtifactManifest(getManifestPath(found.project.root));
          const artifacts = manifest.artifacts
            .filter((a) => a.sessionId === sessionId)
            .map((a) => ({
              name: a.name,
              ...(a.title !== undefined ? { title: a.title } : {}),
              type: a.type,
              group: a.group,
              createdAt: a.createdAt,
              updatedAt: a.updatedAt,
            }));
          sendJSON(res, 200, { success: true, artifacts });
          return;
        }

        // GET /sessions/:id/context-stack: the diagnostic breakdown of what went
        // into this run's context window - system messages, tool schemas, agent
        // instructions, inlined skill files, injected corrections. Read-only and
        // reconstructed from what the run already persisted. Named
        // `context-stack` because `/sessions/:id/context` is the SPA page that
        // renders it.
        const sessionContextMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/context-stack$/) : null;
        if (sessionContextMatch) {
          const sessionId = decodeURIComponent(sessionContextMatch[1]);
          const token = requestUrl.searchParams.get('token') ?? undefined;
          const projectId = requestUrl.searchParams.get('project') ?? undefined;
          if (!sessionAuthorized(sessionId, token)) {
            sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
            return;
          }
          const selection = selectSessionProjects(projects, projectId);
          if (!selection.success) {
            sendError(res, selection.status, selection.code, selection.message);
            return;
          }
          let contextResult: SessionContextPayload | undefined;
          let contextError: { status: number; code: string; message: string } | undefined;
          for (const project of selection.projects) {
            const projectWorker = workers.get(project.id);
            if (!projectWorker) {
              contextError ??= { status: 500, code: "WORKER_UNAVAILABLE", message: `No worker for project ${project.id}` };
              continue;
            }
            const info = await projectWorker.getSessionContext({ projectRoot: project.root, sessionId });
            if (info.success) {
              contextResult = info.context;
              break;
            }
            if (info.error.code !== 'SESSION_NOT_FOUND') {
              contextError ??= {
                status: info.error.code === 'SESSION_CORRUPTED' ? 422 : 500,
                code: info.error.code,
                message: info.error.message,
              };
            }
          }
          if (!contextResult) {
            const fallback = contextError ?? { status: 404, code: "SESSION_NOT_FOUND", message: `Session not found: ${sessionId}` };
            sendError(res, fallback.status, fallback.code, fallback.message);
            return;
          }
          sendJSON(res, 200, { success: true, context: contextResult });
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
          await serveSessionArtifact(res, found.project.root, sessionArtifactMatch[2], requestUrl.searchParams.get('theme') ?? undefined, {
            sessionId,
            snapHash: requestUrl.searchParams.get('snap') ?? undefined,
            rangeHeader: typeof req.headers.range === 'string' ? req.headers.range : undefined,
          });
          return;
        }

        // GET /sessions/:id/tool-artifacts/*: serve a full tool-output artifact
        // persisted under session storage. Same session auth as the page; the
        // handler validates the path stays under the resolved storage root and
        // belongs to the requested session id.
        const sessionToolArtifactMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/tool-artifacts\/(.+)$/) : null;
        if (sessionToolArtifactMatch) {
          const sessionId = decodeURIComponent(sessionToolArtifactMatch[1]);
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
          await serveSessionToolOutputArtifact(res, found.project.root, sessionId, sessionToolArtifactMatch[2], requestUrl.searchParams.get('theme') ?? undefined);
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
            const choice = typeof body.choice === 'string' && body.choice.length > 0 ? body.choice : undefined;
            const remember = readRememberField(body);
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

            if (!sessionAuthorized(sessionId, token)) {
              sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
              return;
            }
            if (!status) {
              sendError(res, 400, "STATUS_REQUIRED", "Missing approval status");
              return;
            }
            if (remember && (status !== 'comment' || !comment)) {
              sendError(res, 400, "REMEMBER_REQUIRES_COMMENT", "Remembered learnings can only be saved with a non-empty comment decision");
              return;
            }

            const found = await findSessionInfo(sessionId, projectId);
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }
            const choiceError = validateDecisionChoice(found.info, status, choice);
            if (choiceError) {
              sendError(res, 400, choiceError.code, choiceError.message);
              return;
            }

            const project = found.project;
            const targetSessionId = approvalActionSessionId(found.info, sessionId);
            const activeKey = `${project.id}:${targetSessionId}`;
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

            const rememberTarget = await resolveRememberedLearning(info, remember, targetSessionId);
            startApprovalResume(res, { project, sessionId, info, resumeToken, status, comment, choice });
            persistRememberedLearning(rememberTarget);
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
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
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // Learnings for a session's agent. Reading and editing follow the same
        // trust boundary as the session log (local, session token, or API key);
        // adding a manual rule is the reviewer's explicit opt-in.
        const resolveSessionLearningStore = async (
          info: WorkerApprovalInfoResult,
        ): Promise<{ store: LearningStore; config: LearningConfig | undefined; filePath: string } | null> => {
          const targetAgent = sessionLearningTargetAgent(info.approval);
          if (!targetAgent.filePath) return null;
          const agent = await parseAgent(targetAgent.filePath);
          // Same agent-file-derived state root the agent-level endpoints use, so
          // the session view and the agent view address one corrections file.
          const stateRoot = resolveProjectContext(dirname(targetAgent.filePath), {
            agentFilePath: targetAgent.filePath,
          }).stateRoot;
          return {
            store: LearningStore.fromAgentFile(targetAgent.filePath, stateRoot, agent.name),
            config: agent.config.learning,
            filePath: targetAgent.filePath,
          };
        };

        /**
         * Where a tidy-up for this store would run, for the session views.
         *
         * Derived from the file the store was resolved from, never from
         * `approval.agent.runPath`: on a sub-agent session those are different
         * agents, and a button built from the session's own agent would tidy a
         * file other than the one whose rules are on screen. Undefined when the
         * file is not one of the project's loaded agents, which is the same
         * condition under which the agent hub does not exist to run it.
         */
        const sessionTidyTarget = (
          project: Project,
          filePath: string,
        ): { project: string; runPath: string } | undefined => {
          const runPath = toAgentRunPath(project, filePath);
          return runPath ? { project: project.id, runPath } : undefined;
        };
        // `forSessionId` narrows the list to learnings captured in that session
        // (the session page shows only what the run produced); omit it for the
        // agent-level view of the full store.
        //
        // The payload carries each rule's STATUS, not just its text. Without it
        // the panel cannot tell a reviewer that the correction they just left is
        // one of the ones past the cap, which is the exact misunderstanding this
        // whole surface exists to end.
        const learningListPayload = async (
          store: LearningStore,
          opts: {
            forSessionId?: string;
            config?: LearningConfig | undefined;
            /** Both required to report the last tidy-up. */
            stateRoot?: string;
            agentFilePath?: string;
            /** Where a tidy-up would run. The panel offers the button only when
             *  the server names a target, so the two surfaces cannot disagree
             *  about which file a press would rewrite. */
            tidyTarget?: { project: string; runPath: string } | undefined;
          } = {},
        ) => {
          const all = await store.load();
          const cap = effectiveCap(opts.config);
          const { injected, dormant } = partitionLearnings(all, cap);
          const injectedIds = new Set(injected.map((l) => l.id));
          // A tidy-up rewrote two files; the offer to undo it has to be
          // reachable from the page the user comes back to, not only from the
          // tab that ran it.
          const record = opts.stateRoot && opts.agentFilePath
            ? await readTidyRecord(opts.stateRoot, opts.agentFilePath)
            : null;
          // A pass takes minutes, longer than anyone waits on one page. Say it
          // is running, or coming back here reads as "nothing happened".
          const inFlight = opts.agentFilePath ? runningTidyJobForFile(opts.agentFilePath) : undefined;
          // Learnings left at the pre-0.17 location beside the agent file. The
          // terminal warns about these and `doctor` reports them; a reviewer who
          // only ever opens the web UI would otherwise see an ordinary-looking
          // panel and never learn that forty rules are sitting one directory
          // away, unread. The path only — the sentence is the panel's to write.
          const strandedAt = opts.stateRoot && opts.agentFilePath
            ? strandedLearningsFile(opts.agentFilePath, opts.stateRoot)
            : null;
          return {
            success: true,
            ...(opts.tidyTarget ? { tidyTarget: opts.tidyTarget } : {}),
            ...(strandedAt ? { strandedAt } : {}),
            ...(inFlight ? { runningTidy: { jobId: inFlight.id } } : {}),
            ...(record ? { lastTidy: { jobId: record.jobId, finishedAt: record.finishedAt } } : {}),
            summary: {
              cap,
              active: injected.length + dormant.length,
              injected: injected.length,
              dormant: dormant.length,
              graduated: all.filter((l) => l.state === 'graduated').length,
              retired: all.filter((l) => l.state === 'retired').length,
              quarantined: all.filter((l) => l.state === 'quarantined').length,
              // Per-channel store counts (retired excluded), so "capture is
              // producing junk" is measurable from the panel, not anecdotal.
              byChannel: all.reduce<Record<string, number>>((acc, l) => {
                if (l.state === 'retired') return acc;
                const channel = l.channel ?? 'legacy';
                acc[channel] = (acc[channel] ?? 0) + 1;
                return acc;
              }, {}),
            },
            learnings: all
              .filter((l) => opts.forSessionId === undefined || l.sessionId === opts.forSessionId)
              .map((l) => ({
                id: l.id,
                category: l.category,
                title: l.title,
                instruction: l.instruction,
                confidence: l.confidence,
                source: l.source,
                extractedAt: l.extractedAt,
                ...(l.sessionId && { sessionId: l.sessionId }),
                state: l.state ?? 'active',
                injectedCount: l.injectedCount,
                ...(l.channel && { channel: l.channel }),
                ...(l.quarantineReason && { quarantineReason: l.quarantineReason }),
                reasserted: l.reasserted,
                approvedRuns: l.approvedRuns,
                injected: injectedIds.has(l.id),
              })),
          };
        };

        /**
         * The session-scoped list: this run's captures, plus the whole-store
         * counts and the offer to tidy it.
         *
         * The list is narrowed to the session but the tidy-up is not, and that
         * is deliberate. The reviewer who just left a correction is the person
         * who needs to know it will not reach the agent, and this is the page
         * they are on; sending them to find the agent hub to act on it is how
         * the warning went unread. The banner above the list already speaks
         * about the whole store, so the button belongs with it.
         */
        const sessionLearningPayload = (
          project: Project,
          resolved: NonNullable<Awaited<ReturnType<typeof resolveSessionLearningStore>>>,
          sessionId: string,
          allowTidy: boolean,
        ) =>
          learningListPayload(resolved.store, {
            forSessionId: sessionId,
            config: resolved.config,
            stateRoot: resolveProjectContext(dirname(resolved.filePath), { agentFilePath: resolved.filePath }).stateRoot,
            agentFilePath: resolved.filePath,
            ...(allowTidy ? { tidyTarget: sessionTidyTarget(project, resolved.filePath) } : {}),
          });

        // GET /sessions/:id/learnings: list the learnings captured in this session.
        const sessionLearningsMatch = (req.method === "GET" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/learnings$/) : null;
        if (sessionLearningsMatch) {
          try {
            const sessionId = decodeURIComponent(sessionLearningsMatch[1]);
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
            const resolved = await resolveSessionLearningStore(found.info);
            const allowTidy = sessionLearningTidyAllowed(req.headers.authorization, apiKey);
            sendJSON(res, 200, resolved
              ? await sessionLearningPayload(found.project, resolved, sessionId, allowTidy)
              : { success: true, learnings: [] });
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /sessions/:id/learnings: add a manual rule (standalone, no resume).
        const sessionAddLearningMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/learnings$/) : null;
        if (sessionAddLearningMatch) {
          try {
            const sessionId = decodeURIComponent(sessionAddLearningMatch[1]);
            const token = requestUrl.searchParams.get('token') ?? undefined;
            const body = await parseJSONBody(req);
            const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;
            if (!sessionAuthorized(sessionId, token)) {
              sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
              return;
            }
            if (!instruction) {
              sendError(res, 400, "INSTRUCTION_REQUIRED", "A rule to remember is required");
              return;
            }
            const found = await findSessionInfo(sessionId, projectId);
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }
            const targetAgent = found.info.approval.originAgent ?? found.info.approval.agent;
            if (!targetAgent.filePath) {
              sendError(res, 400, "NO_AGENT_FILE", "This session does not record an agent file path");
              return;
            }
            const agent = await parseAgent(targetAgent.filePath);
            const rememberStateRoot = resolveProjectContext(dirname(targetAgent.filePath), {
              agentFilePath: targetAgent.filePath,
            }).stateRoot;
            await saveManualLearning({ agentFilePath: targetAgent.filePath, stateRoot: rememberStateRoot, instruction, model: agent.config.model, agentInstructions: agent.instructions, sessionTranscript: buildRunTranscript(found.info.approval.logs), sessionId, cap: effectiveCap(agent.config.learning) });
            // Redraw through the same builder as the GET: a rule added by hand
            // can be the one that pushes the store past the cap, and a response
            // that dropped the tidy target would take the button away at the
            // moment it started to matter.
            const resolved = await resolveSessionLearningStore(found.info);
            const allowTidy = sessionLearningTidyAllowed(req.headers.authorization, apiKey);
            sendJSON(res, 200, resolved
              ? await sessionLearningPayload(found.project, resolved, sessionId, allowTidy)
              : { success: true, learnings: [] });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /sessions/:id/learnings/:lid/discard: drop a stored learning.
        const sessionDiscardLearningMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/learnings\/([^/?#]+)\/discard$/) : null;
        if (sessionDiscardLearningMatch) {
          try {
            const sessionId = decodeURIComponent(sessionDiscardLearningMatch[1]);
            const learningId = decodeURIComponent(sessionDiscardLearningMatch[2]);
            const token = requestUrl.searchParams.get('token') ?? undefined;
            const body = await parseJSONBody(req);
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;
            if (!sessionAuthorized(sessionId, token)) {
              sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
              return;
            }
            const found = await findSessionInfo(sessionId, projectId);
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }
            const resolved = await resolveSessionLearningStore(found.info);
            if (resolved) await resolved.store.remove(learningId);
            const allowTidy = sessionLearningTidyAllowed(req.headers.authorization, apiKey);
            sendJSON(res, 200, resolved
              ? await sessionLearningPayload(found.project, resolved, sessionId, allowTidy)
              : { success: true, learnings: [] });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // Agent-level learnings: the full store for one agent, unfiltered (the
        // session endpoints above show only a single session's captures). Same
        // operator-surface gate and path validation as /agents/detail.
        const resolveAgentLearningTarget = async (
          res: ServerResponse,
          requestedProject: string | undefined,
          requestedPath: string | undefined,
        ): Promise<{ store: LearningStore; agent: Awaited<ReturnType<typeof parseAgent>>; absPath: string; stateRoot: string; tidyTarget: { project: string; runPath: string } } | null> => {
          if (!requestedProject || !requestedPath) {
            sendError(res, 400, "MISSING_PARAMS", "Both project and path are required");
            return null;
          }
          const project = projects.find((p) => p.id === requestedProject);
          if (!project) {
            sendError(res, 404, "PROJECT_NOT_FOUND", `Project not found: ${requestedProject}`);
            return null;
          }
          if (!project.agentFiles.includes(requestedPath)) {
            sendError(res, 404, "AGENT_NOT_FOUND", `Agent not loaded: ${requestedPath}`);
            return null;
          }
          const absPath = resolveScopedAgentPath(project, requestedPath);
          const agent = await parseAgent(absPath);
          const stateRoot = resolveProjectContext(dirname(absPath), { agentFilePath: absPath }).stateRoot;
          return {
            store: LearningStore.fromAgentFile(absPath, stateRoot, agent.name),
            agent,
            absPath,
            stateRoot,
            tidyTarget: { project: project.id, runPath: requestedPath },
          };
        };

        /** The agent-scoped list, always carrying the last tidy-up so every
         *  response that redraws the panel keeps the offer to undo it. */
        const agentLearningPayload = (target: NonNullable<Awaited<ReturnType<typeof resolveAgentLearningTarget>>>) =>
          learningListPayload(target.store, {
            config: target.agent.config.learning,
            stateRoot: target.stateRoot,
            agentFilePath: target.absPath,
            tidyTarget: target.tidyTarget,
          });

        // GET /agents/learnings?project=<id>&path=<runPath>: list all stored learnings.
        if (req.method === "GET" && routePath === '/agents/learnings') {
          try {
            const target = await resolveAgentLearningTarget(
              res,
              requestUrl.searchParams.get('project') ?? undefined,
              requestUrl.searchParams.get('path') ?? undefined,
            );
            if (!target) return;
            sendJSON(res, 200, await agentLearningPayload(target));
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /agents/learnings: add a manual rule for the agent (no session context).
        if (req.method === "POST" && routePath === '/agents/learnings') {
          try {
            const body = await parseJSONBody(req);
            const instruction = typeof body.instruction === 'string' ? body.instruction.trim() : '';
            if (!instruction) {
              sendError(res, 400, "INSTRUCTION_REQUIRED", "A rule to remember is required");
              return;
            }
            const target = await resolveAgentLearningTarget(
              res,
              typeof body.project === 'string' ? body.project : undefined,
              typeof body.path === 'string' ? body.path : undefined,
            );
            if (!target) return;
            await saveManualLearning({
              agentFilePath: target.absPath,
              stateRoot: target.stateRoot,
              instruction,
              model: target.agent.config.model,
              agentInstructions: target.agent.instructions,
              cap: effectiveCap(target.agent.config.learning),
            });
            sendJSON(res, 200, await agentLearningPayload(target));
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /agents/learnings/discard: drop a stored learning by id.
        if (req.method === "POST" && routePath === '/agents/learnings/discard') {
          try {
            const body = await parseJSONBody(req);
            const learningId = typeof body.id === 'string' ? body.id : '';
            if (!learningId) {
              sendError(res, 400, "ID_REQUIRED", "A learning id is required");
              return;
            }
            const target = await resolveAgentLearningTarget(
              res,
              typeof body.project === 'string' ? body.project : undefined,
              typeof body.path === 'string' ? body.path : undefined,
            );
            if (!target) return;
            await target.store.remove(learningId);
            sendJSON(res, 200, await agentLearningPayload(target));
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /agents/learnings/tidy: merge, sharpen, retire and make permanent,
        // until every stored correction reaches the agent. `dryRun` returns the
        // plan and both diffs without writing.
        //
        // Deliberately the same core call as `agentuse learnings tidy`: the
        // reviewer who lives in this UI and the operator who lives in the
        // terminal must not get different results from the same button.
        if (req.method === "POST" && routePath === '/agents/learnings/tidy') {
          try {
            const body = await parseJSONBody(req);
            const projectId = typeof body.project === 'string' ? body.project : undefined;
            const runPath = typeof body.path === 'string' ? body.path : undefined;
            const target = await resolveAgentLearningTarget(res, projectId, runPath);
            if (!target) return;

            // A second press while one is running joins the first. Two passes
            // over the same two files would race each other's writes, and the
            // loser's undo snapshot would restore the winner's output.
            const existing = runningTidyJob(projectId!, runPath!);
            if (existing) {
              sendJSON(res, 200, { success: true, job: tidyJobView(existing) });
              return;
            }

            pruneTidyJobs();
            const job: TidyJob = {
              id: ulid(),
              project: projectId!,
              path: runPath!,
              agentFilePath: target.absPath,
              stateRoot: target.stateRoot,
              startedAt: Date.now(),
              status: 'running',
              phase: 'deciding',
              step: 0,
              total: 0,
              round: 1,
              maxRounds: 1,
              projectedActive: 0,
              cap: effectiveCap(target.agent.config.learning),
              dryRun: body.dryRun === true,
            };
            tidyJobs.set(job.id, job);

            // Deliberately not awaited: the response carries the job id so the
            // page can start showing progress immediately.
            void consolidateLearnings({
              agentFilePath: target.absPath,
              agentInstructions: target.agent.instructions,
              agentModel: target.agent.config.model,
              config: target.agent.config.learning,
              stateRoot: target.stateRoot,
              onProgress: (progress) => {
                job.phase = progress.phase;
                job.step = progress.step;
                job.total = progress.total;
                job.round = progress.round;
                job.maxRounds = progress.maxRounds;
                job.projectedActive = progress.projectedActive;
                job.cap = progress.cap;
              },
              ...(job.dryRun ? { dryRun: true } : {}),
            }).then(async (result) => {
              job.result = result;
              job.status = 'done';
              job.phase = 'done';
              job.finishedAt = Date.now();
              // Only a real, applied pass is worth remembering: a dry run
              // changed nothing, so there is nothing to undo.
              if (!job.dryRun && result.undoId) {
                await writeTidyRecord(target.stateRoot, target.absPath, {
                  jobId: job.id,
                  agentFilePath: target.absPath,
                  startedAt: job.startedAt,
                  finishedAt: job.finishedAt,
                  result,
                }).catch(() => {});
              }
            }).catch((err: unknown) => {
              job.status = 'error';
              job.finishedAt = Date.now();
              job.error = (err as Error).message;
            });

            sendJSON(res, 202, { success: true, job: tidyJobView(job) });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // GET /agents/learnings/tidy?project=&path=&job=: how the tidy-up is
        // going, and its result once it lands. Without `job` it answers with the
        // last tidy-up this agent had, read from disk — that is what makes Undo
        // reachable after the tab that started it is gone.
        if (req.method === "GET" && routePath === '/agents/learnings/tidy') {
          try {
            const projectId = requestUrl.searchParams.get('project') ?? undefined;
            const runPath = requestUrl.searchParams.get('path') ?? undefined;
            const target = await resolveAgentLearningTarget(res, projectId, runPath);
            if (!target) return;
            const jobId = requestUrl.searchParams.get('job') ?? undefined;
            const job = jobId ? tidyJobs.get(jobId) : runningTidyJob(projectId!, runPath!);
            const record = await readTidyRecord(target.stateRoot, target.absPath);

            // In-memory job first (it is the only thing that knows about a run
            // still in flight), then the record on disk, which is what survives
            // a daemon restart. Asking for a specific job only ever gets that
            // job's result: the record is the LAST tidy-up, and answering a
            // stale job id with it would show the user a result they did not
            // ask for next to an Undo button that rolls back something else.
            const recordForRequest = record && (jobId === undefined || record.jobId === jobId) ? record : null;
            const result = job?.result ?? (job === undefined ? recordForRequest?.result : undefined);
            sendJSON(res, 200, {
              ...(await agentLearningPayload(target)),
              ...(job ? { job: tidyJobView(job) } : {}),
              ...(result ? { tidy: result } : {}),
            });
          } catch (err) {
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /agents/learnings/undo: restore both files to their state before
        // the last tidy-up. Half the change lands in the agent file, so an undo
        // that only rolled back the store would leave it quietly rewritten.
        if (req.method === "POST" && routePath === '/agents/learnings/undo') {
          try {
            const body = await parseJSONBody(req);
            const target = await resolveAgentLearningTarget(
              res,
              typeof body.project === 'string' ? body.project : undefined,
              typeof body.path === 'string' ? body.path : undefined,
            );
            if (!target) return;
            const restored = await undoConsolidation(target.stateRoot, target.absPath);
            if (restored) {
              await clearTidyRecord(target.stateRoot, target.absPath);
              for (const job of tidyJobs.values()) {
                if (job.status === 'done' && job.agentFilePath === target.absPath) job.status = 'undone';
              }
            }
            sendJSON(res, 200, {
              ...(await agentLearningPayload(target)),
              undone: Boolean(restored),
              restored: restored?.restored ?? [],
            });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /sessions/:id/stop: end a session and its subagent children.
        // When the session (or the leaf of its delegation cascade) is suspended
        // on a pending approval gate, a plain stop would orphan the gate: the
        // agent never resumes, so any state it manages (store items, drafts)
        // stays "awaiting approval" forever. Instead the stop is delivered as a
        // REJECT decision through the normal approval-resume path, letting the
        // agent record the rejection and end cleanly. If that resume fails, the
        // tree is hard-stopped as a fallback. Pass { force: true } to skip the
        // reject and hard-stop immediately. Authorized the same way as the
        // session page: local, session token, or API key.
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
            const force = body.force === true;

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

            const info = found.info;
            const targetSessionId = approvalActionSessionId(info, sessionId);
            const gateKey = `${project.id}:${targetSessionId}`;
            const gateResumeToken = info.approval.currentResumeToken;
            // currentResumeToken is only surfaced for an actionable await_human
            // gate (own or cascade leaf), so its presence identifies a
            // rejectable approval rather than a generic await_* suspension.
            const rejectableGate = !force
              && info.approval.sessionStatus === 'suspended'
              && typeof gateResumeToken === 'string'
              && (info.approval.expiresAt === undefined || info.approval.expiresAt > Date.now())
              && !activeApprovalResumes.has(gateKey)
              && !activeSessionContinuations.has(gateKey);

            if (rejectableGate) {
              const hardStop = (): void => {
                void projectWorker.stopSession({ projectRoot: project.root, sessionId, reason, dismissEnded: true })
                  .then(() => wakeListHubs())
                  .catch((err) => logger.warn(`Fallback stop after failed reject-resume of ${sessionId} failed: ${(err as Error).message}`));
              };
              startApprovalResume(res, {
                project,
                sessionId,
                info,
                resumeToken: gateResumeToken,
                status: 'reject',
                comment: reason ?? 'Discarded: session stopped by the reviewer',
                responseExtra: { rejected: true },
                onResumeFailure: hardStop,
              });
              return;
            }

            const activeKey = `${project.id}:${sessionId}`;
            activeApprovalResumes.delete(activeKey);
            activeSessionContinuations.delete(activeKey);

            // This route is always human-initiated (web Discard / CLI stop), so
            // an already-ended failed session gets dismissed instead of no-op'd.
            const result = await projectWorker.stopSession({
              projectRoot: project.root,
              sessionId,
              reason,
              dismissEnded: true,
            });
            if (!result.success) {
              sendError(res, 500, result.error.code, result.error.message);
              return;
            }
            wakeListHubs();
            sendJSON(res, 200, { success: true, sessionId, stopped: result.stopped });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /sessions/:id/started: the runner's best-effort poke that a run
        // just began (see runner/announce.ts). Runs the daemon launches itself
        // invalidate their caches inline; this is how a plain `agentuse run` in
        // another process gets the same treatment, so its session shows up live
        // instead of waiting out a cached list. No push — starting isn't news.
        const sessionStartedMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/started$/) : null;
        if (sessionStartedMatch) {
          try {
            const sessionId = decodeURIComponent(sessionStartedMatch[1]);
            const body = await parseJSONBody(req);
            const token = typeof body.token === 'string' ? body.token : requestUrl.searchParams.get('token') ?? undefined;
            const projectId = typeof body.project === 'string' ? body.project : undefined;

            if (!sessionAuthorized(sessionId, token)) {
              sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
              return;
            }

            const found = await findSessionStatusInfo(sessionId, projectId);
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }

            await refreshProjectLists(found.project, { externalActivity: true });
            sendJSON(res, 200, { success: true, status: "refreshed" });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 500, "INTERNAL_ERROR", (err as Error).message);
          }
          return;
        }

        // POST /sessions/:id/finished: the runner's best-effort poke that a run
        // reached a terminal state (see runner/announce.ts), fanned out as a Web
        // Push to devices subscribed to the sessions category. The reported
        // status is never trusted — it is re-read from storage — and the poke
        // carries the session view token, validated like every session action.
        const sessionFinishedMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/finished$/) : null;
        if (sessionFinishedMatch) {
          try {
            const sessionId = decodeURIComponent(sessionFinishedMatch[1]);
            const body = await parseJSONBody(req);
            const token = typeof body.token === 'string' ? body.token : requestUrl.searchParams.get('token') ?? undefined;
            const projectId = typeof body.project === 'string' ? body.project : undefined;

            if (!sessionAuthorized(sessionId, token)) {
              sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
              return;
            }

            const found = await findSessionStatusInfo(sessionId, projectId);
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }

            const status = found.session.sessionStatus;
            // Regardless of push dedup below, a terminal-state poke means the
            // session lists just changed; refresh dashboards promptly. Waking
            // the hubs without dropping the worker's cache would re-serve the
            // stale "still running" list, so go through refreshProjectLists.
            await refreshProjectLists(found.project);
            if (status !== 'completed' && status !== 'error') {
              sendJSON(res, 200, { success: true, status: "ignored", reason: `session is ${status}` });
              return;
            }
            // Mock/test runs never push: a test loop would otherwise buzz the
            // phone once per iteration. The list refresh above still happened,
            // so dashboards stay current.
            if (found.session.mock) {
              sendJSON(res, 200, { success: true, status: "ignored", reason: "mock session" });
              return;
            }
            if (notifiedFinishedSessions.has(sessionId)) {
              sendJSON(res, 200, { success: true, status: "already-notified" });
              return;
            }
            notifiedFinishedSessions.set(sessionId, Date.now());
            // Bound the dedup map. First drop entries older than a day (can't
            // recur anyway); if >1000 sessions finished within the window that
            // frees nothing, so also hard-cap by evicting oldest-first (Map
            // preserves insertion order, which is time order here).
            if (notifiedFinishedSessions.size > 1000) {
              const cutoff = Date.now() - 24 * 3600 * 1000;
              for (const [key, at] of notifiedFinishedSessions) {
                if (at < cutoff) notifiedFinishedSessions.delete(key);
              }
              while (notifiedFinishedSessions.size > 1000) {
                const oldest = notifiedFinishedSessions.keys().next().value;
                if (oldest === undefined) break;
                notifiedFinishedSessions.delete(oldest);
              }
            }

            const agentName = found.session.agent.name;
            const sessionQuery = new URLSearchParams();
            if (token) sessionQuery.set('token', token);
            sessionQuery.set('project', found.project.id);
            void deliverNotification('sessions', {
              title: status === 'completed' ? "Session completed" : "Session failed",
              body: multiProject ? `${found.project.id}/${agentName}` : agentName,
              url: `${effectivePublicUrl}/sessions/${encodeURIComponent(sessionId)}?${sessionQuery.toString()}`,
              tag: `session-${sessionId}`,
            });
            sendJSON(res, 200, { success: true, status: "notified" });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        // POST /sessions/:id/reopen: roll an ended (error/completed) session back
        // to its suspended approval gate so the reviewer can retry a resume that
        // failed downstream. User-initiated only; the normal approval/decision
        // flow takes over once it is suspended again.
        const sessionReopenMatch = (req.method === "POST" && !isApi) ? routePath.match(/^\/sessions\/([^/?#]+)\/reopen$/) : null;
        if (sessionReopenMatch) {
          try {
            const sessionId = decodeURIComponent(sessionReopenMatch[1]);
            const token = requestUrl.searchParams.get('token') ?? undefined;
            const body = await parseJSONBody(req);
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

            if (!sessionAuthorized(sessionId, token)) {
              sendError(res, 401, "UNAUTHORIZED", "Not authorized for this session");
              return;
            }

            const found = await findSessionInfo(sessionId, projectId);
            if (!found.success) {
              sendError(res, found.status, found.code, found.message);
              return;
            }

            const sessionStatus = found.info.approval.sessionStatus;
            if (sessionStatus === 'suspended') {
              sendError(res, 409, "SESSION_SUSPENDED", "Session is already suspended");
              return;
            }
            if (sessionStatus === 'running') {
              sendError(res, 409, "SESSION_RUNNING", `Session ${sessionId} is still running`);
              return;
            }
            if (!isEndedSessionStatus(sessionStatus)) {
              sendError(res, 409, "SESSION_NOT_ENDED", `Session is ${sessionStatus}`);
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

            const result = await projectWorker.reopenGate({ projectRoot: project.root, sessionId });
            if (!result.success) {
              const code = result.error.code;
              const httpStatus = code === 'NO_REOPENABLE_GATE' ? 409
                : code === 'SESSION_NOT_FOUND' ? 404
                : 400;
              sendError(res, httpStatus, code, result.error.message);
              return;
            }
            wakeListHubs();
            sendJSON(res, 200, { success: true, sessionId, status: "suspended" });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        if (req.method === "GET" && isApi && routePath === '/notifications/events') {
          if (!notificationHub.subscribe({ req, res })) {
            sendError(res, 503, "TOO_MANY_SUBSCRIBERS", "Too many native notification connections");
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
            requestUrl.searchParams.get('project') ?? '',
            requestUrl.searchParams.get('view') ?? ''
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

            // A new pending approval changes both lists (session suspended +
            // approvals bucket); surface it on dashboards without the 10s wait.
            wakeListHubs();

            const logKey = `${found.project.id}:${sessionId}:${token}`;
            if (shouldLogApprovalRequest(loggedApprovalRequests, logKey)) {
              const filePath = found.info.approval.agent.filePath;
              const agentLabel = filePath
                ? relative(found.project.root, filePath)
                : found.info.approval.agent.name;
              approvalLog.sent(
                multiProject ? `${found.project.id}/${agentLabel}` : agentLabel,
                found.info.approval.approvalUrl ?? approvalUrl,
                sessionId
              );
              // Same dedup guard as the log line: one push per unique approval.
              const label = multiProject ? `${found.project.id}/${agentLabel}` : agentLabel;
              const prompt = found.info.approval.prompt;
              // The first change is the verbatim payload under review; showing it in
              // the push lets the reviewer judge without opening the page.
              const firstChange = found.info.approval.changes?.[0]?.content;
              // A delegated child's page is view-only; the decision lives on the
              // cascade root's page, so deep-link the push there.
              const pushSessionId = approvalActionSessionId(found.info, sessionId);
              const approvalQuery = new URLSearchParams();
              const viewToken = sessionViewToken(pushSessionId, apiKey);
              if (viewToken) approvalQuery.set('token', viewToken);
              approvalQuery.set('project', found.project.id);
              // Badge the home-screen icon with the total pending count.
              // Counted out-of-band so the runner's callback isn't delayed.
              // Floor of 1: this push IS a pending approval, so even when the
              // list query races the announcement (or fails), the badge must
              // never be omitted or zero.
              void (async () => {
                let pendingCount = 0;
                try {
                  const list = await buildApprovalListPayload(new URL(`${serverUrl}/api/approvals`));
                  if (list.success) pendingCount = list.payload.buckets.pending.length;
                } catch {
                  // Badge is decoration; never block the notification on it.
                }
                // Approve/Reject buttons on the notification itself, where the
                // platform renders them (Chrome/Android/desktop; iOS shows a
                // plain tap-through). Only when the decision belongs to the
                // pushed session: a delegated child's gate is decided on the
                // cascade root, whose resume token this request doesn't carry.
                // Gates that offer options can't be one-tap approved (approve
                // requires a choice), so those always tap through to the page.
                const hasOptions = (found.info.approval.options?.length ?? 0) > 0;
                const decidableInline = pushSessionId === sessionId && !hasOptions;
                await deliverNotification('approvals', {
                  title: "Approval needed",
                  body: [
                    prompt ? `${label}: ${prompt.slice(0, 140)}` : label,
                    ...(firstChange ? [firstChange.slice(0, 160)] : []),
                  ].join('\n'),
                  url: `${effectivePublicUrl}/sessions/${encodeURIComponent(pushSessionId)}?${approvalQuery.toString()}`,
                  tag: `approval-${pushSessionId}`,
                  appBadge: Math.max(1, pendingCount),
                  ...(decidableInline && {
                    actions: [
                      { action: 'approve', title: 'Approve' },
                      { action: 'reject', title: 'Reject' },
                    ],
                    decision: {
                      sessionId: pushSessionId,
                      resumeToken: token,
                      project: found.project.id,
                      ...(viewToken && { token: viewToken }),
                    },
                  }),
                });
              })();
            }

            sendJSON(res, 200, { success: true, status: "logged", sessionId });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
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
          // Same single-copy rule as /sessions/:id/status: logs travel top level.
          const approval = { ...found.info.approval };
          delete approval.logs;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({
            success: true,
            sessionId,
            status,
            approval: applyResumeError(approval, activeKey),
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
            const choice = typeof body.choice === 'string' && body.choice.length > 0 ? body.choice : undefined;
            const remember = readRememberField(body);
            const projectId = typeof body.project === 'string' ? body.project : requestUrl.searchParams.get('project') ?? undefined;

            if (!token) {
              sendError(res, 401, "RESUME_TOKEN_REQUIRED", "Missing approval token");
              return;
            }
            if (!status) {
              sendError(res, 400, "STATUS_REQUIRED", "Missing approval status");
              return;
            }
            if (remember && (status !== 'comment' || !comment)) {
              sendError(res, 400, "REMEMBER_REQUIRES_COMMENT", "Remembered learnings can only be saved with a non-empty comment decision");
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
            const choiceError = validateDecisionChoice(found.info, status, choice);
            if (choiceError) {
              sendError(res, 400, choiceError.code, choiceError.message);
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

            const rememberTarget = await resolveRememberedLearning(info, remember, approvalActionSessionId(info, sessionId));
            startApprovalResume(res, { project, sessionId, info, resumeToken: token, status, comment, choice });
            persistRememberedLearning(rememberTarget);
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
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
            if (sendRequestParseError(res, err)) return;
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
              wakeListHubs();
            });

            wakeListHubs();
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ sessionId, status: "running" }));
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            sendError(res, 400, "INVALID_REQUEST", (err as Error).message);
          }
          return;
        }

        if (req.method === "POST" && routePath === "/projects") {
          if (projects.length > 0 || projectCreationInFlight) {
            sendError(res, 409, "PROJECT_ALREADY_CONFIGURED", "A project is already configured for this server");
            return;
          }
          projectCreationInFlight = true;
          try {
            const body = await parseJSONBody(req);
            // Runtime attachment is staged before config registration. A failed
            // worker or watcher startup therefore leaves neither a phantom
            // config entry nor a directory that blocks retry.
            const { managed, value: project } = await createManagedProjectTransaction(
              body.name,
              async (staged) => {
                const attached = await attachManagedProject(staged.id, staged.root);
                return { value: attached.project, rollback: attached.rollback };
              },
            );

            sendJSON(res, 201, {
              success: true,
              project: {
                id: project.id,
                path: project.root,
                agentCount: 0,
                scheduleCount: 0,
                about: { name: managed.name, description: 'Your AgentUse agents' },
              },
            });
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
            if (err instanceof ManagedProjectError && err.code === 'PROJECT_EXISTS') {
              sendError(res, 409, err.code, err.message);
            } else {
              sendError(res, err instanceof ManagedProjectError ? 500 : 400, "INVALID_PROJECT", (err as Error).message);
            }
          } finally {
            projectCreationInFlight = false;
          }
          return;
        }

        if (req.method === "POST" && routePath === "/onboarding/run") {
          try {
            const rawBody = await parseJSONBody(req);
            const projectId = typeof rawBody.project === 'string' ? rawBody.project : undefined;
            const resolved = resolveRequestProject({
              agent: ONBOARDING_AGENT_ID,
              ...(projectId && { project: projectId }),
            });
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
            if ((agentCounts.get(project.id) ?? 0) > 0) {
              sendError(res, 409, "ONBOARDING_NOT_AVAILABLE", "The sample run is available only while this project has no agents");
              return;
            }

            const onboardingWorker = workers.get(project.id);
            if (!onboardingWorker) {
              sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
              return;
            }

            const preassignedId = ulid();
            void onboardingWorker.execute({
              agentContent: ONBOARDING_AGENT_SOURCE,
              agentName: ONBOARDING_AGENT_ID,
              projectRoot: project.root,
              timeout: 60,
              maxSteps: 1,
              debug: options.debug,
              newSessionId: preassignedId,
              trigger: 'onboarding',
            }).then((result) => {
              if (!result.success) {
                logger.warn(`Onboarding run ${preassignedId} failed: ${result.error.message}`);
              }
            }).catch((err) => {
              logger.warn(`Onboarding run ${preassignedId} errored: ${(err as Error).message}`);
            }).finally(wakeListHubs);

            wakeListHubs();
            const sessionToken = apiKey ? sessionViewToken(preassignedId, apiKey) : undefined;
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              success: true,
              sessionId: preassignedId,
              status: "running",
              ...(sessionToken && { token: sessionToken }),
            }));
          } catch (err) {
            if (sendRequestParseError(res, err)) return;
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
          const reportedSurface = reportedSurfaceForRun(
            body,
            webUIClientSurface(req.headers['x-agentuse-client']),
          );
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

          // Detached mode: pre-assign the session id, kick the run off in the
          // background, and return the id immediately so the caller (the web
          // "Run" button) can navigate straight to the live session view.
          // Deliberately NOT wired to req close: we 202 right away, which closes
          // the request, and that must not abort the run.
          if (body.detach) {
            const detachWorker = workers.get(project.id);
            if (!detachWorker) {
              sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
              return;
            }
            const preassignedId = ulid();
            const detachTimeout = body.timeout ?? agent.config.timeout ?? 300;
            void detachWorker.execute({
              agentPath: toProjectRelativeAgentPath(project, body.agent),
              projectRoot: project.root,
              prompt: body.prompt,
              model: body.model,
              timeout: detachTimeout,
              maxSteps: body.maxSteps,
              debug: options.debug,
              newSessionId: preassignedId,
              trigger: 'api',
            }).then((result) => {
              const duration = Date.now() - startTime;
              totalExecutions++;
              if (result.success) {
                successfulExecutions++;
                if (result.result.finishReason !== 'suspended') {
                  executionLog.complete(body.agent, Date.now() - startTime);
                }
              } else {
                failedExecutions++;
                logger.warn(`Detached run ${preassignedId} failed: ${result.error.message}`);
              }
              telemetry.captureExecution({
                ...parseModel(body.model || agent.config.model),
                durationMs: duration,
                inputTokens: result.success ? result.result.tokens?.input ?? 0 : 0,
                outputTokens: result.success ? result.result.tokens?.output ?? 0 : 0,
                success: result.success,
                classification: classifyExecution({
                  agentSource: 'local',
                  trigger: 'api',
                  isMock: false,
                }),
                executionOrigin: 'serve',
                reportedSurface,
                toolCalls: result.telemetry?.toolCalls ?? emptyToolCallMetrics(),
                ...(result.telemetry && { steps: result.telemetry.steps }),
                ...(!result.success && {
                  errorType: result.error.code === 'TIMEOUT'
                    ? 'timeout' as const
                    : result.error.code === 'INCOMPLETE'
                      ? 'incomplete' as const
                      : 'unknown' as const,
                }),
                features: configuredFeatureUsage(agent.config, 'webhook'),
                config: {
                  timeoutCustom: body.timeout !== undefined || agent.config.timeout !== undefined,
                  maxStepsCustom: body.maxSteps !== undefined || agent.config.maxSteps !== undefined,
                  quietMode: true,
                  debugMode: options.debug ?? false,
                },
              });
            }).catch((err) => {
              totalExecutions++;
              failedExecutions++;
              logger.warn(`Detached run ${preassignedId} errored: ${(err as Error).message}`);
              telemetry.captureExecution({
                ...parseModel(body.model || agent.config.model),
                durationMs: Date.now() - startTime,
                inputTokens: 0,
                outputTokens: 0,
                success: false,
                errorType: 'unknown',
                classification: classifyExecution({
                  agentSource: 'local',
                  trigger: 'api',
                  isMock: false,
                }),
                executionOrigin: 'serve',
                reportedSurface,
                toolCalls: emptyToolCallMetrics(),
                features: configuredFeatureUsage(agent.config, 'webhook'),
              });
            }).finally(wakeListHubs);

            wakeListHubs();
            const sessionToken = apiKey ? sessionViewToken(preassignedId, apiKey) : undefined;
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({
              success: true,
              sessionId: preassignedId,
              status: "running",
              ...(sessionToken && { token: sessionToken }),
            }));
            return;
          }

          const projectWorker = workers.get(project.id);
          if (!projectWorker) {
            sendError(res, 500, "WORKER_UNAVAILABLE", `No worker for project ${project.id}`);
            return;
          }

          // Fresh executions are preassigned an id so a client disconnect can
          // stop the worker run instead of letting side effects continue until
          // the worker-side timeout.
          const timeoutSeconds = body.timeout ?? agent.config.timeout ?? 300;
          const abortController = new AbortController();
          const requestSessionId = body.sessionId ?? ulid();
          let responseFinished = false;
          let stopRequested = false;
          const requestStop = () => {
            if (stopRequested) return;
            stopRequested = true;
            void projectWorker.stopSession({
              projectRoot: project.root,
              sessionId: requestSessionId,
              reason: "client-disconnect",
            }).catch(() => {});
          };
          res.on("finish", () => {
            responseFinished = true;
          });
          res.on("close", () => {
            if (!responseFinished) abortController.abort();
          });
          abortController.signal.addEventListener("abort", requestStop, { once: true });

          // Execute via worker process to work around EBADF issue in async callbacks
          // MCP server spawning fails in HTTP handlers due to bundler/Node.js fd issues
          wakeListHubs();
          const spawnResult = await projectWorker.execute({
            agentPath: toProjectRelativeAgentPath(project, body.agent),
            projectRoot: project.root,
            prompt: body.prompt,
            model: body.model,
            timeout: timeoutSeconds,
            maxSteps: body.maxSteps,
            debug: options.debug,
            sessionId: body.sessionId,
            ...(!body.sessionId && { newSessionId: requestSessionId }),
            trigger: 'api',
            signal: abortController.signal,
          });
          wakeListHubs();

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
              classification: classifyExecution({
                agentSource: 'local',
                trigger: 'api',
                isMock: false,
              }),
              executionOrigin: 'serve',
              reportedSurface,
              toolCalls: spawnResult.telemetry?.toolCalls ?? emptyToolCallMetrics(),
              ...(spawnResult.telemetry && { steps: spawnResult.telemetry.steps }),
              features: configuredFeatureUsage(agent.config, 'webhook'),
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

            if (errorCode === 'ABORTED' && res.destroyed) {
              return;
            }

            // Capture telemetry
            telemetry.captureExecution({
              ...parseModel(body.model || agent.config.model),
              durationMs: duration,
              inputTokens: 0,
              outputTokens: 0,
              success: false,
              classification: classifyExecution({
                agentSource: 'local',
                trigger: 'api',
                isMock: false,
              }),
              executionOrigin: 'serve',
              reportedSurface,
              toolCalls: spawnResult.telemetry?.toolCalls ?? emptyToolCallMetrics(),
              ...(spawnResult.telemetry && { steps: spawnResult.telemetry.steps }),
              errorType: errorCode === 'TIMEOUT'
                ? 'timeout'
                : errorCode === 'INCOMPLETE'
                  ? 'incomplete'
                  : 'unknown',
              features: configuredFeatureUsage(agent.config, 'webhook'),
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
              if (spawnResult.result?.text) {
                const textChunk: AgentChunk = {
                  type: "text",
                  text: spawnResult.result.text,
                };
                res.write(JSON.stringify(textChunk) + "\n");
              }

              const errorChunk: AgentChunk = {
                type: "error",
                error: { code: errorCode, message: errorMessage },
              };
              res.write(JSON.stringify(errorChunk) + "\n");
              res.end();
            } else {
              // JSON error response
              const response = workerExecutionErrorResponse(spawnResult);
              sendJSON(res, response.status, response.body);
            }
          }
        } catch (err) {
          if (sendRequestParseError(res, err)) return;
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

        // Do not enqueue another maintenance RPC while workers are being cut
        // loose; any pass already in flight is included in activeRequestCount.
        orphanReconcileLoop.stop();

        // Decide the fate of the workers FIRST, before any awaits. A supervisor
        // gives us its own grace period and then SIGKILLs -- pm2 defaults to
        // 1.6s -- so anything queued behind a drain or a socket teardown may
        // simply never run, and the agents die with us. Releasing is one pipe
        // write per worker, so it always fits.
        let releasedWorkers = 0;
        let releasedRuns = 0;
        let releasedRequests = 0;
        const releaseEnabled = process.env.AGENTUSE_RELEASE_WORKERS !== "0";
        for (const w of workers.values()) {
          const runs = w.activeRunCount();
          const requests = w.activeRequestCount();
          if (releaseEnabled && requests > 0 && w.release()) {
            releasedWorkers += 1;
            releasedRuns += runs;
            releasedRequests += requests;
            continue;
          }
          w.shutdown();
        }
        if (releasedWorkers > 0) {
          logger.info(`Released ${releasedWorkers} worker(s) with ${releasedRequests} request(s) still draining (${releasedRuns} agent run(s)) — they finish on their own and their results land as usual.`);
        }

        // Unregister from process registry and release per-project scheduler locks
        unregisterServer();
        for (const p of projects) {
          if (schedulerLocksHeld.has(p.id)) releaseSchedulerLock(p.root);
        }
        schedulerLocksHeld.clear();

        scheduler.shutdown();
        approvalHub.shutdown();
        approvalListHub.shutdown();
        sessionListHub.shutdown();
        notificationHub.shutdown();
        if (approvalSweepTimer) {
          clearInterval(approvalSweepTimer);
          approvalSweepTimer = null;
        }
        if (slackApprovalSocket) {
          await slackApprovalSocket.stop().catch(() => {/* ignore */});
        }
        // A released worker carries its resume to completion out of process, so
        // the daemon-side promise tracking it will never settle here and waiting
        // on it would only burn the window. Drain what stayed behind: the tail
        // of work that runs in THIS process after the worker has replied.
        if (releasedRuns === 0) {
          const inflight = [...activeApprovalResumes.values(), ...activeSessionContinuations.values()];
          if (inflight.length > 0) {
            logger.info(`Draining ${inflight.length} in-flight resume/continuation(s) before shutdown (up to ${SHUTDOWN_DRAIN_MS}ms)...`);
            await Promise.race([
              Promise.allSettled(inflight),
              new Promise<void>((resolve) => { const t = setTimeout(resolve, SHUTDOWN_DRAIN_MS); t.unref?.(); }),
            ]);
          }
        }
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
          projectRoot: projects[0]?.root ?? getManagedProjectsRoot(),
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
        if (projects.length === 0) {
          console.log(`  ${chalk.dim("Projects")}  ${chalk.dim("None yet — create one in the Web UI")}`);
          console.log(`  ${chalk.dim("Storage")}   ${chalk.dim(join(getManagedProjectsRoot(), '<project>'))}`);
        } else if (!multiProject) {
          console.log(`  ${chalk.dim("AgentUse data")}`);
          console.log(`    ${chalk.dim("Global")}  ${chalk.dim("~/.agentuse")}`);
          console.log(`    ${chalk.dim("Project")} ${chalk.dim(join(projects[0]!.root, '.agentuse'))}`);
          console.log(`  ${chalk.dim("Scope")}     ${projects[0]!.scopeRoot}`);
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
        if (firstProject) {
          const firstAgent = firstProject.agentFiles[0] || "path/to/agent.agentuse";
          if (!multiProject) {
            console.log(`    curl -X POST ${serverUrl}/run${authHeader} -H "Content-Type: application/json" -d '{"agent": "${firstAgent}"}'`);
          } else {
            console.log(`    curl -X POST ${serverUrl}/run${authHeader} -H "Content-Type: application/json" -d '{"project": "${firstProject.id}", "agent": "${firstAgent}"}'`);
            console.log(`    ${chalk.dim(`curl ${serverUrl}/ for server info`)}`);
          }
          console.log(`    ${chalk.dim(`curl -N ... -H "Accept: application/x-ndjson" -d '{"agent": "..."}' (streaming)`)}`);
        } else {
          console.log(`    ${chalk.dim("Create a project in the Web UI to enable run webhooks.")}`);
        }

        // Available agents for webhooks (only in single-project mode to avoid noise)
        if (!multiProject && firstProject && firstProject.agentFiles.length > 0) {
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

        if (options.open) {
          void openBrowser(serverUrl).then((opened) => {
            if (!opened) {
              console.log(chalk.dim(`  Browser could not be opened here. Open ${serverUrl} from a machine that can reach this server.`));
              console.log();
            }
          });
        }

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

  const formatProjects = (s: ServerEntry): string[] => {
    if (s.projects && s.projects.length > 0) {
      if (s.projects.length === 1) {
        return [truncatePath(s.projects[0].root, widths[2])];
      }
      return s.projects.map((project) => project.id);
    }
    return [truncatePath(s.projectRoot, widths[2])];
  };

  const blocks: string[] = [chalk.dim(headerRow), chalk.dim(separator)];
  for (const s of servers) {
    const projects = formatProjects(s);
    const row = [
      String(s.pid).padEnd(widths[0]),
      String(s.port).padEnd(widths[1]),
      projects[0].padEnd(widths[2]),
      String(s.agentCount).padEnd(widths[3]),
      String(s.scheduleCount).padEnd(widths[4]),
      formatUptime(s.startTime).padEnd(widths[5]),
    ].join("  ");
    blocks.push(row);
    for (const project of projects.slice(1)) {
      blocks.push([
        "".padEnd(widths[0]),
        "".padEnd(widths[1]),
        project.padEnd(widths[2]),
        "".padEnd(widths[3]),
        "".padEnd(widths[4]),
        "".padEnd(widths[5]),
      ].join("  ").trimEnd());
    }
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
  shouldRecycleWorker,
  WORKER_RECYCLE_MB,
  WORKER_RECYCLE_MIN_AGE_MS,
  serveSessionArtifact,
  serveSessionToolOutputArtifact,
  redactAgentDetailSource,
  isHeaderGateExemptRoute,
  isSessionCapabilityAuthorized,
  selectSessionProjects,
  sessionLearningTargetAgent,
  workerExecutionErrorResponse,
  isSpaPageRoute,
  collectAgents,
  formatPsTable,
  formatAgentsTable,
  formatSchedulesTable,
  bareServeMigrationWarning,
  canContinueApprovalSession,
  isEndedSessionStatus,
  approvalListCreatedAfter,
  isPendingApprovalVisible,
  APPROVAL_LIST_SSE_INTERVAL_MS,
  sessionListUpdatedAfter,
  SESSION_LIST_SSE_INTERVAL_MS,
  sessionMatchesAgentFilter,
  sessionMatchesStatusFilter,
  parseSessionMockFilter,
  sessionMatchesMockFilter,
  sessionListStreamKey,
  sessionLearningTidyAllowed,
  importantDescendantTree,
  logsWithChildSessions,
  reportedSurfaceForRun,
  webUIClientSurface,
  parseWebUITelemetryBody,
  webUITelemetryDedupeKey,
  createWebUITelemetryGuard,
  acceptWebUITelemetry,
  canSubmitWebUITelemetry,
  WEB_UI_TELEMETRY_DEDUPE_MS,
};
