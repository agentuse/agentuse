import { classifyFailure, RunAbortError } from '../runner/failure';
import { workerDeathDetail, type WorkerDeath } from '../worker/death';
import { Command } from "commander";
import { ApprovalListPayload, ApprovalRow, ApprovalSessionFilter, ApprovalSummary, ApprovalSummaryStatus, SessionStatusCounts, SessionStatusFilter, SessionSummary, SessionTriageFilter, SessionWindowFilter, SessionsPayload } from "./serve/list-payloads";
import { ApprovalPageInfo } from "./serve/approval-page";
import { SessionStatusInfo, WorkerApprovalInfoResult } from "./serve/session-types";
import { AgentCreationRecoveryInput, OnboardingModelJob, PersistedOnboardingModelJob } from "./serve/internal-jobs";
import { RunRequest, reportedSurfaceForRun, webUIClientSurface, workerExecutionErrorResponse } from "./serve/run-request";
import { LIST_PAGE_DEFAULT_LIMIT, LIST_PAGE_MAX_LIMIT, buildRunTranscript, cursorPage, isEndedSessionStatus, sessionLearningTargetAgent, sessionListStreamKey } from "./serve/session-lists";
import { CHANGESET_ID_PATTERN, ChangesetActiveError, ChangesetTargetError, activeChangesetForTarget, applyProjectChangeset, changesetAcceptsChangeRequest, changesetApplyValidator, changesetListSummary, changesetReviewHref, changesetSessionPurpose, discardProjectChangeset, prepareChangesetStart, removeChangesetWorkspace, resolveChangesetTargetPath, settleChangesetSession } from "./serve/changesets";
import { WorkerExecuteError, WorkerExecuteOptions, WorkerExecuteResult } from "./serve/worker-types";
import { importantDescendantTree, logsWithChildSessions } from "./serve/session-log";
import { serveSessionArtifact, serveSessionToolOutputArtifact } from "./serve/artifacts";
import { isAllowedRequestHost, isExposedHost, isHeaderGateExemptRoute, isSessionCapabilityAuthorized, isSpaPageRoute, isOperatorRequest, validateApiKey, validateApiKeyHeader } from "./serve/auth";
import { createServer, ServerResponse } from "http";
import { spawn, type ChildProcess } from "child_process";
import { join, basename, relative, dirname } from "path";
import { readFile } from "fs/promises";
import { glob } from "glob";
import { createInterface, type Interface as ReadlineInterface } from "readline";
import chalk from "chalk";
import { parseAgent } from "../parser";
import { resolveProjectContext } from "../utils/project";
import { logger, LogLevel, approvalLog } from "../utils/logger";
import { isExecutingSessionStatus, isIncompleteOutcome } from "../session/status";
import { printLogo } from "../utils/branding";
import { initStorage } from "../storage/index.js";
import { getAgentuseDataDir } from "../storage/paths.js";
import { Scheduler, type Schedule, type SerializedSchedule } from "../scheduler";
import { loadPausedSchedules, normalizeScheduleAgentPath, setSchedulePaused } from '../scheduler/state.js';
import { FileWatcher } from "../watcher";
import { telemetry, classifyExecution, configuredFeatureUsage, emptyToolCallMetrics, parseModel, type OnboardingRoute, type OnboardingStep, type WebUIClientSurface, type WebUITelemetryEvent } from "../telemetry";
import { version as packageVersion } from "../../package.json";
import { getBuildInfo, isDevCheckout } from "../utils/build-info";
import { refreshUpdateCacheInBackground } from "../update-check";
import { registerServer, unregisterServer, updateServer, listServers, daemonRequestHeaders, daemonResponseError, formatUptime, getDefaultLogFilePath, hostForUrl, serverBaseUrl, type ServerEntry, type ServerProjectEntry } from "../utils/server-registry";
import { acquireSchedulerLock, releaseSchedulerLock } from "../utils/scheduler-lock";
import { startLogFile, type LogFileHandle } from "../utils/log-file";
import { loadGlobalConfig, applyGlobalConfigEnv, getGlobalConfigPath, getGlobalEnvPath, getManagedProjectsRoot, loadGlobalEnv, type GlobalConfig } from "../utils/global-config";
import { SlackApprovalSocket, updateSlackApprovalRequestStatus, type SlackApprovalDecision, type SlackApprovalThreadComment, type SlackApprovalThreadCommentResult, type SlackRunThreadCommentResult } from "../slack/approval";
import { getSlackWebClient } from "../slack/lifecycle";
import { saveManualLearning, effectiveCap } from "../learning";
import { homedir } from "os";
import type { SessionTrigger } from "../session/types";
import { ulid } from "ulid";
import { apiKeyWorkerEnv, readApiKey, sessionViewToken } from "../utils/session-token";
import { normalizeApiPath } from "./serve/ui";
import { guardRequestHandler, readRequestBody, sendError, sendHTML } from "./serve/http";
import { agentSummaryCache, annotateAgentScheduleStates, collectAgents, redactAgentDetailSource, type AgentSummary } from "./serve/agents-data";
import {
  bareServeMigrationWarning,
  collectDir,
  loadServeProjectEnvironment,
  resolveProjectFromPath,
  resolveScopedAgentPath,
  selectSessionProjects,
  toAgentRunPath,
  toProjectRelativeAgentPath,
  type Project,
} from "./serve/project";
import type { ServeContext, ServeMutableState, ServeRequest } from "./serve/context";
import { agentCreateRoutes } from "./serve/routes/agent-create";
import { agentLearningRoutes } from "./serve/routes/agent-learnings";
import { agentRoutes } from "./serve/routes/agents";
import { approvalRoutes } from "./serve/routes/approvals";
import { homeRoutes } from "./serve/routes/home";
import { notificationRoutes } from "./serve/routes/notifications";
import { onboardingRoutes } from "./serve/routes/onboarding";
import { projectRoutes } from "./serve/routes/projects";
import { providerRoutes } from "./serve/routes/providers";
import { pushRoutes } from "./serve/routes/push";
import { resumeRoutes } from "./serve/routes/resume";
import { revisionRoutes } from "./serve/routes/revisions";
import { runRoutes } from "./serve/routes/run";
import { scheduleRoutes } from "./serve/routes/schedules";
import { sessionLearningRoutes } from "./serve/routes/session-learnings";
import { sessionLifecycleRoutes } from "./serve/routes/session-lifecycle";
import { sessionRoutes } from "./serve/routes/sessions";
import { storeRoutes } from "./serve/routes/stores";
import { FAVICON_SVG, TOUCH_ICON_180_PNG_BASE64, ICON_192_PNG_BASE64, ICON_512_PNG_BASE64, webManifestJson } from "./serve/brand";

// Decoded once; brand.ts itself stays Buffer-free because the web bundle
// shares it (see the note in brand.ts).
const TOUCH_ICON_180_PNG = Buffer.from(TOUCH_ICON_180_PNG_BASE64, "base64");
const ICON_192_PNG = Buffer.from(ICON_192_PNG_BASE64, "base64");
const ICON_512_PNG = Buffer.from(ICON_512_PNG_BASE64, "base64");
import { WebAssets, renderWebAssetsMissingPage } from "./serve/static";
import { readAbout } from "./serve/about";
import { PushService, SERVICE_WORKER_JS, type PushCategory, type PushPayload } from "./serve/push";
import { ApprovalEventHub, ApprovalListEventHub, NotificationEventHub } from "./serve/sse";
import { readSessionResults } from "./serve/stores";
// Type-only, so this stays erased at compile and adds nothing to the bundle.
// The context payload is elaborate enough that a hand-kept local copy (as the
// older session types above are) would drift from the page that consumes it.
import type { SessionContextPayload, SessionPurpose, SessionResult } from "./serve/types";
import { startOrphanReconcileLoop } from "./serve/orphan-reconcile";
import { providerSetupSnapshot } from "../auth/provider-setup";
import { AgentCreationError, agentCreationProviders, createAgentFile } from "../agents/create";
import { validateAuthoredAgentSource } from "../agents/author";
import { failAgentRevision, readAgentRevisionRecord, type AgentRevisionRecord } from "../agents/revision";
import { appendAgentDraft, failAgentDraft, readAgentDraftRecord, type AgentDraftRecord } from "../agents/draft";
import { readChangesetRecord, settleChangesetTestRun } from "../agents/changeset";
import { computeAgentId, stripAgentExtension } from '../utils/agent-id.js';
import { formatCliRow, renderCliTable, renderCliTableHeader } from '../utils/cli-table.js';
import { toErrorMessage } from '../utils/error-message.js';
import { stringifyJsonLine } from '../utils/json-line.js';
import { mountChangesetShadow } from "../agents/changeset-mount";
import { type ChangesetProposal, type ChangesetRecord } from "../agents/changeset-types";
import { configuredMockModel, mockRunEnv, resolveMockScope } from "../runner/mock-tools";
import { parseAgentContent } from "../parser";
import {
  readInternalAgentJobRecord,
  recoverInternalCreatorSession,
  recoverInternalDiscoverySession,
  writeInternalAgentJobRecord,
  type RecoveredAgentSourceSubmission,
} from "../onboarding/internal-job-store.js";
import { openBrowser } from "../utils/open-browser";
import { resolveAgentModel } from "../utils/model-alias";
import { currentProcessRef, getProcessStartTime, isProcessRefAliveAsync, type ProcessRef } from "../utils/process-info";
import {
  createIdempotentShutdown,
  DESKTOP_LIFETIME_FD_ENV,
  DESKTOP_SUPERVISOR_ENV,
  parseDesktopLifetimeFd,
  parseDesktopServerSupervisor,
  watchDesktopLifetime,
} from "../utils/desktop-supervisor";

const APPROVAL_LIST_SSE_INTERVAL_MS = 10_000;
const SESSION_LIST_SSE_INTERVAL_MS = 10_000;
/** Faster session-list cadence while any session is live, so the dashboard tracks runs in near-real-time. */
const SESSION_LIST_SSE_LIVE_INTERVAL_MS = 2_000;
/** Ceiling on how many rows one ?q= search may read final output for. Identity
 *  matches are free; this bounds only the transcript reads behind a text match. */
const SESSION_SEARCH_SCAN_LIMIT = 400;
const WORKER_PROTOCOL_ERROR_CODE = 'WORKER_PROTOCOL_ERROR';

/** Validate a human decision against the durable approval contract. Keeping
 * this server-side means stale clients and notification actions cannot bypass
 * a strict-review feedback gate merely by posting an approve decision. */
function validateDecisionChoice(
  info: WorkerApprovalInfoResult,
  status: string,
  choice: string | undefined
): { code: string; message: string } | null {
  if (info.approval.approvalKind === 'tool_approval') {
    const supported = status === 'approve' || status === 'approved'
      || status === 'reject' || status === 'rejected';
    if (!supported) {
      return { code: 'TOOL_APPROVAL_DECISION_INVALID', message: 'Generic tool approvals support only approve or reject' };
    }
    if (choice !== undefined) {
      return { code: 'CHOICE_INVALID', message: 'Generic tool approvals do not accept option choices' };
    }
    return null;
  }
  const gateOptions = info.approval.options;
  // Both spellings reach the worker as an approval ('approve' and 'approved'
  // normalize to the same decision in src/index.ts), so both must validate
  // identically.
  const isApprove = status === 'approve' || status === 'approved';
  if (isApprove && info.approval.reviewEscalation) {
    return {
      code: 'REVIEW_REVISION_REQUIRED',
      message: 'This draft did not pass strict automated review. Send revision guidance or reject it; it cannot be approved in its current form.',
    };
  }
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
}

/** Worker replies are serialized with `id` first. If JSON-line framing breaks,
 * the first fragment can therefore still identify the request without
 * inspecting or logging any user payload that follows it. */
function workerRequestIdFromMalformedLine(line: string): string | undefined {
  return /^\s*\{\s*"id"\s*:\s*"(req-\d+)"/.exec(line)?.[1];
}

function jsonParseErrorOffset(error: unknown): number | undefined {
  const match = /\bposition\s+(\d+)\b/i.exec(toErrorMessage(error));
  if (!match) return undefined;
  const offset = Number(match[1]);
  return Number.isSafeInteger(offset) ? offset : undefined;
}
/** How many rows of a window the status counts are taken over. Bounds the rows
 *  a worker ships across IPC when the page itself only needs the first 50. */
const SESSION_COUNT_SCAN_LIMIT = 500;










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
const DETECTION_METHODS = new Set(['poll', 'manual_check', 'native_create']);

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
      ? { detectionMethod: body.detection_method as 'poll' | 'manual_check' | 'native_create' }
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







/** A mock run needs more headroom than the same agent would need for real:
 *  fabricated tool results are noisier, so the model spends extra steps
 *  reconciling them. Cutting the run short would make the draft look broken. */
const TEST_RUN_TIMEOUT_SECONDS = 600;
const TEST_RUN_MAX_STEPS = 40;







interface WorkerSessionStatusResult {
  success: true;
  session: SessionStatusInfo;
}

export interface WorkerPreparingSessionResult {
  success: true;
  sessionId: string;
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

const APPROVAL_LIST_DEFAULT_DAYS = 30;
const SESSION_LIST_DEFAULT_WINDOW: SessionWindowFilter = '24h';


interface WorkerListApprovalsResult {
  success: true;
  approvals: ApprovalSummary[];
}



function isPendingApprovalVisible(
  projectId: string,
  approval: Pick<ApprovalSummary, 'sessionId' | 'status'>,
  activeResumes: { has(key: string): boolean }
): boolean {
  return approval.status === 'pending'
    && !activeResumes.has(`${projectId}:${approval.sessionId}`);
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

interface WorkerMarkReviewedResult {
  success: true;
  reviewedAt: number;
  alreadyReviewed: boolean;
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
     *  result can still complete the chain. 'recoverable' waits for the user to
     *  resume the manager, which retries the interrupted child. */
    reason?: 'interrupted' | 'stranded' | 'finishable' | 'recoverable';
  }>;
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
export class AgentWorker {
  private lastWorkerDeath?: WorkerDeath;
  private process: ChildProcess | null = null;
  private readline: ReadlineInterface | null = null;
  private forceKillTimer: NodeJS.Timeout | null = null;
  private pendingRequests: Map<string, {
    resolve: (value: WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSessionStatusResult | WorkerPreparingSessionResult | WorkerSessionContextResult | WorkerSweepExpiredResult | WorkerListApprovalsResult | WorkerListSessionsResult | WorkerSessionFinalResponsesResult | WorkerStopSessionResult) => void;
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

  constructor(
    private envOverrides: NodeJS.ProcessEnv = {},
    private spawnProcess: typeof spawn = spawn,
  ) {}

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
    const child = this.spawnProcess(process.execPath, [cliPath, "--internal-worker"], {
      stdio: ["pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...apiKeyWorkerEnv(),
        ...this.envOverrides,
      },
    });
    this.process = child;
    const procStartedAt = child.pid ? getProcessStartTime(child.pid) : undefined;

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
      this.handleWorkerDeath({ ...(child.pid && { pid: child.pid }), ...(procStartedAt && { procStartedAt }), event: 'error', errorMessage: err.message, observedAt: Date.now() });
    });

    child.on("exit", (code, signal) => {
      if (this.process !== child) return;
      logger.warn(`Worker process exited with code ${code}`);
      this.handleWorkerDeath({ ...(child.pid && { pid: child.pid }), ...(procStartedAt && { procStartedAt }), event: 'exit', exitCode: code, signal, observedAt: Date.now() });
    });

    this.spawnPromise = this.readyPromise
      .then(() => {
        this.respawnAttempts = 0;
      })
      .finally(() => {
        this.spawnPromise = null;
        // A child that dies before its ready signal reaches handleWorkerDeath
        // while spawnPromise is still set. scheduleRespawn deliberately ignores
        // that in-flight attempt, so retry once the rejected attempt has fully
        // settled or this project is left without a worker forever.
        if (!this.ready) this.scheduleRespawn();
      });
    return this.spawnPromise;
  }

  private handleWorkerMessage(line: string) {
    if (!line.trim()) return;

    try {
      const message = JSON.parse(line) as unknown;

      // Handle ready signal
      if (
        typeof message === 'object' && message !== null &&
        'type' in message && message.type === "ready"
      ) {
        this.ready = true;
        if (this.readyResolve) {
          this.readyResolve();
          this.readyResolve = null;
        }
        return;
      }

      const requestId = typeof message === 'object' && message !== null &&
        'id' in message && typeof message.id === 'string' && /^req-\d+$/.test(message.id)
        ? message.id
        : undefined;
      if (
        !requestId ||
        typeof message !== 'object' || message === null ||
        !('success' in message) || typeof message.success !== 'boolean'
      ) {
        this.handleWorkerProtocolError(line, requestId);
        return;
      }

      // Handle response
      const pending = this.pendingRequests.get(requestId);
      if (pending) {
        if (pending.timeoutId) {
          clearTimeout(pending.timeoutId);
        }
        this.pendingRequests.delete(requestId);
        pending.resolve(message as WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSessionStatusResult | WorkerPreparingSessionResult | WorkerSessionContextResult | WorkerSweepExpiredResult | WorkerListApprovalsResult | WorkerListSessionsResult | WorkerSessionFinalResponsesResult | WorkerStopSessionResult);
      }
    } catch (err) {
      this.handleWorkerProtocolError(
        line,
        workerRequestIdFromMalformedLine(line),
        jsonParseErrorOffset(err),
      );
    }
  }

  private handleWorkerProtocolError(line: string, requestId?: string, parseOffset?: number): void {
    const diagnosticId = ulid();
    const pending = requestId ? this.pendingRequests.get(requestId) : undefined;
    logger.error(
      `Worker protocol error: diagnosticId=${diagnosticId} requestId=${requestId ?? 'unmatched'} ` +
      `matched=${pending ? 'true' : 'false'} bytes=${Buffer.byteLength(line, 'utf8')} chars=${line.length}` +
      (parseOffset !== undefined ? ` parseOffset=${parseOffset}` : ''),
    );
    if (!requestId || !pending) return;

    if (pending.timeoutId) clearTimeout(pending.timeoutId);
    this.pendingRequests.delete(requestId);
    pending.resolve({
      success: false,
      error: {
        code: WORKER_PROTOCOL_ERROR_CODE,
        cause: 'worker_protocol',
        message: `Worker returned an unreadable response. Reload to retry. Diagnostic ID: ${diagnosticId}`,
      },
    });
  }

  private handleWorkerDeath(evidence: WorkerDeath) {
    this.lastWorkerDeath = evidence;
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
        error: { code: "WORKER_DIED", cause: 'worker_interrupted', message: "Worker process died unexpectedly", detail: workerDeathDetail(evidence) },
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
        logger.warn(`Worker respawn failed: ${toErrorMessage(error)}`);
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
      preparedSession: options.preparedSession,
    }, { signal: options.signal }) as Promise<WorkerExecuteResult | WorkerExecuteError>;
  }

  createPreparingSession(options: {
    projectRoot: string;
    sessionId: string;
    agentId: string;
    agentName: string;
    agentDescription?: string | undefined;
    model: string;
    trigger: SessionTrigger;
    timeout?: number | undefined;
    maxSteps?: number | undefined;
    owner: ProcessRef;
  }): Promise<WorkerPreparingSessionResult | WorkerExecuteError> {
    const { owner, timeout: sessionTimeout, ...request } = options;
    return this.request({
      type: 'create-preparing-session',
      ...request,
      ...(sessionTimeout !== undefined && { sessionTimeout }),
      preparerOwner: owner,
      timeout: 30,
    }) as Promise<WorkerPreparingSessionResult | WorkerExecuteError>;
  }

  failPreparingSession(options: {
    projectRoot: string;
    sessionId: string;
    code: string;
    message: string;
  }): Promise<WorkerPreparingSessionResult | WorkerExecuteError> {
    const { code: errorCode, message: errorMessage, ...request } = options;
    return this.request({
      type: 'fail-preparing-session',
      ...request,
      errorCode,
      errorMessage,
      timeout: 30,
    }) as Promise<WorkerPreparingSessionResult | WorkerExecuteError>;
  }

  stopSession(options: {
    projectRoot: string;
    sessionId: string;
    reason?: string | undefined;
    stopCause?: 'user_stopped' | 'client_disconnect';
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
      ...(options.stopCause && { stopCause: options.stopCause }),
      ...(options.dismissEnded && { dismissEnded: true }),
      timeout: 30,
    }) as Promise<WorkerStopSessionResult | WorkerExecuteError>;
  }

  /** Reviewer opened an ended run's page: stamp reviewedAt (idempotent). */
  markSessionReviewed(options: {
    projectRoot: string;
    sessionId: string;
  }): Promise<WorkerMarkReviewedResult | WorkerExecuteError> {
    return this.request({
      type: "mark-session-reviewed",
      projectRoot: options.projectRoot,
      sessionId: options.sessionId,
      timeout: 30,
    }) as Promise<WorkerMarkReviewedResult | WorkerExecuteError>;
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

  /** Retry the recoverable failed child under a parked manager, then walk its
   *  real result back up through the parent cascade. */
  retryCascade(projectRoot: string, sessionId: string): Promise<WorkerExecuteResult | WorkerExecuteError> {
    return this.request({
      type: "retry-cascade",
      projectRoot,
      sessionId,
    }) as Promise<WorkerExecuteResult | WorkerExecuteError>;
  }

  reconcileOrphans(projectRoot: string, cutoff: number): Promise<WorkerReconcileResult | WorkerExecuteError> {
    return this.request({
      type: "reconcile-orphans",
      projectRoot,
      reconcileCutoff: cutoff,
      ...(this.lastWorkerDeath && { workerDeath: this.lastWorkerDeath }),
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

  /** Drop this worker's provider plugin and readiness caches. Provider setup
   *  happens in the daemon, so only a poke makes a warm worker see a plugin or
   *  credential that Settings just changed. */
  resetProviderPlugins(projectRoot: string): Promise<WorkerExecuteResult | WorkerExecuteError> {
    return this.request({
      type: "reset-provider-plugins",
      projectRoot,
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
  ): Promise<WorkerExecuteResult | WorkerExecuteError | WorkerApprovalInfoResult | WorkerSessionStatusResult | WorkerPreparingSessionResult | WorkerSessionContextResult | WorkerSweepExpiredResult | WorkerListApprovalsResult | WorkerListSessionsResult | WorkerSessionFinalResponsesResult | WorkerStopSessionResult> {
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
          error: requestOptions.signal?.reason instanceof RunAbortError
            ? classifyFailure(requestOptions.signal.reason)
            : { code: "ABORTED", message: "Request aborted" },
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
      const longRunningRequest = options.type === "execute" || options.type === "resume" || options.type === "continue-session" || options.type === "finish-cascade" || options.type === "retry-cascade";
      if (longRunningRequest) this.activeRuns.add(id);
      const requestTimeoutSeconds = options.timeout ?? (longRunningRequest ? 24 * 60 * 60 : 300);
      const timeoutMs = requestTimeoutSeconds * 1000 + 5000; // Add 5s buffer

      const timeoutId = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (pending) {
          this.pendingRequests.delete(id);
          pending.resolve({
            success: false,
            error: { code: "TIMEOUT", cause: 'request_deadline', message: `Request timed out after ${requestTimeoutSeconds}s` },
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
          error: requestOptions.signal?.reason instanceof RunAbortError
            ? classifyFailure(requestOptions.signal.reason)
            : { code: "ABORTED", message: "Request aborted" },
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

      this.process.stdin!.write(stringifyJsonLine(request));
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
      child.stdin!.write(stringifyJsonLine({ id: `req-${++this.requestCounter}`, type: "release" }));
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
      logger.warn(`Worker recycle for ${projectId} failed: ${toErrorMessage(error)}`);
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
  return value === 'preparing' || value === 'running' || value === 'suspended' || value === 'completed' || value === 'idle' || value === 'error' || value === 'incomplete'
    ? value
    : undefined;
}

function parseSessionTriageFilter(value: string | undefined): SessionTriageFilter | undefined {
  return value === 'undismissed' || value === 'dismissed' ? value : undefined;
}

/**
 * `incomplete` is a user-facing outcome label, persisted as an error with the
 * INCOMPLETE code. Keep the API filter aligned with the label shown in the Web
 * UI instead of treating it as a separate on-disk session status: the two
 * filters partition the errors, so `error` means a crash and never swallows a
 * run the agent itself declared incomplete.
 */
function sessionMatchesStatusFilter(
  session: Pick<SessionSummary, 'status' | 'outcome' | 'errorCode'>,
  filter: SessionStatusFilter | undefined
): boolean {
  if (!filter) return true;
  const incomplete = isIncompleteOutcome(session.status, session.errorCode);
  if (filter === 'incomplete') return incomplete;
  if (filter === 'error') return session.status === 'error' && !incomplete;
  if (filter === 'idle') return session.status === 'completed' && session.outcome === 'idle';
  if (filter === 'completed') return session.status === 'completed' && session.outcome !== 'idle';
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

type SessionResultsFilter = 'unseen';

function parseSessionResultsFilter(value: string | undefined): SessionResultsFilter | undefined {
  return value === 'unseen' ? value : undefined;
}

/** Runs that recorded the named record_metric (rows must carry `results`). */
function sessionMatchesMetricFilter(
  session: Pick<SessionSummary, 'results'>,
  filter: string | undefined
): boolean {
  if (!filter) return true;
  return (session.results ?? []).some((result) => result.metric === filter);
}

/**
 * `unseen` = a finished run that recorded results and that no reviewer has
 * opened (reviewedAt) or waved off (dismissedAt). Failures are not "results";
 * they have their own queue.
 */
function sessionMatchesResultsFilter(
  session: Pick<SessionSummary, 'status' | 'results' | 'reviewedAt' | 'dismissedAt'>,
  filter: SessionResultsFilter | undefined
): boolean {
  if (!filter) return true;
  return session.status === 'completed'
    && (session.results?.length ?? 0) > 0
    && session.reviewedAt === undefined
    && session.dismissedAt === undefined;
}

type SessionMockFilter = 'exclude' | 'include' | 'only';

function parseSessionMockFilter(value: string | undefined): SessionMockFilter {
  return value === 'include' || value === 'only' ? value : 'exclude';
}

/**
 * Identity half of ?q=: the agent this run belongs to. Matched in memory for
 * every row, so only the rows it misses pay for a transcript read.
 */
function sessionMatchesSearchIdentity(
  session: Pick<SessionSummary, 'agent'>,
  query: string
): boolean {
  return session.agent.id.toLowerCase().includes(query)
    || (session.agent.name ?? '').toLowerCase().includes(query);
}

/**
 * The status split the list's chips render. Live work (running, or a parent
 * parked on a running child) counts as running wherever it is durably parked,
 * matching the dot the list draws.
 */
function sessionStatusCounts(
  sessions: ReadonlyArray<Pick<SessionSummary, 'status' | 'outcome' | 'subagentActive' | 'errorCode'>>
): SessionStatusCounts {
  const counts: SessionStatusCounts = { all: sessions.length, running: 0, done: 0, idle: 0, failed: 0, incomplete: 0 };
  for (const session of sessions) {
    if (isExecutingSessionStatus(session.status) || session.subagentActive === true) counts.running += 1;
    else if (session.status === 'completed' && session.outcome === 'idle') counts.idle += 1;
    else if (session.status === 'completed') counts.done += 1;
    else if (isIncompleteOutcome(session.status, session.errorCode)) counts.incomplete += 1;
    else if (session.status === 'error') counts.failed += 1;
  }
  return counts;
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

function agentRevisionSessionPurpose(
  record: Pick<AgentRevisionRecord, 'originSessionId' | 'targetAgentName'>
): SessionPurpose {
  return {
    kind: 'agent-revision',
    ...(record.originSessionId && { originSessionId: record.originSessionId }),
    targetAgentName: record.targetAgentName,
  };
}

/* ── Changesets ──────────────────────────────────────────────────────────────
   The multi-file successor to drafts and revisions. Everything here is the
   part of the route family that does not need the server closure, so it can be
   exercised directly by the route tests. */












































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

function approvalSlackStatusPrompt(approval: ApprovalPageInfo): string | undefined {
  if (typeof approval.prompt === 'string' && approval.prompt.trim().length > 0) {
    return approval.prompt;
  }
  const toolName = approval.approvalKind === 'tool_approval'
    && typeof approval.toolApproval?.toolName === 'string'
    && approval.toolApproval.toolName.trim().length > 0
    ? approval.toolApproval.toolName
    : undefined;
  return toolName ? `Approve execution of ${toolName}?` : undefined;
}

function isAgentRevisionContinuationInFlight(
  projectId: string,
  revisionSessionId: string,
  revisionMutations: ReadonlySet<string>,
  activeSessionContinuations: ReadonlyMap<string, unknown>,
): boolean {
  return revisionMutations.has(`revision:${projectId}:${revisionSessionId}`)
    || activeSessionContinuations.has(`${projectId}:${revisionSessionId}`);
}

/** A draft whose creator session is mid-handoff must not be reconciled: the
 *  durable session still carries the previous turn's terminal status. */
function isAgentDraftContinuationInFlight(
  projectId: string,
  jobId: string,
  draftMutations: ReadonlySet<string>,
  activeSessionContinuations: ReadonlyMap<string, unknown>,
  activeApprovalResumes: ReadonlyMap<string, unknown>,
): boolean {
  return draftMutations.has(`draft:${projectId}:${jobId}`)
    || activeSessionContinuations.has(`${projectId}:${jobId}`)
    || activeApprovalResumes.has(`${projectId}:${jobId}`);
}

export type BackgroundSessionFailure = { status: string; message: string; at: number };

/** Add an asynchronous resume/continuation failure to the next session payload. */
function applyBackgroundSessionFailure<T extends { errorMessage?: string; sessionStatus?: string }>(
  session: T,
  failure: BackgroundSessionFailure | undefined,
): T {
  if (!failure) return session;
  if (failure.status === 'continue') {
    session.errorMessage = `Couldn't continue this session: ${failure.message}`;
    return session;
  }
  const stillOpen = session.sessionStatus === undefined
    || session.sessionStatus === 'suspended'
    || session.sessionStatus === 'waiting';
  if (!stillOpen) return session;
  const action = failure.status === 'approved' ? 'approve'
    : failure.status === 'rejected' ? 'reject'
      : failure.status === 'comment' ? 'send your comment on'
        : 'act on';
  const retryable = !failure.message.includes('CASCADE_GATE_UNRESOLVABLE');
  session.errorMessage = `Couldn't ${action} this request: ${failure.message}`
    + (retryable ? '; the gate is still open, try again.' : '');
  return session;
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
    .option("--no-code-mode", "Disable the default code_exec tool for controlled comparison and debugging")
    .option("--no-auth", "Disable API key requirement for exposed hosts (dangerous)")
    .option("--no-log-file", "Disable the per-server log file (stdout/stderr tee)")
    .option("--open", "Open the Web UI in the default browser after startup")
    .option("--hide-agent-source", "Hide raw agent source in the dashboard and /api/agents/detail; capability summaries stay visible (or config.serve.hideAgentSource)")
    .action(async (options: { port?: string; host?: string; publicUrl?: string; directory: string[]; default?: string; debug?: boolean; codeMode?: boolean; auth: boolean; logFile: boolean; open?: boolean; hideAgentSource?: boolean }) => {
      const desktopSupervisor = parseDesktopServerSupervisor(process.env[DESKTOP_SUPERVISOR_ENV]);
      const desktopLifetimeFd = parseDesktopLifetimeFd(process.env[DESKTOP_LIFETIME_FD_ENV]);
      // These describe only this daemon. Do not leak the parent's ownership
      // channel into worker processes spawned later by the server.
      delete process.env[DESKTOP_SUPERVISOR_ENV];
      delete process.env[DESKTOP_LIFETIME_FD_ENV];

      // Load global config once; hard-fail on malformed config so users don't silently get defaults.
      let globalConfig: GlobalConfig | null = null;
      try {
        globalConfig = loadGlobalConfig();
      } catch (err) {
        console.error(chalk.red(toErrorMessage(err)));
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
      // Keep the whole daemon, its workers, and recursive subagents in one A/B
      // arm. Project dotenv loading does not override this inherited value.
      if (options.codeMode === false) process.env.AGENTUSE_CODE_MODE = '0';
      let preferredAgentCreationModel: string | undefined;
      try {
        preferredAgentCreationModel = resolveAgentModel(undefined)?.model;
      } catch {
        // A broken optional default should not hide otherwise usable connected
        // providers. Agent parsing continues to report the configuration error.
      }

      // Precedence: explicit CLI flag > config > built-in default.
      const effectivePortRaw = options.port ?? (serveCfg?.port !== undefined ? String(serveCfg.port) : "12233");
      const port = parseInt(effectivePortRaw, 10);
      if (isNaN(port) || port <= 0 || port > 65535) {
        console.error("Invalid port number");
        process.exit(1);
      }
      const effectiveHost = options.host ?? serveCfg?.host ?? "127.0.0.1";
      const serverUrl = `http://${hostForUrl(effectiveHost)}:${port}`;
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
      const apiKey = readApiKey();

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
            console.error(chalk.red(toErrorMessage(err)));
            process.exit(1);
          }
        }
      } else if (serveCfg?.projects && serveCfg.projects.length > 0) {
        for (const p of serveCfg.projects) {
          try {
            projectSeeds.push(resolveProjectFromPath(p.path, p.id));
          } catch (err) {
            console.error(chalk.red(`Config project ${p.id ?? p.path}: ${toErrorMessage(err)}`));
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

      // Daemon locals that routes REASSIGN (not just mutate): one object so
      // every reader and writer, here and in the route modules, shares a cell.
      // `serveState.effectiveDefault` is CLI --default > config.serve.default.
      const serveState: ServeMutableState = {
        multiProject: projectSeeds.length > 1,
        effectiveDefault: options.default ?? serveCfg?.default,
        projectMutationInFlight: false,
        totalExecutions: 0,
        successfulExecutions: 0,
        failedExecutions: 0,
      };

      // Validate effective default
      if (serveState.effectiveDefault !== undefined) {
        if (!serveState.multiProject) {
          const from = options.default !== undefined ? '--default' : 'config.serve.default';
          console.error(chalk.red(`\nError: ${from} is only meaningful with multiple projects.`));
          process.exit(1);
        }
        if (!idSeen.has(serveState.effectiveDefault)) {
          const known = projectSeeds.map((p) => p.id).join(', ');
          const from = options.default !== undefined ? '--default' : 'config.serve.default';
          console.error(chalk.red(`\nError: ${from} "${serveState.effectiveDefault}" is not a known project id.`));
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
        console.error(chalk.dim(`  Address:  ${serverBaseUrl(current)}`));
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
          logger.warn(`Failed to initialize session storage for ${p.id}: ${toErrorMessage(err)}`);
        }
      }

      for (const p of projectSeeds) {
        logger.info(`Project ${p.id}: ${p.root}`);
      }

      // Initialize telemetry
      await telemetry.init(packageVersion, { batchDelivery: true });
      if (!isDevCheckout()) refreshUpdateCacheInBackground(packageVersion);

      // Spawn one worker per project. Each worker loads its own project's
      // .env / .env.local on each execute request, so per-project env stays
      // isolated from the parent process and from sibling projects.
      const workers = new Map<string, AgentWorker>();
      /** Tell every worker to drop its provider plugin and readiness caches.
       *  Best effort: a worker that is down or slow to answer respawns with a
       *  cold cache anyway, so a failed poke cannot leave one stale. */
      const resetWorkerProviderPlugins = async (): Promise<void> => {
        await Promise.allSettled(projects.map((project) =>
          workers.get(project.id)?.resetProviderPlugins(project.root)));
      };
      const onboardingJobs = new Map<string, OnboardingModelJob>();
      const agentCreationRecoveryInputs = new Map<string, AgentCreationRecoveryInput>();
      const activeInternalJobRecoveries = new Map<string, Promise<void>>();
      /** Sanitized project views for internal sessions that can be continued.
       *  The view has to outlive the first turn, so cleanup is deferred until
       *  the draft or revision it belongs to is resolved. */
      const internalViewCleanups = new Map<string, () => Promise<void>>();
      const revisionMutations = new Set<string>();
      const draftMutations = new Set<string>();
      /** One in-flight mutation per change set, like `revisionMutations`. */
      const changesetMutations = new Set<string>();
      /** How long a draft may sit without a durable creator session before a
       *  restart, rather than the normal write ordering, is the only
       *  explanation left. */
      const DRAFT_RECOVERY_GRACE_MS = 30_000;
      const activeSessionContinuations = new Map<string, Promise<unknown>>();
      const cleanupInternalView = async (sessionId: string): Promise<void> => {
        const cleanup = internalViewCleanups.get(sessionId);
        if (!cleanup) return;
        internalViewCleanups.delete(sessionId);
        await cleanup().catch(() => undefined);
      };
      const pruneOnboardingJobs = (): void => {
        const cutoff = Date.now() - 60 * 60 * 1000;
        for (const [id, job] of onboardingJobs) {
          if (job.status !== 'running' && job.createdAt < cutoff) onboardingJobs.delete(id);
        }
        if (onboardingJobs.size <= 100) return;
        const settled = [...onboardingJobs.values()]
          .filter((job) => job.status !== 'running')
          .sort((a, b) => a.createdAt - b.createdAt);
        for (const job of settled) {
          if (onboardingJobs.size <= 100) break;
          onboardingJobs.delete(job.id);
        }
      };
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
        const recoverable = r.reconciled.filter((o) => o.reason === 'recoverable').length;
        const interrupted = r.reconciled.length - finishable.length - stranded - recoverable;
        if (interrupted > 0) {
          logger.warn(`Recovered ${interrupted} interrupted session(s) in ${projectId} (stuck 'running' after a worker restart)`);
        }
        if (stranded > 0) {
          logger.warn(`Ended ${stranded} stranded session(s) in ${projectId} (parked on a delegated sub-agent that had already ended)`);
        }
        if (recoverable > 0) {
          logger.warn(`Marked ${recoverable} interrupted delegated run(s) resumable in ${projectId}`);
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
        onError: (error) => logger.debug(`Orphan reconciliation failed: ${toErrorMessage(error)}`),
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
          throw new Error(`Failed to spawn worker for ${p.id}: ${toErrorMessage(err)}`);
        }
        workers.set(p.id, w);
        return w;
      };
      for (const p of projectSeeds) {
        try {
          await spawnProjectWorker(p);
        } catch (err) {
          console.error(chalk.red(toErrorMessage(err)));
          for (const live of workers.values()) live.shutdown();
          process.exit(1);
        }
      }
      orphanReconcileLoop.runNow();
      logger.debug(`Spawned ${workers.size} agent worker(s)`);

      // Execution stats tracking
      const serverStartTime = Date.now();
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
            logger.debug(`List cache invalidation failed: ${toErrorMessage(err)}`);
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
          serveState.totalExecutions++;
          serveState.failedExecutions++;
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
          serveState.totalExecutions++;
          serveState.failedExecutions++;
          return {
            success: false,
            duration,
            error: toErrorMessage(parseError),
          };
        }

        const projectWorker = workers.get(project.id);
        if (!projectWorker) {
          serveState.totalExecutions++;
          serveState.failedExecutions++;
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
          serveState.totalExecutions++;
          serveState.successfulExecutions++;

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
          serveState.totalExecutions++;
          serveState.failedExecutions++;

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

      const pausedSchedulesByProject = new Map<string, Set<string>>();
      for (const seed of projectSeeds) {
        try {
          pausedSchedulesByProject.set(seed.id, await loadPausedSchedules(seed.root));
        } catch (error) {
          logger.warn(`Could not load schedule state for ${seed.id}: ${toErrorMessage(error)}`);
          pausedSchedulesByProject.set(seed.id, new Set());
        }
      }
      const scheduleIsEnabled = (
        project: Project | Omit<Project, 'agentFiles'>,
        agentPath: string,
      ): boolean => !pausedSchedulesByProject
        .get(project.id)
        ?.has(normalizeScheduleAgentPath(toProjectRelativeAgentPath(project, agentPath)));

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
              scheduler.add(seed.id, agentFile, agent.config.schedule, agent.config.name, scheduleIsEnabled(seed, agentFile));
              logger.debug(`Loaded schedule for ${seed.id}: ${agentFile}`);
            }
          } catch (err) {
            logger.warn(`Failed to load agent ${seed.id}/${agentFile}: ${toErrorMessage(err)}`);
          }
        }
      }

      const projectsById = new Map<string, Project>(projects.map((p) => [p.id, p]));

      // Mutable per-project agent counts (updated by hot reload)
      const agentCounts = new Map<string, number>(projects.map((p) => [p.id, p.agentFiles.length]));

      /** Shape used when onboarding selects a project. Existing loaded projects
       * and newly attached projects must enter the same UI state. */
      const onboardingProjectInfo = async (project: Project) => ({
        id: project.id,
        path: project.scopeRoot,
        agentCount: agentCounts.get(project.id) ?? project.agentFiles.length,
        scheduleCount: scheduler.list().filter((item) => item.projectId === project.id).length,
        ...await readAbout(project.root).then((about) => (about ? { about } : {})),
      });

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

      const persistOnboardingJob = async (job: OnboardingModelJob): Promise<void> => {
        const project = projectsById.get(job.projectId);
        if (!project) return;
        const agentCreation = agentCreationRecoveryInputs.get(job.id);
        await writeInternalAgentJobRecord(project.root, job.id, {
          job,
          ownerPid: process.pid,
          owner: currentProcessRef(),
          ...(agentCreation && { agentCreation }),
        } satisfies PersistedOnboardingModelJob);
      };

      /** Start every model-backed internal feature through the same durable
       * preparing shell. The job envelope describes the product operation;
       * the session is the execution authority and is promoted atomically by
       * worker.execute once preparation has finished. */
      const beginInternalAgentJob = async (options: {
        job: OnboardingModelJob;
        worker: AgentWorker;
        project: Project;
        agentId: string;
        agentName: string;
        agentDescription: string;
        timeout: number;
        maxSteps: number;
        trigger: SessionTrigger;
      }): Promise<WorkerPreparingSessionResult | WorkerExecuteError> => {
        const { job, worker, project } = options;
        pruneOnboardingJobs();
        onboardingJobs.set(job.id, job);
        await persistOnboardingJob(job);
        const prepared = await worker.createPreparingSession({
          projectRoot: project.root,
          sessionId: job.sessionId,
          agentId: options.agentId,
          agentName: options.agentName,
          agentDescription: options.agentDescription,
          model: job.model,
          trigger: options.trigger,
          timeout: options.timeout,
          maxSteps: options.maxSteps,
          owner: currentProcessRef(),
        });
        if (!prepared.success) {
          job.status = 'error';
          job.error = prepared.error;
          await persistOnboardingJob(job);
        }
        wakeListHubs();
        return prepared;
      };

      const loadPersistedOnboardingJob = async (id: string): Promise<PersistedOnboardingModelJob | null> => {
        for (const project of projects) {
          const record = await readInternalAgentJobRecord<PersistedOnboardingModelJob>(project.root, id).catch(() => null);
          if (record?.job?.id === id && record.job.projectId === project.id) return record;
        }
        return null;
      };

      const finishAgentCreation = async (
        project: Project,
        recovery: AgentCreationRecoveryInput,
        submission: Pick<RecoveredAgentSourceSubmission, 'source' | 'name' | 'fileName'>,
      ) => {
        const authored = validateAuthoredAgentSource(
          submission.source,
          recovery.availableModels,
          recovery.request.name,
          recovery.schedule,
        );
        const created = await createAgentFile(project, {
          name: submission.name,
          fileName: submission.fileName,
          objective: recovery.request.objective,
          model: authored.model,
          source: authored.source,
        }, recovery.configuredProviders);
        if (recovery.guided) {
          const statePath = toProjectRelativeAgentPath(project, created.runPath);
          const paused = await setSchedulePaused(project.root, statePath, true);
          pausedSchedulesByProject.set(project.id, paused);
          scheduler.setEnabled(project.id, created.runPath, false);
        }
        if (!project.agentFiles.includes(created.runPath)) {
          project.agentFiles.push(created.runPath);
          project.agentFiles.sort();
          agentCounts.set(project.id, project.agentFiles.length);
          updateRegistryCounts();
        }
        agentSummaryCache.delete(created.absolutePath);
        agentSummaryCache.delete(resolveScopedAgentPath(project, created.runPath));
        const collected = await collectAgents([project]);
        const agent = collected.agents.find((candidate) => candidate.runPath === created.runPath);
        if (!agent) throw new Error('The new agent could not be loaded after it was written');
        return { success: true as const, agent };
      };

      /** The draft page's payload: the record plus the capability token it needs
       *  to stream the creator session it belongs to. */
      const draftViewPayload = (project: Project, record: AgentDraftRecord) => {
        const token = sessionViewToken(record.jobId, apiKey);
        const params = new URLSearchParams({ project: project.id });
        if (token) params.set('token', token);
        return {
          ...record,
          ...(token && { sessionToken: token }),
          sessionHref: `/sessions/${encodeURIComponent(record.jobId)}?${params.toString()}`,
        };
      };

      /** Saving may happen long after the daemon that started the draft died, so
       *  the creation request is read back from the persisted job envelope when
       *  it is no longer in memory. */
      const resolveAgentCreationRecovery = async (
        jobId: string,
        record: AgentDraftRecord,
      ): Promise<AgentCreationRecoveryInput> => {
        const inMemory = agentCreationRecoveryInputs.get(jobId);
        if (inMemory) return inMemory;
        const persisted = await loadPersistedOnboardingJob(jobId);
        if (persisted?.agentCreation) {
          agentCreationRecoveryInputs.set(jobId, persisted.agentCreation);
          return persisted.agentCreation;
        }
        // Last resort: rebuild the minimum the save path validates against from
        // the record itself, so a draft is never unsaveable because its envelope
        // was pruned.
        const snapshot = await providerSetupSnapshot();
        const providers = await agentCreationProviders(snapshot.status, preferredAgentCreationModel);
        return {
          request: { objective: record.objective, model: record.authoringModel },
          guided: record.guided,
          configuredProviders: providers.map((provider) => provider.id),
          availableModels: [...new Set(providers.flatMap((provider) => provider.models))],
        };
      };

      /** Run the current draft for real shape but with no real effects: a
       *  dedicated worker carries the mock env, so the shared project worker
       *  keeps executing real runs untouched. The session it produces is marked
       *  mock by the runtime and stays out of Sessions and Home by default. */
      // Test runs execute in their own AgentWorker, not the project's, so the
      // session stop route must be able to find that worker by session id.
      const testRunWorkers = new Map<string, AgentWorker>();
      const startMockTestRun = async (
        project: Project,
        candidate: { source: string; name: string; fileName: string; model: string; index: number },
        onSettled?: (
          sessionId: string,
          outcome: { status: 'completed' | 'error'; error?: { code: string; message: string } },
        ) => Promise<void>,
      ): Promise<{ sessionId: string; draftIndex: number; sessionToken?: string }> => {
        const draft = candidate;
        const sessionId = ulid();
        // Mock fires an LLM call per fabricated tool result, so it needs a cheap
        // model the operator has named. Falling back to the agent's own premium
        // model is exactly what `agentuse test` refuses to do, and a test run
        // must not be the one path that quietly does it.
        const mockModel = configuredMockModel();
        if (!mockModel) {
          throw new Error(
            'Test runs need a mock model. Set AGENTUSE_MOCK_MODEL to a cheap, reachable model '
            + 'such as anthropic:claude-haiku-4-5, in the shell or in the env block of the AgentUse config.',
          );
        }
        // The same adaptive scope `agentuse test` uses: an agent that fences
        // commands behind tools.bash.gated gets those faked and everything else
        // real, so the run is grounded in the operator's actual project.
        let scope: 'all' | 'gated' = 'all';
        try {
          scope = resolveMockScope(parseAgentContent(draft.source, draft.fileName).config);
        } catch {
          // An unparseable draft cannot reach here through submit_agent_source,
          // but if it ever did the run pipeline reports it better than we can.
        }
        const worker = new AgentWorker({
          AGENTUSE_PROJECT_ID: project.id,
          AGENTUSE_RESUME_PUBLIC_URL: effectivePublicUrl,
          ...mockRunEnv({ scope, model: mockModel }),
        });
        await worker.spawn();
        testRunWorkers.set(sessionId, worker);
        const prepared = await worker.createPreparingSession({
          projectRoot: project.root,
          sessionId,
          agentId: stripAgentExtension(draft.fileName),
          agentName: draft.name,
          agentDescription: `Mock test run of draft ${draft.index}`,
          model: draft.model,
          trigger: 'manual',
          timeout: TEST_RUN_TIMEOUT_SECONDS,
          maxSteps: TEST_RUN_MAX_STEPS,
          owner: currentProcessRef(),
        });
        if (!prepared.success) {
          testRunWorkers.delete(sessionId);
          worker.shutdown();
          throw new Error(prepared.error.message);
        }
        wakeListHubs();
        void worker.execute({
          agentContent: draft.source,
          agentName: draft.name,
          projectRoot: project.root,
          newSessionId: sessionId,
          preparedSession: true,
          trigger: 'manual',
          timeout: TEST_RUN_TIMEOUT_SECONDS,
          maxSteps: TEST_RUN_MAX_STEPS,
          debug: options.debug,
        }).then(async (result) => {
          await onSettled?.(sessionId, result.success
            ? { status: 'completed' }
            : { status: 'error', error: result.error });
        }).catch(async (error: unknown) => {
          await onSettled?.(sessionId, {
            status: 'error',
            error: { code: 'TEST_RUN_FAILED', message: toErrorMessage(error) },
          }).catch(() => undefined);
        }).finally(() => {
          testRunWorkers.delete(sessionId);
          worker.shutdown();
          wakeListHubs();
        });
        const token = sessionViewToken(sessionId, apiKey);
        return { sessionId, draftIndex: draft.index, ...(token && { sessionToken: token }) };
      };

      /**
       * Test-run a change set from a shadow root instead of from memory.
       * `mountChangesetShadow` lays the proposed files over a link farm of the
       * real project, and the entry runs from `shadow/<entry>` so `${agentDir}`,
       * sibling workers and scripts beside the agent all resolve without a
       * single write landing in the project.
       *
       * `projectRoot` stays the real project: it is what `initStorage` keys the
       * session store on, so running against the shadow root would file the test
       * run under a project directory no served project can find. The shadow
       * therefore backs `${agentDir}` and relative references, not `${root}`.
       */
      const startChangesetTestRun = async (
        project: Project,
        record: ChangesetRecord,
        proposal: ChangesetProposal,
      ): Promise<{ sessionId: string; proposalIndex: number; sessionToken?: string }> => {
        const entry = proposal.entry;
        if (!entry) throw new Error('This change set has no entry agent to run');
        const mockModel = configuredMockModel();
        if (!mockModel) {
          throw new Error(
            'Test runs need a mock model. Set AGENTUSE_MOCK_MODEL to a cheap, reachable model '
            + 'such as anthropic:claude-haiku-4-5, in the shell or in the env block of the AgentUse config.',
          );
        }
        const mount = await mountChangesetShadow({
          projectRoot: project.root,
          scopeRoot: project.scopeRoot,
          sessionId: record.sessionId,
          files: proposal.files.map((file) => ({ path: file.path, content: file.content })),
        });
        let launched = false;
        try {
          const entryPath = mount.entryFor(entry);
          const fileName = entry.split('/').pop() ?? 'agent.agentuse';
          const parsed = parseAgentContent(await readFile(entryPath, 'utf8'), fileName);
          let scope: 'all' | 'gated' = 'all';
          try {
            scope = resolveMockScope(parsed.config);
          } catch {
            // An unparseable entry cannot reach here through submit_changes; if
            // it ever did, the run pipeline reports it better than we can.
          }
          const testSessionId = ulid();
          const worker = new AgentWorker({
            AGENTUSE_PROJECT_ID: project.id,
            AGENTUSE_RESUME_PUBLIC_URL: effectivePublicUrl,
            ...mockRunEnv({ scope, model: mockModel }),
          });
          await worker.spawn();
          testRunWorkers.set(testSessionId, worker);
          // The runner keys the session directory by the entry's path relative
          // to the project root (see computeAgentId in session-helper), and the
          // shadow lives under .agentuse/, so the prepared shell must use the
          // same derived id or promotion fails with PREPARING_SESSION_NOT_FOUND.
          const prepared = await worker.createPreparingSession({
            projectRoot: project.root,
            sessionId: testSessionId,
            agentId: computeAgentId(entryPath, project.root, parsed.name),
            agentName: parsed.name,
            agentDescription: `Mock test run of change set proposal ${proposal.index}`,
            model: parsed.config.model,
            trigger: 'manual',
            timeout: TEST_RUN_TIMEOUT_SECONDS,
            maxSteps: TEST_RUN_MAX_STEPS,
            owner: currentProcessRef(),
          });
          if (!prepared.success) {
            testRunWorkers.delete(testSessionId);
            worker.shutdown();
            throw new Error(prepared.error.message);
          }
          wakeListHubs();
          launched = true;
          const settle = (outcome: { status: 'completed' | 'error'; error?: { code: string; message: string } }) =>
            settleChangesetTestRun(project.root, record.sessionId, testSessionId, outcome)
              .then(() => undefined)
              .catch(() => undefined);
          void worker.execute({
            agentPath: entryPath,
            projectRoot: project.root,
            newSessionId: testSessionId,
            preparedSession: true,
            trigger: 'manual',
            timeout: TEST_RUN_TIMEOUT_SECONDS,
            maxSteps: TEST_RUN_MAX_STEPS,
            debug: options.debug,
          }).then((result) => settle(result.success
            ? { status: 'completed' }
            : { status: 'error', error: result.error }))
            .catch((error: unknown) => settle({
              status: 'error',
              error: { code: 'TEST_RUN_FAILED', message: toErrorMessage(error) },
            }))
            .finally(async () => {
              testRunWorkers.delete(testSessionId);
              worker.shutdown();
              await mount.cleanup().catch(() => undefined);
              wakeListHubs();
            });
          const token = sessionViewToken(testSessionId, apiKey);
          return { sessionId: testSessionId, proposalIndex: proposal.index, ...(token && { sessionToken: token }) };
        } finally {
          if (!launched) await mount.cleanup().catch(() => undefined);
        }
      };

      /**
       * A test run is settled by the daemon that launched it, so a restart
       * mid-run leaves its `running` row behind forever, and that row blocks
       * every later test run of the change set. A run this daemon is not
       * driving cannot still be in flight: settle it as interrupted.
       */
      const settleStaleChangesetTestRuns = async (
        project: Project,
        record: ChangesetRecord,
      ): Promise<ChangesetRecord> => {
        let latest = record;
        for (const run of record.testRuns) {
          if (run.status !== 'running' || testRunWorkers.has(run.sessionId)) continue;
          latest = await settleChangesetTestRun(project.root, record.sessionId, run.sessionId, {
            status: 'error',
            error: {
              code: 'TEST_RUN_INTERRUPTED',
              message: 'The AgentUse server restarted while this test run was in flight',
            },
          }) ?? latest;
        }
        return latest;
      };

      const recoverAgentCreationJob = (job: OnboardingModelJob, missingIsInterrupted = false): Promise<void> => {
        const existing = activeInternalJobRecoveries.get(job.id);
        if (existing) return existing;
        const operation = (async () => {
          const project = projectsById.get(job.projectId);
          const recovery = agentCreationRecoveryInputs.get(job.id);
          if (!project || !recovery || job.status !== 'running') return;
          const session = await recoverInternalCreatorSession(project.root, job.sessionId);
          if (!session) {
            if (!missingIsInterrupted) return;
            job.status = 'error';
            job.error = {
              code: 'PREPARATION_INTERRUPTED',
              message: 'Agent preparation was interrupted before its durable session was created',
            };
          } else if (session.status === 'running') {
            return;
          } else if (session.status === 'error') {
            job.status = 'error';
            job.error = session.error;
          } else {
            try {
              await appendAgentDraft(project.root, job.id, {
                source: session.submission.source,
                name: session.submission.name,
                fileName: session.submission.fileName,
                model: session.submission.model,
                ...(session.submission.loadedSkills?.length && { loadedSkills: session.submission.loadedSkills }),
              });
              job.result = { kind: 'draft', jobId: job.id, projectId: project.id };
              job.status = 'completed';
            } catch (error) {
              job.status = 'error';
              job.error = {
                code: error instanceof AgentCreationError ? error.code : 'AGENT_CREATE_FAILED',
                message: toErrorMessage(error),
              };
            }
          }
          // Every route out of `running` settles the durable draft, not just the
          // failed-session one. A job left in error beside a record still saying
          // running is what kept the draft page polling a dead creation.
          if (job.status === 'error' && job.error) {
            await failAgentDraft(project.root, job.id, job.error).catch(() => undefined);
          }
          await persistOnboardingJob(job);
          wakeListHubs();
        })().finally(() => activeInternalJobRecoveries.delete(job.id));
        activeInternalJobRecoveries.set(job.id, operation);
        return operation;
      };

      /** Settle a draft that still says `running` against its durable creator
       *  session. recoverAgentCreationJob only runs on the internal-job route,
       *  which the draft page never calls, so landing straight on that page
       *  after a restart used to poll a record nothing would ever move on. */
      const reconcileAgentDraftRecord = async (
        project: Project,
        record: AgentDraftRecord,
      ): Promise<AgentDraftRecord> => {
        if (record.status !== 'running') return record;
        if (isAgentDraftContinuationInFlight(
          project.id,
          record.jobId,
          draftMutations,
          activeSessionContinuations,
          activeApprovalResumes,
        )) return record;
        let job = onboardingJobs.get(record.jobId);
        let ownerAlive = true;
        if (!job) {
          const persisted = await loadPersistedOnboardingJob(record.jobId);
          if (persisted) {
            job = persisted.job;
            onboardingJobs.set(job.id, job);
            // A running job cannot be pruned from this process's map, so a legacy
            // envelope naming our recycled pid belongs to an earlier daemon.
            ownerAlive = persisted.owner
              ? await isProcessRefAliveAsync(persisted.owner)
              : persisted.ownerPid !== process.pid
                && await isProcessRefAliveAsync({ pid: persisted.ownerPid });
          } else {
            // No envelope survives to name an owner, and this process is not
            // running the job, so nothing is left that could still finish it.
            ownerAlive = false;
            job = {
              id: record.jobId,
              sessionId: record.jobId,
              projectId: project.id,
              kind: 'agent-creation',
              status: 'running',
              phase: 'running',
              model: record.authoringModel,
              createdAt: record.createdAt,
            };
            onboardingJobs.set(job.id, job);
          }
        }
        if (job.kind !== 'agent-creation') return record;
        // The record is the authority on whether this creation is still open, so
        // a terminal envelope beside a running record is stale: a draft reopened
        // for changes, or a daemon that settled one and not the other. Reset it
        // the way request-changes does and let recovery re-derive both.
        if (job.status !== 'running') {
          job.status = 'running';
          delete job.error;
          delete job.result;
        }
        agentCreationRecoveryInputs.set(job.id, await resolveAgentCreationRecovery(record.jobId, record));
        // The durable session is written just after the record. Only call a
        // missing session lost once the draft is past that handoff window.
        const interrupted = !ownerAlive && Date.now() - record.createdAt >= DRAFT_RECOVERY_GRACE_MS;
        await recoverAgentCreationJob(job, interrupted);
        return await readAgentDraftRecord(project.root, record.jobId) ?? record;
      };

      const recoverProjectDiscoveryJob = (job: OnboardingModelJob, missingIsInterrupted = false): Promise<void> => {
        const existing = activeInternalJobRecoveries.get(job.id);
        if (existing) return existing;
        const operation = (async () => {
          const project = projectsById.get(job.projectId);
          if (!project || job.status !== 'running') return;
          const session = await recoverInternalDiscoverySession(project.root, job.sessionId);
          if (!session) {
            if (!missingIsInterrupted) return;
            job.status = 'error';
            job.error = {
              code: 'PREPARATION_INTERRUPTED',
              message: 'Project discovery preparation was interrupted before its durable session was created',
            };
          } else if (session.status === 'running') {
            return;
          } else if (session.status === 'error') {
            job.status = 'error';
            job.error = session.error;
          } else {
            job.status = 'completed';
            job.result = { success: true, model: job.model, ...session.result };
          }
          await persistOnboardingJob(job);
          wakeListHubs();
        })().finally(() => activeInternalJobRecoveries.delete(job.id));
        activeInternalJobRecoveries.set(job.id, operation);
        return operation;
      };

      const reconcileAgentRevisionRecord = async (
        project: Project,
        record: AgentRevisionRecord,
      ): Promise<AgentRevisionRecord> => {
        if (record.status !== 'running') return record;
        // Requesting changes reopens the durable revision before the worker has
        // changed the underlying session from completed to running. During that
        // handoff, the old terminal session status is stale and must not turn
        // the freshly reopened revision into REVISION_NOT_SUBMITTED.
        if (isAgentRevisionContinuationInFlight(
          project.id,
          record.revisionSessionId,
          revisionMutations,
          activeSessionContinuations,
        )) return record;
        const worker = workers.get(project.id);
        if (!worker) return record;
        const status = await worker.getSessionStatusInfo({
          projectRoot: project.root,
          sessionId: record.revisionSessionId,
        });
        if (!status.success) {
          if (status.error.code !== 'SESSION_NOT_FOUND') return record;
          // The durable record is written immediately before its preparing
          // shell. Do not let a concurrent list request classify that tiny
          // in-process handoff window as a restart loss.
          if (Date.now() - record.createdAt < 30_000) return record;
          return await failAgentRevision(project.root, record.revisionSessionId, {
            code: 'REVISION_SESSION_MISSING',
            message: 'The revision session was lost before execution started',
          }) ?? record;
        }
        if (status.session.sessionStatus === 'error') {
          return await failAgentRevision(project.root, record.revisionSessionId, {
            code: status.session.errorCode ?? 'REVISION_SESSION_FAILED',
            message: status.session.errorMessage ?? 'The revision session did not finish successfully',
          }) ?? record;
        }
        if (status.session.sessionStatus === 'completed') {
          return await failAgentRevision(project.root, record.revisionSessionId, {
            code: 'REVISION_NOT_SUBMITTED',
            message: 'The revision session ended without submitting a validated outcome',
          }) ?? record;
        }
        return record;
      };

      // Helper to print hot reload messages
      const printHotReload = (projectId: string, action: "added" | "changed" | "removed", path: string, schedule?: Schedule) => {
        const actionColor = action === "added" ? chalk.green : action === "removed" ? chalk.red : chalk.yellow;
        const label = serveState.multiProject ? `${projectId}/${path}` : path;
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
      const projectWatchers = new Map<string, FileWatcher>();
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
                ? scheduler.add(project.id, relativePath, agent.config.schedule, agent.config.name, scheduleIsEnabled(project, relativePath))
                : undefined;
              printHotReload(project.id, "added", relativePath, schedule);
            } catch (err) {
              // Keep it in agentFiles so it shows as an error row and is retried
              // on the next edit/scan; do not drop it.
              logger.warn(`Hot reload: Failed to parse new agent ${project.id}/${relativePath}: ${toErrorMessage(err)}`);
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
                agent.config.name,
                scheduleIsEnabled(project, relativePath)
              );
              printHotReload(project.id, "changed", relativePath, schedule);

              updateRegistryCounts();
            } catch (err) {
              logger.warn(`Hot reload: Failed to parse changed agent ${project.id}/${relativePath}: ${toErrorMessage(err)}`);
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
        projectWatchers.set(project.id, watcher);
        return watcher;
      };
      for (const project of projects) {
        watchProject(project);
      }

      /** Attach a project without restarting the daemon. The request handler
       * persists its config entry only after this succeeds. */
      const attachProject = async (seed: Omit<Project, 'agentFiles'>): Promise<{ project: Project; rollback: () => Promise<void> }> => {
        const pathOwner = pathSeen.get(seed.root);
        if (pathOwner) throw new Error(`This project is already loaded as "${pathOwner}"`);
        const idPath = idSeen.get(seed.id);
        if (idPath) throw new Error(`A project named "${seed.id}" is already loaded from ${idPath}`);
        await initStorage(seed.root);
        const worker = await spawnProjectWorker(seed);
        const agentFiles = await glob("**/*.agentuse", {
          cwd: seed.scopeRoot,
          ignore: ["node_modules/**", "tmp/**", ".git/**"],
        });
        const project: Project = { ...seed, agentFiles };
        let watcher: FileWatcher | undefined;
        const rollback = async (): Promise<void> => {
          if (watcher) {
            await watcher.close().catch(() => {});
            const watcherIndex = fileWatchers.indexOf(watcher);
            if (watcherIndex >= 0) fileWatchers.splice(watcherIndex, 1);
            projectWatchers.delete(seed.id);
          }
          worker.shutdown();
          workers.delete(seed.id);
          workerReadyAt.delete(seed.id);
          for (const schedule of scheduler.list().filter((item) => item.projectId === seed.id)) {
            scheduler.removeByAgentPath(seed.id, schedule.agentPath);
          }
          if (schedulerLocksHeld.has(seed.id)) {
            releaseSchedulerLock(seed.root);
            schedulerLocksHeld.delete(seed.id);
          }
          const seedIndex = projectSeeds.indexOf(seed);
          if (seedIndex >= 0) projectSeeds.splice(seedIndex, 1);
          const projectIndex = projects.indexOf(project);
          if (projectIndex >= 0) projects.splice(projectIndex, 1);
          projectsById.delete(seed.id);
          agentCounts.delete(seed.id);
          pathSeen.delete(seed.root);
          idSeen.delete(seed.id);
          serveState.multiProject = projects.length > 1;
          updateRegistryCounts();
        };
        try {
          projectSeeds.push(seed);
          projects.push(project);
          projectsById.set(seed.id, project);
          try {
            pausedSchedulesByProject.set(seed.id, await loadPausedSchedules(seed.root));
          } catch (error) {
            logger.warn(`Could not load schedule state for ${seed.id}: ${toErrorMessage(error)}`);
            pausedSchedulesByProject.set(seed.id, new Set());
          }
          agentCounts.set(seed.id, agentFiles.length);
          pathSeen.set(seed.root, seed.id);
          idSeen.set(seed.id, seed.root);
          serveState.multiProject = projects.length > 1;
          if (projects.length === 1) serveState.effectiveDefault = undefined;
          for (const agentFile of agentFiles) {
            try {
              const agentPath = resolveScopedAgentPath(seed, agentFile);
              const agent = await parseAgent(agentPath);
              if (agent.config.schedule && canArmSchedules(seed.id, seed.root)) {
                scheduler.add(seed.id, agentFile, agent.config.schedule, agent.config.name, scheduleIsEnabled(seed, agentFile));
              }
            } catch (err) {
              logger.warn(`Failed to load agent ${seed.id}/${agentFile}: ${toErrorMessage(err)}`);
            }
          }
          watcher = watchProject(project);
          updateRegistryCounts();
          orphanReconcileLoop.runNow();
          logger.info(`Project ${seed.id}: ${seed.scopeRoot}`);
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

        if (!serveState.multiProject) {
          return { project: projects[0]! };
        }

        if (serveState.effectiveDefault) {
          return { project: projectsById.get(serveState.effectiveDefault)! };
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
        // collapse to `serveState.effectiveDefault` here: that preference is for routing
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
        // A session id lives in exactly one project, so when the caller did not
        // say which, ask every worker at once instead of one after another; the
        // first project (in configured order) that knows the id still wins.
        const probes = await Promise.all(selectedProjects.map(async (project) => {
          const projectWorker = workers.get(project.id);
          if (!projectWorker) return { project, info: null };
          const info = await projectWorker.getApprovalInfo({
            projectRoot: project.root,
            sessionId,
            trusted: true,
          });
          return { project, info };
        }));
        for (const { project, info } of probes) {
          if (!info) {
            nonSessionErrors.push({ status: 500, code: "WORKER_UNAVAILABLE", message: `No worker for project ${project.id}` });
            continue;
          }
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
        const probes = await Promise.all(selectedProjects.map(async (project) => {
          const projectWorker = workers.get(project.id);
          if (!projectWorker) return { project, info: null };
          const info = await projectWorker.getSessionStatusInfo({
            projectRoot: project.root,
            sessionId,
          });
          return { project, info };
        }));
        for (const { project, info } of probes) {
          if (!info) {
            nonSessionErrors.push({ status: 500, code: "WORKER_UNAVAILABLE", message: `No worker for project ${project.id}` });
            continue;
          }
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
      // The last background resume/continuation failure per session (keyed
      // `${projectId}:${sessionId}`). These operations are fire-and-forget after
      // the 202 response, so this is the only way their eventual failure reaches
      // the session page instead of appearing to fall back silently to its prior
      // status. Cleared when a fresh attempt starts or succeeds.
      const backgroundSessionFailures = new Map<string, BackgroundSessionFailure>();
      // Attach any recorded failure to the session payload. Approval failures are
      // relevant only while their gate remains open; continuation failures stay
      // visible on the ended session they failed to restart.
      const applyResumeError = <T extends { errorMessage?: string; sessionStatus?: string }>(
        approvalObj: T,
        activeKey: string
      ): T => {
        return applyBackgroundSessionFailure(approvalObj, backgroundSessionFailures.get(activeKey));
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
        if (info.approval.approvalKind === 'tool_approval') {
          throw new Error('Remembered learnings are not supported for generic tool approvals');
        }
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
          logger.warn(`Failed to persist remembered learning: ${toErrorMessage(err)}`);
        });
      };

      // Read + normalize the optional `remember` body field (shared by both
      // decision endpoints).
      const readRememberField = (body: Record<string, unknown>): string | undefined =>
        typeof body.remember === 'string' && body.remember.trim().length > 0
          ? body.remember.trim()
          : undefined;

      // Revision sessions persist their product state separately from the
      // ordinary session transcript. Keep that state in sync for every way a
      // suspended/completed session can resume, not only for its first run.
      const settleAgentRevisionExecution = async (
        project: Project,
        sessionId: string,
        result: WorkerExecuteResult | WorkerExecuteError,
      ): Promise<void> => {
        const record = await readAgentRevisionRecord(project.root, sessionId);
        if (!record || record.status !== 'running') return;

        const job = onboardingJobs.get(sessionId);
        if (!result.success) {
          await failAgentRevision(project.root, sessionId, result.error);
          if (job?.kind === 'agent-revision') {
            job.status = 'error';
            job.error = result.error;
          }
          return;
        }
        if (result.result.finishReason === 'suspended' || result.result.approvalUrl) return;

        // A successful revision must finish through submit_agent_revision.
        // Reaching a terminal turn without it is an invalid internal outcome,
        // otherwise the originating run would display "running" forever.
        const error = {
          code: 'REVISION_NOT_SUBMITTED',
          message: 'The revision session ended without submitting a validated outcome',
        };
        await failAgentRevision(project.root, sessionId, error);
        if (job?.kind === 'agent-revision') {
          job.status = 'error';
          job.error = error;
        }
      };

      /** Same contract for a continued change set session: the proposal is
       *  appended by `submit_changes`, so a terminal turn without one leaves the
       *  record in error rather than running forever. */
      const settleChangesetExecution = async (
        project: Project,
        sessionId: string,
        result: WorkerExecuteResult | WorkerExecuteError,
      ): Promise<void> => {
        const failure = await settleChangesetSession(project.root, sessionId, result);
        if (!failure) return;
        const job = onboardingJobs.get(sessionId);
        if (job?.kind === 'changeset') {
          job.status = 'error';
          job.error = failure;
          await persistOnboardingJob(job).catch(() => undefined);
        }
      };

      /** Record the outcome of a continued creator session as the next numbered
       *  draft. Mirrors settleAgentRevisionExecution: the continue itself is
       *  generic, and each internal feature settles its own durable record. */
      const settleAgentDraftExecution = async (
        project: Project,
        sessionId: string,
        result: WorkerExecuteResult | WorkerExecuteError,
      ): Promise<void> => {
        const record = await readAgentDraftRecord(project.root, sessionId);
        if (!record || record.status !== 'running' || record.drafts.length === 0) return;

        const job = onboardingJobs.get(sessionId);
        if (!result.success) {
          await failAgentDraft(project.root, sessionId, result.error);
          if (job?.kind === 'agent-creation') {
            job.status = 'error';
            job.error = result.error;
            await persistOnboardingJob(job);
          }
          return;
        }
        if (result.result.finishReason === 'suspended' || result.result.approvalUrl) return;

        if (
          result.result.agentSource
          && result.result.authoredAgentName
          && result.result.authoredAgentFileName
        ) {
          await appendAgentDraft(project.root, sessionId, {
            source: result.result.agentSource,
            name: result.result.authoredAgentName,
            fileName: result.result.authoredAgentFileName,
            model: record.authoringModel,
            ...(result.result.headline && { reply: result.result.headline }),
            ...(result.result.authoredAgentLoadedSkills?.length && {
              loadedSkills: result.result.authoredAgentLoadedSkills,
            }),
          });
          if (job?.kind === 'agent-creation') {
            job.status = 'completed';
            job.result = { kind: 'draft', jobId: sessionId, projectId: project.id };
            await persistOnboardingJob(job);
          }
          return;
        }

        // A creator turn that ends without resubmitting leaves the operator with
        // no new draft to review, so it is recorded as a failed turn rather than
        // silently leaving the panel spinning.
        const error = {
          code: 'DRAFT_NOT_SUBMITTED',
          message: 'The creator finished the change request without submitting a new draft',
        };
        await failAgentDraft(project.root, sessionId, error);
        if (job?.kind === 'agent-creation') {
          job.status = 'error';
          job.error = error;
          await persistOnboardingJob(job);
        }
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
        backgroundSessionFailures.delete(activeKey);
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
        const slackStatusPrompt = approvalSlackStatusPrompt(info.approval);
        if (slackChannelMessage && slackStatusPrompt) {
          void updateSlackApprovalRequestStatus({
            botToken: slackBotToken!,
            channelId: slackChannelMessage.channelId,
            ts: slackChannelMessage.ts,
            ...(slackChannelMessage.actionTs && { actionTs: slackChannelMessage.actionTs }),
            prompt: slackStatusPrompt,
            sessionId: targetSessionId,
            projectId: project.id,
            agentName: info.approval.agent.name,
            ...(slackChannelMessage.approvalUrl && { approvalUrl: slackChannelMessage.approvalUrl }),
            ...(info.approval.expiresAt && { expiresAt: new Date(info.approval.expiresAt).toISOString() }),
            status: 'resuming',
            decision: status
          }).catch((err) => logger.warn(`Slack approval status update failed: ${toErrorMessage(err)}`));
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
        })).then(async result => {
          await settleAgentRevisionExecution(project, targetSessionId, result).catch((err) => {
            logger.warn(`Failed to settle revision session ${targetSessionId}: ${toErrorMessage(err)}`);
          });
          if (!result.success) {
            const alreadyCompleted = /SESSION_NOT_SUSPENDED:\s*completed/i.test(result.error.message);
            if (alreadyCompleted) {
              backgroundSessionFailures.delete(activeKey);
              approvalLog.resumeCompleted(targetSessionId, Date.now() - resumeStart);
              return;
            }
            // Surface the failure on the still-pending gate (the 202 already went out).
            backgroundSessionFailures.set(activeKey, { status, message: result.error.message, at: Date.now() });
            approvalLog.resumeFailed(targetSessionId, Date.now() - resumeStart, result.error.message);
            logger.warn(`Approval resume ${targetSessionId} failed: ${result.error.message}`);
            try {
              params.onResumeFailure?.();
            } catch (hookErr) {
              logger.warn(`Approval resume failure hook for ${targetSessionId} failed: ${toErrorMessage(hookErr)}`);
            }
            if (slackChannelMessage && slackStatusPrompt) {
              void updateSlackApprovalRequestStatus({
                botToken: slackBotToken!,
                channelId: slackChannelMessage.channelId,
                ts: slackChannelMessage.ts,
                ...(slackChannelMessage.actionTs && { actionTs: slackChannelMessage.actionTs }),
                prompt: slackStatusPrompt,
                sessionId: targetSessionId,
                projectId: project.id,
                agentName: info.approval.agent.name,
                ...(slackChannelMessage.approvalUrl && { approvalUrl: slackChannelMessage.approvalUrl }),
                ...(info.approval.expiresAt && { expiresAt: new Date(info.approval.expiresAt).toISOString() }),
                status: 'failed',
                decision: status,
                error: result.error.message
              }).catch((err) => logger.warn(`Slack approval status update failed: ${toErrorMessage(err)}`));
            }
          } else {
            backgroundSessionFailures.delete(activeKey);
            approvalLog.resumeCompleted(targetSessionId, Date.now() - resumeStart);
            if (slackChannelMessage && slackStatusPrompt) {
              void updateSlackApprovalRequestStatus({
                botToken: slackBotToken!,
                channelId: slackChannelMessage.channelId,
                ts: slackChannelMessage.ts,
                ...(slackChannelMessage.actionTs && { actionTs: slackChannelMessage.actionTs }),
                prompt: slackStatusPrompt,
                sessionId: targetSessionId,
                projectId: project.id,
                agentName: info.approval.agent.name,
                ...(slackChannelMessage.approvalUrl && { approvalUrl: slackChannelMessage.approvalUrl }),
                ...(info.approval.expiresAt && { expiresAt: new Date(info.approval.expiresAt).toISOString() }),
                status: 'completed',
                decision: status
              }).catch((err) => logger.warn(`Slack approval status update failed: ${toErrorMessage(err)}`));
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
        backgroundSessionFailures.delete(activeKey);
        const continueStart = Date.now();
        approvalLog.continueStarted(sessionId);
        const continuePromise = Promise.resolve()
          .then(() => projectWorker.continueSession({
            projectRoot: project.root,
            sessionId,
            prompt,
            debug: options.debug,
          }))
          .then(async result => {
            await settleAgentRevisionExecution(project, sessionId, result).catch((err) => {
              logger.warn(`Failed to settle revision session ${sessionId}: ${toErrorMessage(err)}`);
            });
            await settleAgentDraftExecution(project, sessionId, result).catch((err) => {
              logger.warn(`Failed to settle draft session ${sessionId}: ${toErrorMessage(err)}`);
            });
            await settleChangesetExecution(project, sessionId, result).catch((err) => {
              logger.warn(`Failed to settle change set session ${sessionId}: ${toErrorMessage(err)}`);
            });
            if (!result.success) {
              backgroundSessionFailures.set(activeKey, {
                status: 'continue',
                message: result.error.message,
                at: Date.now(),
              });
              approvalLog.continueFailed(sessionId, Date.now() - continueStart, result.error.message);
              logger.warn(`Session continue ${sessionId} failed: ${result.error.message}`);
              return;
            }
            backgroundSessionFailures.delete(activeKey);
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

      // Parent-facing recovery for a model-stalled delegated child. The user
      // resumes the workflow they started; the worker resolves and continues
      // the failed child before walking its result back up automatically.
      const startCascadeRetry = (
        res: ServerResponse,
        params: { project: Project; sessionId: string }
      ): void => {
        const { project, sessionId } = params;
        const projectWorker = workers.get(project.id)!;
        notifiedFinishedSessions.delete(sessionId);
        const activeKey = `${project.id}:${sessionId}`;
        backgroundSessionFailures.delete(activeKey);
        const retryStart = Date.now();
        approvalLog.continueStarted(sessionId);
        const retryPromise = Promise.resolve()
          .then(() => projectWorker.retryCascade(project.root, sessionId))
          .then((result) => {
            if (!result.success) {
              backgroundSessionFailures.set(activeKey, {
                status: 'continue',
                message: result.error.message,
                at: Date.now(),
              });
              approvalLog.continueFailed(sessionId, Date.now() - retryStart, result.error.message);
              logger.warn(`Session resume ${sessionId} failed: ${result.error.message}`);
              return;
            }
            backgroundSessionFailures.delete(activeKey);
            approvalLog.continueCompleted(sessionId, Date.now() - retryStart);
          })
          .finally(() => {
            if (activeSessionContinuations.get(activeKey) === retryPromise) {
              activeSessionContinuations.delete(activeKey);
            }
            void refreshProjectLists(project);
            wakeListHubs();
          });
        activeSessionContinuations.set(activeKey, retryPromise);
        wakeListHubs();

        res.writeHead(202, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ sessionId, status: "resuming" }));
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
        }).catch((err) => logger.warn(`Slack approval status update failed: ${toErrorMessage(err)}`));
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
        })().catch((err) => logger.warn(`Slack approval thread note failed: ${toErrorMessage(err)}`));
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
        })().catch((err) => logger.warn(`Slack run thread note failed: ${toErrorMessage(err)}`));
      };

      const continueSlackRunThread = async (comment: SlackApprovalThreadComment): Promise<SlackRunThreadCommentResult> => {
        let sessionId: string | undefined;
        try {
          sessionId = await sessionIdForLocalApprovalThread(comment);
        } catch (err) {
          logger.warn(`Slack run thread lookup failed: ${toErrorMessage(err)}`);
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
          .catch((err) => logger.warn(`Slack approval socket failed to start: ${toErrorMessage(err)}`));
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
              const label = serveState.multiProject ? `${project.id}/${item.agentName}` : item.agentName;
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
                }).catch((err) => logger.debug(`Slack expired update failed: ${toErrorMessage(err)}`));
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
      const pushService = new PushService(getAgentuseDataDir(), (msg) => console.log(msg));
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
          (s) => isExecutingSessionStatus(s.status) || s.subagentActive === true
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
      // A revision session's purpose is immutable. Cache both hits and misses so
      // the live Sessions SSE cadence does not repeatedly probe the filesystem
      // for ordinary sessions.
      const sessionPurposeCache = new Map<string, SessionPurpose | null>();

      /** What an AgentUse-owned session is for (a change set or a legacy agent
       *  revision), or null for an ordinary run. Cached per session so the
       *  sessions list and the approvals list share one disk read. */
      const sessionPurposeFor = async (
        project: { id: string; root: string } | undefined,
        sessionId: string,
      ): Promise<SessionPurpose | null> => {
        if (!project) return null;
        const cacheKey = `${project.id}\0${sessionId}`;
        const cached = sessionPurposeCache.get(cacheKey);
        if (cached !== undefined) return cached;
        let purpose: SessionPurpose | null = null;
        try {
          // Change sets first: they are the successor record, and a session
          // never carries both.
          const changeset = await readChangesetRecord(project.root, sessionId);
          if (changeset) {
            purpose = changesetSessionPurpose(project.id, changeset);
          } else {
            const revision = await readAgentRevisionRecord(project.root, sessionId);
            purpose = revision ? agentRevisionSessionPurpose(revision) : null;
          }
        } catch (error) {
          logger.warn(`Could not classify session ${sessionId}: ${toErrorMessage(error)}`);
        }
        sessionPurposeCache.set(cacheKey, purpose);
        return purpose;
      };
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
        // ?metric=<name>: runs that recorded this record_metric name (the Home
        // tile's way in). ?results=unseen: finished runs with results nobody has
        // opened yet, the "don't miss the good ones" queue.
        const metricFilter = (requestUrl.searchParams.get('metric') ?? '').trim() || undefined;
        const resultsFilter = parseSessionResultsFilter(requestUrl.searchParams.get('results') ?? undefined);
        const updatedAfter = sessionListUpdatedAfter(requestUrl);
        const daysFilter = sessionDaysFilterValue(requestUrl);
        const detail = requestUrl.searchParams.get('detail');
        // Free-text lookup over agent identity and final output text. Matching the
        // output means the answer to "which run said X" no longer requires opening
        // runs one by one, which is the only reason this list gets opened at all.
        const searchQuery = (requestUrl.searchParams.get('q') ?? '').trim().toLowerCase();
        const rawLimit = requestUrl.searchParams.get('limit');
        const parsedLimit = rawLimit === null ? undefined : Number(rawLimit);
        const requestedLimit = parsedLimit !== undefined && Number.isFinite(parsedLimit) && parsedLimit > 0
          ? Math.min(Math.floor(parsedLimit), LIST_PAGE_MAX_LIMIT)
          : rawLimit === null ? undefined : LIST_PAGE_DEFAULT_LIMIT;
        // Results are often recorded by a delegated sub-agent under its own
        // session id, while the run a human opens is the top-level one. Any view
        // that shows or filters by results therefore needs the sub-agent rows
        // too, only to map each child back to the run that delegated it.
        const needSubagentIndex = detail === 'feed' || Boolean(metricFilter) || Boolean(resultsFilter);
        const canPrelimit = requestedLimit !== undefined &&
          !requestUrl.searchParams.get('cursor') &&
          !agentFilter && !statusFilter && !triageFilter && !triggerFilter && !approvalFilter && !searchQuery &&
          !needSubagentIndex;

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
              ...((approvalFilter || needSubagentIndex) && { includeSubagents: true }),
              // The trim is an IPC-payload optimization (the worker has already
              // read every summary), so widen it to the count scan: chips that
              // report only the first page's split would be worse than no chips.
              ...(canPrelimit && { limit: Math.max(requestedLimit, SESSION_COUNT_SCAN_LIMIT) }),
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

        // child session id -> the top-level run it descends from, per project.
        const rootBySessionByProject = new Map<string, Map<string, string>>();
        for (const result of projectResults) {
          if (result.error) {
            errors.push({ projectId: result.project.id, message: result.error });
            continue;
          }
          if (needSubagentIndex) {
            const parentOf = new Map<string, string>();
            for (const session of result.sessions ?? []) {
              if (session.parentSessionId) parentOf.set(session.sessionId, session.parentSessionId);
            }
            const rootOf = new Map<string, string>();
            for (const childId of parentOf.keys()) {
              let current = childId;
              const seen = new Set<string>();
              while (parentOf.has(current) && !seen.has(current)) {
                seen.add(current);
                current = parentOf.get(current)!;
              }
              rootOf.set(childId, current);
            }
            rootBySessionByProject.set(result.project.id, rootOf);
          }
          for (const session of result.sessions ?? []) {
            // Sub-agent rows were only fetched for the index above; the list
            // itself stays top-level unless an approval filter asked for them.
            if (needSubagentIndex && !approvalFilter && session.agent.isSubAgent) continue;
            if (!sessionMatchesMockFilter(session, mockFilter)) continue;
            // Status is applied AFTER the chip counts are taken, so "Done 128"
            // stays true while the reader is looking at the Failed subset.
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
        const isLive = (s: SessionSummary) => isExecutingSessionStatus(s.status) || s.subagentActive === true;
        rows.sort((a, b) =>
          (isLive(a.session) ? 0 : 1) - (isLive(b.session) ? 0 : 1) ||
          b.session.updatedAt - a.session.updatedAt ||
          b.session.createdAt - a.session.createdAt ||
          a.projectId.localeCompare(b.projectId) ||
          a.session.sessionId.localeCompare(b.session.sessionId)
        );
        // Final assistant text, cache-first. Search needs it for rows the page
        // may never show, and feed detail needs it for the page itself, so both
        // go through one resolver (and one cache) rather than two walks of disk.
        const resolveFinalResponses = async (
          targets: ProjectSessionRow[]
        ): Promise<Map<string, string | undefined>> => {
          const finalResponses = new Map<string, string | undefined>();
          const missingByProject = new Map<string, ProjectSessionRow[]>();

          for (const row of targets) {
            const cacheKey = `${row.projectId}\0${row.session.sessionId}`;
            const cached = sessionFinalResponseCache.get(cacheKey);
            const stable = row.session.status !== 'preparing' && row.session.status !== 'running';
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
              if (row.session.status !== 'preparing' && row.session.status !== 'running') {
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
          return finalResponses;
        };

        // Search runs over the whole window, not the current page, so a match on
        // a run from Tuesday is findable without paging to it. Agent identity is
        // matched in memory; only the rows that miss on identity pay for a
        // transcript read, and that scan is capped so one broad query cannot walk
        // an unbounded history.
        let scopedRows = rows;
        if (searchQuery) {
          const matchesIdentity = (row: ProjectSessionRow): boolean =>
            sessionMatchesSearchIdentity(row.session, searchQuery);
          const needsText = rows.filter((row) => !matchesIdentity(row)).slice(0, SESSION_SEARCH_SCAN_LIMIT);
          const texts = await resolveFinalResponses(needsText);
          const textMatches = new Set<string>();
          for (const row of needsText) {
            const key = `${row.projectId}\0${row.session.sessionId}`;
            if (texts.get(key)?.toLowerCase().includes(searchQuery)) textMatches.add(key);
          }
          scopedRows = rows.filter((row) =>
            matchesIdentity(row) || textMatches.has(`${row.projectId}\0${row.session.sessionId}`));
        }

        // Results (record_metric facts) come from each project's metrics store,
        // keyed by session. One cached read per project, so attaching them to a
        // page, or filtering a whole window by them, costs no per-row I/O.
        const attachResults = async (targets: ProjectSessionRow[]): Promise<ProjectSessionRow[]> => {
          const byProject = new Map<string, Map<string, SessionResult[]>>();
          await Promise.all([...new Set(targets.map((row) => row.projectId))].map(async (projectId) => {
            const project = projects.find((candidate) => candidate.id === projectId);
            if (!project) return;
            byProject.set(projectId, await readSessionResults(project.root));
          }));
          // Fold each child's results into its top-level run.
          const byRoot = new Map<string, Map<string, SessionResult[]>>();
          for (const [projectId, bySession] of byProject) {
            const rootOf = rootBySessionByProject.get(projectId);
            const folded = new Map<string, SessionResult[]>();
            for (const [sessionId, results] of bySession) {
              const rootId = rootOf?.get(sessionId) ?? sessionId;
              const list = folded.get(rootId) ?? [];
              list.push(...results);
              folded.set(rootId, list);
            }
            for (const list of folded.values()) list.sort((a, b) => b.at - a.at);
            byRoot.set(projectId, folded);
          }
          return targets.map((row) => {
            const results = byRoot.get(row.projectId)?.get(row.session.sessionId);
            return results && results.length > 0 ? { ...row, session: { ...row.session, results } } : row;
          });
        };
        if (metricFilter || resultsFilter) {
          scopedRows = (await attachResults(scopedRows)).filter((row) =>
            sessionMatchesMetricFilter(row.session, metricFilter) &&
            sessionMatchesResultsFilter(row.session, resultsFilter));
        }

        // Counts describe the window as the reader narrowed it by search/agent,
        // but BEFORE the status chip: a chip that changed its own number when
        // clicked could never tell you how big the other buckets are.
        const counts = sessionStatusCounts(scopedRows.map((row) => row.session));

        const statusRows = statusFilter
          ? scopedRows.filter((row) => sessionMatchesStatusFilter(row.session, statusFilter))
          : scopedRows;

        // Fingerprint on the window FILTER, not the resolved updatedAfter
        // cutoff: the cutoff is minute-quantized (listWindowNow), so embedding
        // it would silently expire every cursor at the next minute boundary and
        // restart Load more from page 1. A cursor row that slides out of the
        // window is still caught by cursorPage's row-lookup fallback.
        const fingerprint = ['sessions', daysFilter, agentFilter ?? '', statusFilter ?? '', triageFilter ?? '', triggerFilter ?? '', approvalFilter ?? '', searchQuery, metricFilter ?? '', resultsFilter ?? ''].join('\0');
        const page = cursorPage(requestUrl, fingerprint, statusRows, (row) =>
          `${row.session.createdAt}\0${row.projectId}\0${row.session.sessionId}`
        );

        let pageItems = page.items;
        if (detail === 'feed') {
          pageItems = await attachResults(pageItems);
          const finalResponses = await resolveFinalResponses(pageItems);
          pageItems = pageItems.map((row) => {
            const finalResponse = finalResponses.get(`${row.projectId}\0${row.session.sessionId}`);
            return finalResponse === undefined
              ? row
              : { ...row, session: { ...row.session, finalResponse } };
          });
        }

        pageItems = await Promise.all(pageItems.map(async (row) => {
          const project = projects.find((candidate) => candidate.id === row.projectId);
          const purpose = await sessionPurposeFor(project, row.session.sessionId);
          const runPath = project
            ? toAgentRunPath(project, row.session.agent.filePath)
            : undefined;
          if (!purpose && !runPath) return row;
          return {
            ...row,
            session: {
              ...row.session,
              ...(purpose && { purpose }),
              ...(runPath && { agent: { ...row.session.agent, runPath } }),
            },
          };
        }));

        while (sessionPurposeCache.size > 2_000) {
          const oldest = sessionPurposeCache.keys().next().value;
          if (oldest === undefined) break;
          sessionPurposeCache.delete(oldest);
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
            ...(searchQuery && { q: searchQuery }),
            ...(metricFilter && { metric: metricFilter }),
            ...(resultsFilter && { results: resultsFilter }),
            counts,
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
            // A change set has its own review page (proposal + pending
            // question side by side); send the reviewer there, not to the log.
            const purpose = await sessionPurposeFor(result.project, approval.sessionId);
            const reviewHref = purpose?.kind === 'changeset' ? purpose.href : undefined;
            rows.push({ projectId: result.project.id, approval: reviewHref ? { ...approval, reviewHref } : approval });
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
      // Everything the route groups in serve/routes/ need, gathered once.
      // Same objects and closures the inline route table used to close over.
      const ctx: ServeContext = {
        options,
        state: serveState,
        // `wakeListHubs` is assigned after its declaration, so keep it late-bound.
        wakeListHubs: () => wakeListHubs(),
        apiKey,
        serverUrl,
        effectivePublicUrl,
        effectiveHost,
        effectiveHideAgentSource,
        brandNameCfg,
        manifestJson,
        serverStartTime,
        projects,
        projectsById,
        projectSeeds,
        agentCounts,
        idSeen,
        pathSeen,
        fileWatchers,
        projectWatchers,
        attachProject,
        onboardingProjectInfo,
        updateRegistryCounts,
        refreshProjectLists,
        resolveRequestProject,
        workers,
        testRunWorkers,
        workerReadyAt,
        resetWorkerProviderPlugins,
        scheduler,
        pausedSchedulesByProject,
        schedulerLocksHeld,
        scheduleIsEnabled,
        canArmSchedules,
        orphanReconcileLoop,
        staticAssets,
        pushService,
        notificationHub,
        approvalHub,
        approvalListHub,
        sessionListHub,
        deliverNotification,
        findApprovalInfo,
        findSessionInfo,
        findSessionStatusInfo,
        sessionPurposeFor,
        buildSessionsPayload,
        buildApprovalListPayload,
        activeApprovalResumes,
        activeSessionContinuations,
        activeCascadeRecoveries,
        backgroundSessionFailures,
        loggedApprovalRequests,
        notifiedFinishedSessions,
        approvalActionSessionId,
        applyResumeError,
        validateDecisionChoice,
        startApprovalResume,
        startSessionContinue,
        startCascadeRetry,
        readRememberField,
        resolveRememberedLearning,
        persistRememberedLearning,
        onboardingJobs,
        agentCreationRecoveryInputs,
        internalViewCleanups,
        revisionMutations,
        draftMutations,
        changesetMutations,
        preferredAgentCreationModel,
        cleanupInternalView,
        pruneOnboardingJobs,
        persistOnboardingJob,
        loadPersistedOnboardingJob,
        beginInternalAgentJob,
        recoverAgentCreationJob,
        recoverProjectDiscoveryJob,
        resolveAgentCreationRecovery,
        finishAgentCreation,
        draftViewPayload,
        reconcileAgentDraftRecord,
        reconcileAgentRevisionRecord,
        startMockTestRun,
        startChangesetTestRun,
        settleStaleChangesetTestRuns,
      };

      const server = createServer(guardRequestHandler(async (req, res) => {
        // Every response: the dashboard may only be framed by itself (its
        // approve and run buttons must not be clickjackable from another
        // site), session-token URLs never leave as a cross-site Referer, and
        // browsers never sniff a response into a script.
        res.setHeader("Content-Security-Policy", "frame-ancestors 'self'");
        res.setHeader("X-Frame-Options", "SAMEORIGIN");
        res.setHeader("Referrer-Policy", "same-origin");
        res.setHeader("X-Content-Type-Options", "nosniff");

        if (!apiKey && !isExposedHost(effectiveHost) && !isAllowedRequestHost(req.headers.host, effectivePublicUrl)) {
          sendError(res, 403, "HOST_NOT_ALLOWED", `This daemon has no API key and only answers requests addressed to localhost or its public URL (${effectivePublicUrl}). If you reach it under another name, set serve.publicUrl or --public-url to that address.`);
          return;
        }

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

        // Per-request facts the route groups in serve/routes/ share.
        const rq: ServeRequest = { req, res, requestUrl, isApi, routePath, requestOrigin, crossOrigin, sessionAuthorized };

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

        // The route table, in the order the inline if-chain ran it. Each group
        // answers the request or hands the next one its turn.
        if (await pushRoutes(ctx, rq)) return;
        if (await homeRoutes(ctx, rq)) return;
        if (await agentRoutes(ctx, rq)) return;
        if (await scheduleRoutes(ctx, rq)) return;
        if (await storeRoutes(ctx, rq)) return;
        if (await sessionRoutes(ctx, rq)) return;
        if (await sessionLearningRoutes(ctx, rq)) return;
        if (await agentLearningRoutes(ctx, rq)) return;
        if (await sessionLifecycleRoutes(ctx, rq)) return;
        if (await notificationRoutes(ctx, rq)) return;
        if (await approvalRoutes(ctx, rq)) return;
        if (await resumeRoutes(ctx, rq)) return;
        if (await providerRoutes(ctx, rq)) return;
        if (await agentCreateRoutes(ctx, rq)) return;
        if (await projectRoutes(ctx, rq)) return;
        if (await revisionRoutes(ctx, rq)) return;
        if (await onboardingRoutes(ctx, rq)) return;
        if (await runRoutes(ctx, rq)) return;
      }, (err, req) => {
        logger.error(`serve: ${req.method} ${req.url?.split('?')[0]} failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`);
      }));

      // Graceful shutdown
      const shutdown = createIdempotentShutdown(async () => {
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
          totalExecutions: serveState.totalExecutions,
          successfulExecutions: serveState.successfulExecutions,
          failedExecutions: serveState.failedExecutions,
        });
        await telemetry.shutdown();

        server.close(() => {
          console.log("Server closed");
          const done = logHandle ? logHandle.close() : Promise.resolve();
          done.finally(() => process.exit(0));
        });
      });

      watchDesktopLifetime(desktopLifetimeFd, () => void shutdown());

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
            logger.warn(`Could not open server log file: ${toErrorMessage(err)}`);
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
          version: getBuildInfo().version,
          projects: registryProjects,
          ...(logFilePath && { logFile: logFilePath }),
          ...(desktopSupervisor && { supervisor: desktopSupervisor }),
        });

        printLogo();

        // Server info
        console.log(`  ${chalk.dim("Server")}    ${chalk.cyan(serverUrl)}`);
        console.log(`  ${chalk.dim("Public")}    ${chalk.cyan(effectivePublicUrl)}`);
        if (projects.length === 0) {
          console.log(`  ${chalk.dim("Projects")}  ${chalk.dim("None yet — create one in the Web UI")}`);
          console.log(`  ${chalk.dim("Storage")}   ${chalk.dim(join(getManagedProjectsRoot(), '<project>'))}`);
        } else if (!serveState.multiProject) {
          console.log(`  ${chalk.dim("AgentUse data")}`);
          console.log(`    ${chalk.dim("Global")}  ${chalk.dim("~/.agentuse")}`);
          console.log(`    ${chalk.dim("Project")} ${chalk.dim(join(projects[0]!.root, '.agentuse'))}`);
          console.log(`  ${chalk.dim("Scope")}     ${projects[0]!.scopeRoot}`);
        } else {
          console.log(`  ${chalk.dim("Projects")}  ${projects.length}`);
          for (const p of projects) {
            const scheduleN = schedules.filter((s) => s.projectId === p.id).length;
            const marker = serveState.effectiveDefault === p.id ? chalk.green(' (default)') : '';
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
          if (!serveState.multiProject) {
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
        if (!serveState.multiProject && firstProject && firstProject.agentFiles.length > 0) {
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

  const formatProjects = (s: ServerEntry): string[] => {
    if (s.projects && s.projects.length > 0) {
      if (s.projects.length === 1) {
        return [truncatePath(s.projects[0].root, widths[2])];
      }
      return s.projects.map((project) => project.id);
    }
    return [truncatePath(s.projectRoot, widths[2])];
  };

  const blocks: string[] = [...renderCliTableHeader(headers, widths)];
  for (const s of servers) {
    const projects = formatProjects(s);
    blocks.push(formatCliRow([
      String(s.pid),
      String(s.port),
      projects[0],
      String(s.agentCount),
      String(s.scheduleCount),
      formatUptime(s.startTime),
    ], widths));
    for (const project of projects.slice(1)) {
      blocks.push(formatCliRow(["", "", project, "", "", ""], widths).trimEnd());
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
  const res = await fetch(`${serverBaseUrl(server)}${path}`, { headers: daemonRequestHeaders() });
  if (!res.ok) throw await daemonResponseError(res, `Request to ${path}`);
  return res.json();
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
        console.error(chalk.red(toErrorMessage(err)));
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
        console.error(chalk.red(toErrorMessage(err)));
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
  annotateAgentScheduleStates,
  formatPsTable,
  formatAgentsTable,
  formatSchedulesTable,
  bareServeMigrationWarning,
  canContinueApprovalSession,
  approvalSlackStatusPrompt,
  applyBackgroundSessionFailure,
  isAgentRevisionContinuationInFlight,
  isAgentDraftContinuationInFlight,
  isEndedSessionStatus,
  approvalListCreatedAfter,
  isPendingApprovalVisible,
  APPROVAL_LIST_SSE_INTERVAL_MS,
  sessionListUpdatedAfter,
  SESSION_LIST_SSE_INTERVAL_MS,
  sessionMatchesAgentFilter,
  sessionMatchesMetricFilter,
  sessionMatchesResultsFilter,
  parseSessionResultsFilter,
  agentRevisionSessionPurpose,
  changesetSessionPurpose,
  changesetReviewHref,
  toAgentRunPath,
  changesetListSummary,
  changesetAcceptsChangeRequest,
  activeChangesetForTarget,
  resolveChangesetTargetPath,
  ChangesetTargetError,
  ChangesetActiveError,
  prepareChangesetStart,
  removeChangesetWorkspace,
  changesetApplyValidator,
  applyProjectChangeset,
  discardProjectChangeset,
  settleChangesetSession,
  CHANGESET_ID_PATTERN,
  sessionMatchesStatusFilter,
  parseSessionMockFilter,
  sessionMatchesMockFilter,
  sessionListStreamKey,
  sessionMatchesSearchIdentity,
  sessionStatusCounts,
  SESSION_SEARCH_SCAN_LIMIT,
  isOperatorRequest,
  buildRunTranscript,
  importantDescendantTree,
  logsWithChildSessions,
  reportedSurfaceForRun,
  webUIClientSurface,
  parseWebUITelemetryBody,
  webUITelemetryDedupeKey,
  createWebUITelemetryGuard,
  acceptWebUITelemetry,
  canSubmitWebUITelemetry,
  validateDecisionChoice,
  WEB_UI_TELEMETRY_DEDUPE_MS,
};
