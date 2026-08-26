import type { AgentSummary, ApprovalLogEntry, ApprovalPageInfo, ApprovalSummary, SessionContextPayload, SessionSummary } from "../../types";
import type { StoreBrowserRows, StoreBrowserSummary } from "../../stores";
import type { StoreItem } from "../../../../store/types";
import type { SerializedSchedule } from "../../../../scheduler";

export type { SerializedSchedule };

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export class ApiRequestError extends Error implements ApiError {
  constructor(public status: number, public code: string, message: string) {
    super(message);
  }
}

async function getJson<T>(
  path: string,
  params: Record<string, string | undefined> = {},
  options: { signal?: AbortSignal } = {}
): Promise<T> {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const response = await fetch(url, {
    headers: { Accept: 'application/json' },
    ...(options.signal && { signal: options.signal }),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || payload?.success === false) {
    throw new ApiRequestError(
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.message ?? `Request failed with status ${response.status}`
    );
  }
  return payload as T;
}

async function postJson<T>(path: string, body: Record<string, unknown>): Promise<T> {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.message ?? `Request failed with status ${response.status}`
    );
  }
  return payload as T;
}

export type WebUIPage = 'home' | 'agents' | 'schedules' | 'sessions' | 'approvals' | 'stores' | 'settings' | 'learnings' | 'other';

export function webUIPageForPath(pathname: string): WebUIPage {
  const head = pathname.split('/').filter(Boolean)[0];
  if (!head) return 'home';
  return head === 'agents' || head === 'schedules' || head === 'sessions' || head === 'approvals'
    || head === 'stores' || head === 'settings' || head === 'learnings'
    ? head
    : 'other';
}

/** Best-effort local reporting; the browser never contacts PostHog. */
export function reportWebUIPageView(page: WebUIPage): void {
  void fetch('/api/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ event: 'page_viewed', page }),
    keepalive: true,
  }).catch(() => {});
}

export type ApprovalRow = ApprovalSummary & { project: string };

export interface ApprovalsListPayload {
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
  nextCursor?: string;
  limit?: number;
}

export function fetchApprovals(options: { days?: string | undefined; project?: string | undefined; limit?: number | undefined; cursor?: string | undefined } = {}): Promise<ApprovalsListPayload> {
  return getJson('/api/approvals', {
    days: options.days, project: options.project, view: 'buckets',
    ...(options.limit !== undefined && { limit: String(options.limit) }), cursor: options.cursor,
  });
}

export function approvalsEventUrl(options: { days?: string | undefined; project?: string | undefined } = {}): string {
  const url = new URL('/api/approvals/events', location.origin);
  if (options.days !== undefined) url.searchParams.set('days', options.days);
  if (options.project !== undefined) url.searchParams.set('project', options.project);
  url.searchParams.set('view', 'buckets');
  return url.toString();
}

export interface ApprovalStatusPayload {
  success: true;
  sessionId: string;
  status: string;
  approval: ApprovalPageInfo;
  logs: ApprovalLogEntry[];
  logsTotal?: number;
  decision: unknown;
}

export function fetchApprovalStatus(sessionId: string, token: string, project?: string): Promise<ApprovalStatusPayload> {
  return getJson(`/approvals/${encodeURIComponent(sessionId)}/status`, { token, project });
}

export function postApprovalDecision(sessionId: string, body: {
  status: string;
  comment?: string;
  /** Option id picked on a pick-among-options gate; required with approve there. */
  choice?: string;
  remember?: string;
  resumeToken: string;
  project?: string;
}): Promise<{ sessionId: string; status: string }> {
  return postJson(`/approvals/${encodeURIComponent(sessionId)}/decision`, body);
}

export function postApprovalContinue(sessionId: string, body: {
  prompt: string;
  resumeToken: string;
  project?: string;
}): Promise<{ sessionId: string; status: string }> {
  return postJson(`/approvals/${encodeURIComponent(sessionId)}/continue`, body);
}

// --- Unified session page (/sessions/:id) -----------------------------------
// Auth is the per-session view token in the query string (?token=); the gate's
// resumeToken travels in the POST body. These mirror the /approvals/:id/* twins
// but against the canonical session routes the SPA navigates to.

function withToken(path: string, token?: string): string {
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}

export function fetchSessionStatus(sessionId: string, token: string | undefined, project?: string, logsLimit?: number): Promise<ApprovalStatusPayload> {
  return getJson(`/sessions/${encodeURIComponent(sessionId)}/status`, {
    token, project, logs: '1',
    ...(logsLimit !== undefined && { logsLimit: String(logsLimit) }),
  });
}

export interface SessionArtifact {
  name: string;
  title?: string;
  type: string;
  group: string;
  createdAt: string;
  updatedAt: string;
}

export interface SessionArtifactsPayload {
  success: true;
  artifacts: SessionArtifact[];
}

export function fetchSessionArtifacts(
  sessionId: string,
  token: string | undefined,
  project?: string,
  signal?: AbortSignal
): Promise<SessionArtifactsPayload> {
  return getJson(
    `/sessions/${encodeURIComponent(sessionId)}/artifacts-list`,
    { token, project },
    signal ? { signal } : {}
  );
}

export interface SessionContextResponse {
  success: true;
  context: SessionContextPayload;
}

/**
 * The context-stack diagnostic for one session. The endpoint is
 * `context-stack`, not `context`, because `/sessions/:id/context` is the page
 * that renders it.
 */
export function fetchSessionContext(
  sessionId: string,
  token: string | undefined,
  project?: string,
  signal?: AbortSignal
): Promise<SessionContextResponse> {
  return getJson(
    `/sessions/${encodeURIComponent(sessionId)}/context-stack`,
    { token, project },
    signal ? { signal } : {}
  );
}

export type SessionLearningSource = 'auto' | 'approval' | 'manual';

export type LearningState = 'active' | 'graduated' | 'retired';

export interface SessionLearning {
  id: string;
  category: string;
  title: string;
  instruction: string;
  confidence: number;
  source: SessionLearningSource;
  extractedAt: string;
  /** Session the learning was captured in; absent for legacy entries and agent-level rules. */
  sessionId?: string;
  state?: LearningState;
  appliedCount?: number;
  reasserted?: number;
  approvedRuns?: number;
  /** Whether this rule is one of the ones actually put in front of the model. */
  injected?: boolean;
}

/** Counts behind the "N of M apply per run" line. Absent on older responses. */
export interface LearningSummary {
  cap: number;
  active: number;
  injected: number;
  dormant: number;
  graduated: number;
  retired: number;
}

export interface TidyChange {
  kind: 'merge' | 'rewrite' | 'retire' | 'graduate';
  titles: string[];
  why: string;
}

/** Why the corrections still in force are still in force. Present only when a
 *  tidy-up ends above the cap. The sentences are written server-side so the two
 *  surfaces cannot word the same rule differently. */
export interface TidyRemaining {
  active: number;
  cap: number;
  /** True when the pass stopped at its round limit, so pressing again helps. */
  moreToDo: boolean;
  /** Rendered as "{count} {because}". */
  reasons: { count: number; because: string }[];
  graduationWait?: string;
}

export interface TidyResult {
  ran: boolean;
  model?: string;
  activeBefore: number;
  activeAfter: number;
  cap: number;
  /** Passes over the file this press made. */
  rounds?: number;
  remaining?: TidyRemaining;
  changes: TidyChange[];
  merged: number;
  rewritten: number;
  retired: number;
  graduated: string[];
  graduationSkipped?: string;
  diffs: { learnings: string; agentFile?: string };
  undoId?: string;
  note?: string;
}

/** A tidy-up in flight. Minutes of model work, so the page it runs on polls
 *  this rather than holding a request open. */
export interface TidyJob {
  id: string;
  project: string;
  path: string;
  status: 'running' | 'done' | 'error' | 'undone';
  /** Deciding what relates to what, writing the replacement rules, then saving. */
  phase: 'deciding' | 'writing' | 'applying' | 'done';
  /** Units of this phase finished, out of `total`. */
  step: number;
  total: number;
  /** Which pass over the file this is; a big file needs several. */
  round: number;
  maxRounds: number;
  projectedActive: number;
  cap: number;
  dryRun: boolean;
  startedAt: number;
  finishedAt?: number;
  error?: string;
}

export interface SessionLearningsPayload {
  success: true;
  learnings: SessionLearning[];
  summary?: LearningSummary;
  /** Which agent a tidy-up would rewrite. Server-supplied rather than assembled
   *  by each panel: on a sub-agent session the rules on screen belong to the
   *  parent agent, not the session's own, and only the server knows which. Its
   *  absence is what hides the button. */
  tidyTarget?: { project: string; runPath: string };
  /** Where this agent's learnings are stranded at the pre-0.17 location beside
   *  the agent file, if they are. Absent is the normal case. A path and not a
   *  sentence: the server should not be writing the panel's copy. */
  strandedAt?: string;
  tidy?: TidyResult;
  job?: TidyJob;
  /** A tidy-up running right now, so the panel can point at it instead of
   *  offering to start one that would just join it. */
  runningTidy?: { jobId: string };
  /** The last applied tidy-up, so a page loaded later can still offer Undo. */
  lastTidy?: { jobId: string; finishedAt: number };
  undone?: boolean;
}

export function fetchSessionLearnings(sessionId: string, token: string | undefined, project?: string): Promise<SessionLearningsPayload> {
  return getJson(`/sessions/${encodeURIComponent(sessionId)}/learnings`, { token, project });
}

export function addSessionLearning(sessionId: string, token: string | undefined, body: {
  instruction: string;
  project?: string;
}): Promise<SessionLearningsPayload> {
  return postJson(withToken(`/sessions/${encodeURIComponent(sessionId)}/learnings`, token), body);
}

export function discardSessionLearning(sessionId: string, learningId: string, token: string | undefined, body: {
  project?: string;
} = {}): Promise<SessionLearningsPayload> {
  return postJson(withToken(`/sessions/${encodeURIComponent(sessionId)}/learnings/${encodeURIComponent(learningId)}/discard`, token), body);
}

/** Agent-level learnings: the agent's full store, unfiltered by session. */
export function fetchAgentLearnings(project: string, runPath: string): Promise<SessionLearningsPayload> {
  return getJson('/api/agents/learnings', { project, path: runPath });
}

export function addAgentLearning(project: string, runPath: string, instruction: string): Promise<SessionLearningsPayload> {
  return postJson('/api/agents/learnings', { project, path: runPath, instruction });
}

export function discardAgentLearning(project: string, runPath: string, learningId: string): Promise<SessionLearningsPayload> {
  return postJson('/api/agents/learnings/discard', { project, path: runPath, id: learningId });
}

/**
 * Start a tidy-up: merge, sharpen, retire and make permanent, until every
 * correction counts. Returns as soon as the job is queued — the work itself
 * takes minutes, and {@link fetchAgentLearningsTidy} follows it.
 */
export function startAgentLearningsTidy(project: string, runPath: string, dryRun = false): Promise<{ success: true; job: TidyJob }> {
  return postJson('/api/agents/learnings/tidy', { project, path: runPath, dryRun });
}

/** Progress while a tidy-up runs, its result once it lands. Without `jobId` it
 *  answers with the agent's last applied tidy-up. */
export function fetchAgentLearningsTidy(project: string, runPath: string, jobId?: string): Promise<SessionLearningsPayload> {
  return getJson('/api/agents/learnings/tidy', { project, path: runPath, job: jobId });
}

/** Restore the corrections file AND the agent file to their pre-tidy state. */
export function undoAgentLearningsTidy(project: string, runPath: string): Promise<SessionLearningsPayload> {
  return postJson('/api/agents/learnings/undo', { project, path: runPath });
}

export function postSessionDecision(sessionId: string, token: string | undefined, body: {
  status: string;
  comment?: string;
  /** Option id picked on a pick-among-options gate; required with approve there. */
  choice?: string;
  remember?: string;
  resumeToken: string;
  project?: string;
}): Promise<{ sessionId: string; status: string }> {
  return postJson(withToken(`/sessions/${encodeURIComponent(sessionId)}/decision`, token), body);
}

export function postSessionContinue(sessionId: string, token: string | undefined, body: {
  prompt: string;
  project?: string;
}): Promise<{ sessionId: string; status: string }> {
  return postJson(withToken(`/sessions/${encodeURIComponent(sessionId)}/continue`, token), body);
}

// Roll an ended (error/completed) session back to its suspended approval gate so
// the reviewer can retry a resume that failed downstream. No resumeToken needed:
// the view token authorizes it, and the gate keeps its original token.
export function postSessionReopen(sessionId: string, token: string | undefined, body: {
  project?: string;
} = {}): Promise<{ sessionId: string; status: string }> {
  return postJson(withToken(`/sessions/${encodeURIComponent(sessionId)}/reopen`, token), body);
}

// A stop on a session suspended on an approval gate is delivered as a REJECT
// decision (202 { status: 'resuming', rejected: true }) so the agent can
// record the rejection before ending; otherwise the tree is hard-stopped
// (200 { success: true, stopped: [...] }).
export type StopSessionResult =
  | {
    success: true;
    sessionId: string;
    stopped: Array<{ sessionId: string; agentId: string; agentName: string; wasStatus: string; stopped: boolean; dismissed?: boolean }>;
    rejected?: undefined;
  }
  | { sessionId: string; status: string; rejected: true };

export function postSessionStop(sessionId: string, token: string | undefined, body: {
  project?: string;
  reason?: string;
  force?: boolean;
}): Promise<StopSessionResult> {
  return postJson(withToken(`/sessions/${encodeURIComponent(sessionId)}/stop`, token), body);
}

export interface StoresIndexPayload {
  success: true;
  multiProject: boolean;
  stores: StoreBrowserSummary[];
  errors: Array<{ projectId: string; storeName?: string; message: string }>;
}

export function fetchStores(project?: string): Promise<StoresIndexPayload> {
  return getJson('/api/stores', { project });
}

export interface StoreRowsPayload {
  success: true;
  multiProject: boolean;
  store: string;
  rows: StoreBrowserRows[];
  errors: Array<{ projectId: string; message: string }>;
}

export function fetchStoreRows(storeName: string, project?: string): Promise<StoreRowsPayload> {
  return getJson(`/api/stores/${encodeURIComponent(storeName)}`, { project });
}

export interface StoreItemPayload {
  success: true;
  store: string;
  project: string;
  item: StoreItem;
}

export function fetchStoreItem(storeName: string, itemId: string, project?: string): Promise<StoreItemPayload> {
  return getJson(`/api/stores/${encodeURIComponent(storeName)}/${encodeURIComponent(itemId)}`, { project });
}

/**
 * Display identity from an `ABOUT.md` sitting in the directory it describes
 * (#156). Labels only, never behavior: `name` replaces the directory name,
 * `description` replaces the absolute path, `body` renders on the detail
 * surface. Absent file means absent field, and the UI falls back to paths.
 */
export interface AboutInfo {
  name?: string;
  description?: string;
  owner?: string;
  body?: string;
}

export interface ProjectInfo {
  id: string;
  path: string;
  scope?: string;
  agentCount: number;
  scheduleCount: number;
  about?: AboutInfo;
}

export interface InfoPayload {
  version: string;
  update?: {
    currentVersion: string;
    latestVersion: string;
    packageManager: 'npm' | 'pnpm' | 'bun' | 'yarn';
    command: string;
  };
  default: string | null;
  projects: ProjectInfo[];
}

export function fetchInfo(): Promise<InfoPayload> {
  return getJson('/api');
}

export function createManagedProject(name: string): Promise<{ success: true; project: ProjectInfo }> {
  return postJson('/api/projects', { name });
}

export type AgentRow = AgentSummary;

/** Folder-level `ABOUT.md`: names a directory that groups agents (#156). */
export interface DirAbout {
  projectId: string;
  /** Project-relative directory path, the same notation agent `path` uses. */
  path: string;
  about: AboutInfo;
}

export interface AgentsPayload {
  success: true;
  agents: AgentRow[];
  errors: Array<{ projectId: string; path: string; message: string }>;
  /** Only directories that actually have an ABOUT.md; often absent. */
  dirs?: DirAbout[];
}

export function fetchAgents(): Promise<AgentsPayload> {
  return getJson('/api/agents');
}

export interface AgentDetailMeta {
  filesystem?: string[];
  bashCommands?: number;
  gated?: string[];               // bash patterns that run only after human approval
  awaitHuman?: boolean;
  skills: { auto: boolean; trusted: boolean; explicit: string[] };
  mcpServers: string[];
  subagents: string[];
  approval?: boolean;
  channels: string[];
  timeout?: number;
  maxSteps?: number;
  version?: string;
}

export interface AgentDetailPayload {
  success: true;
  projectId: string;
  path: string;
  runPath: string;
  name: string;
  description?: string;
  model: string;
  schedule?: string;
  scheduleHuman?: string;
  metadata?: Record<string, unknown>;
  /** Raw `.agentuse` text; absent when the deployment hides agent source (serve.hideAgentSource). */
  source?: string;
  sourceHidden?: true;
  meta: AgentDetailMeta;
}

/** Capabilities summary + raw `.agentuse` source for the agent hub page. */
export function fetchAgentDetail(project: string, runPath: string): Promise<AgentDetailPayload> {
  return getJson('/api/agents/detail', { project, path: runPath });
}

export interface DetachedRunResponse {
  success: true;
  sessionId: string;
  status: string;
  /** Per-session view token, present only on token-gated (api-key) daemons. */
  token?: string;
}

/**
 * Start an agent run in the background and resolve with its (pre-assigned)
 * session id immediately, so the caller can navigate to the live session view.
 * An optional `prompt` is appended to the agent's instructions for this run
 * only (powers the "Run with Custom Instruction" action).
 */
export function runAgentDetached(agent: string, project: string | undefined, prompt?: string): Promise<DetachedRunResponse> {
  // project is omitted on single-project daemons (the server falls back to its
  // only/default project), e.g. when launched from a session view with no
  // ?project= in the URL.
  const body: Record<string, unknown> = {
    agent,
    ...(project ? { project } : {}),
    detach: true,
    reportedSurface: 'web_ui',
  };
  if (prompt && prompt.trim()) body.prompt = prompt.trim();
  return postJson('/api/run', body);
}

/** Start the zero-file, demo-model first-run guide from an empty dashboard. */
export function runOnboardingDetached(project?: string): Promise<DetachedRunResponse> {
  return postJson('/api/onboarding/run', project ? { project } : {});
}

export interface SchedulesPayload {
  success: true;
  schedules: SerializedSchedule[];
}

export function fetchSchedules(): Promise<SchedulesPayload> {
  return getJson('/api/schedules');
}

export type SessionRow = SessionSummary & { project: string };

export interface SessionsPayload {
  success: true;
  sessions: SessionRow[];
  window: { value: string; days?: number | 'all'; hours?: number; updatedAfter?: number };
  agent?: string;
  status?: string;
  triage?: string;
  trigger?: string;
  approval?: string;
  errors: Array<{ projectId: string; message: string }>;
  nextCursor?: string;
  limit?: number;
}

export function fetchSessions(options: {
  agent?: string | undefined;
  status?: string | undefined;
  triage?: string | undefined;
  trigger?: string | undefined;
  approval?: string | undefined;
  window?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  detail?: 'feed' | 'agents' | undefined;
  /** Mock/test runs are excluded server-side by default; 'include' mixes them in, 'only' shows just them. */
  mock?: 'include' | 'only' | undefined;
} = {}): Promise<SessionsPayload> {
  return getJson('/api/sessions', {
    agent: options.agent,
    status: options.status,
    triage: options.triage,
    trigger: options.trigger,
    approval: options.approval,
    window: options.window,
    ...(options.limit !== undefined && { limit: String(options.limit) }),
    cursor: options.cursor,
    detail: options.detail,
    mock: options.mock,
  });
}

// --- Web Push ----------------------------------------------------------------
// Subscriptions are per browser+device; prefs pick which event categories this
// device gets. A device with every category off is dropped server-side.

export interface PushPrefs {
  approvals: boolean;
  sessions: boolean;
}

export interface PushSubscriptionKeys {
  endpoint: string;
  keys: { p256dh: string; auth: string };
}

export function fetchPushPublicKey(): Promise<{ publicKey: string }> {
  return getJson('/api/push/public-key');
}

/** Throws ApiRequestError(404) when this device is unknown to the server. */
export function fetchPushPrefs(endpoint: string): Promise<{ prefs: PushPrefs }> {
  return getJson('/api/push/subscription', { endpoint });
}

export function postPushSubscription(body: {
  subscription: PushSubscriptionKeys;
  prefs: Partial<PushPrefs>;
}): Promise<{ subscribed: boolean; prefs?: PushPrefs }> {
  return postJson('/api/push/subscription', body);
}

export function sessionsEventUrl(options: {
  agent?: string | undefined;
  status?: string | undefined;
  triage?: string | undefined;
  trigger?: string | undefined;
  approval?: string | undefined;
  window?: string | undefined;
  limit?: number | undefined;
  detail?: 'feed' | 'agents' | undefined;
  mock?: 'include' | 'only' | undefined;
} = {}): string {
  const url = new URL('/sessions/events', location.origin);
  if (options.agent !== undefined) url.searchParams.set('agent', options.agent);
  if (options.status !== undefined) url.searchParams.set('status', options.status);
  if (options.triage !== undefined) url.searchParams.set('triage', options.triage);
  if (options.trigger !== undefined) url.searchParams.set('trigger', options.trigger);
  if (options.approval !== undefined) url.searchParams.set('approval', options.approval);
  if (options.window !== undefined) url.searchParams.set('window', options.window);
  if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit));
  if (options.detail !== undefined) url.searchParams.set('detail', options.detail);
  if (options.mock !== undefined) url.searchParams.set('mock', options.mock);
  return url.toString();
}
