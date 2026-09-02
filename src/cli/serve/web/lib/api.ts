import type { AgentSummary, ApprovalLogEntry, ApprovalPageInfo, ApprovalSummary, SessionContextPayload, SessionSummary } from "../../types";
import type { StoreBrowserRows, StoreBrowserSummary } from "../../stores";
import type { StoreItem } from "../../../../store/types";
import type { SerializedSchedule } from "../../../../scheduler";
import type { ProviderCatalogEntry } from "../../../../auth/provider-setup";
import type { ProviderStatus } from "../../../../auth/provider-status";
import type { AgentCreationProvider } from "../../../../agents/create";
import type { ReasoningLevel } from "../../../../model-compatibility";
import type { AgentRevisionRecord } from "../../../../agents/revision";

export type { SerializedSchedule };

export interface ApiError {
  status: number;
  code: string;
  message: string;
}

export class ApiRequestError extends Error implements ApiError {
  constructor(
    public status: number,
    public code: string,
    message: string,
    /** Extra fields the server attached to the error, e.g. a link to the blocking resource. */
    public details: Record<string, unknown> = {},
  ) {
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
      payload?.error?.message ?? `Request failed with status ${response.status}`,
      payload?.error ?? {}
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
      payload?.error?.message ?? `Request failed with status ${response.status}`,
      payload?.error ?? {}
    );
  }
  return payload as T;
}

async function deleteJson<T>(path: string): Promise<T> {
  const response = await fetch(path, { method: 'DELETE', headers: { Accept: 'application/json' } });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      payload?.error?.code ?? 'REQUEST_FAILED',
      payload?.error?.message ?? `Request failed with status ${response.status}`,
      payload?.error ?? {}
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

export type OnboardingTelemetryStep =
  | 'desktop_setup'
  | 'project_created'
  | 'sample_run_completed'
  | 'agent_prompt_copied'
  | 'agent_detected'
  | 'agent_opened';

export type OnboardingTelemetryPayload = {
  event: 'onboarding_started' | 'onboarding_completed';
  duration_ms?: number;
  agent_count?: number;
  detection_method?: 'poll' | 'manual_check' | 'native_create';
} | {
  event: 'onboarding_step_completed' | 'onboarding_step_failed';
  step: OnboardingTelemetryStep;
  duration_ms?: number;
  error_code?:
    | 'project_create_failed'
    | 'sample_run_failed'
    | 'provider_status_failed'
    | 'agent_check_failed';
  provider_readiness?: 'ready' | 'not_ready' | 'unknown';
  agent_count?: number;
  detection_method?: 'poll' | 'manual_check' | 'native_create';
};

export function currentOnboardingRoute(): 'desktop' | 'web' {
  return typeof window !== 'undefined' && window.agentuseDesktop ? 'desktop' : 'web';
}

/** Best-effort onboarding reporting; names, paths, and prompt text are never accepted. */
export function reportOnboardingTelemetry(payload: OnboardingTelemetryPayload): void {
  void fetch('/api/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...payload, onboarding_route: currentOnboardingRoute() }),
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

export type LearningState = 'active' | 'graduated' | 'retired' | 'quarantined';

export type LearningChannel = 'corrections' | 'tool-errors' | 'custom' | 'agent';

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
  /** Times sent to the model — cost, not evidence it worked (that is approvedRuns). */
  injectedCount?: number;
  /** Capture channel; absent for entries stored before channels existed. */
  channel?: LearningChannel;
  /** Why the vet set this entry aside. Present only when state is 'quarantined'. */
  quarantineReason?: string;
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
  /** Entries the vet set aside with a reason. Absent on older responses. */
  quarantined?: number;
  /** Store counts per capture channel ('legacy' for pre-channel entries),
   *  retired excluded. Absent on older responses. */
  byChannel?: Record<string, number>;
}

export interface TidyChange {
  kind: 'merge' | 'rewrite' | 'compress' | 'retire' | 'graduate' | 'quarantine' | 'drop-permanent' | 'merge-permanent' | 'rewrite-permanent';
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
  capabilities?: {
    projectFolderPicker: boolean;
  };
  projects: ProjectInfo[];
}

export function fetchInfo(): Promise<InfoPayload> {
  return getJson('/api');
}

export function createManagedProject(name: string): Promise<{ success: true; project: ProjectInfo }> {
  return postJson('/api/projects', { name });
}

export function attachExistingProject(path: string): Promise<{ success: true; project: ProjectInfo }> {
  return postJson('/api/projects/attach', { path });
}

export function removeProject(id: string): Promise<{ success: true }> {
  return deleteJson(`/api/projects/${encodeURIComponent(id)}`);
}

export async function pickProjectFolder(): Promise<string | null> {
  if (typeof window !== 'undefined' && window.agentuseDesktop?.chooseProjectFolder) {
    return window.agentuseDesktop.chooseProjectFolder();
  }
  const result = await postJson<{ success: true; path: string | null }>('/api/projects/pick-folder', {});
  return result.path;
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

export interface AgentCreationOptionsPayload {
  success: true;
  providers: AgentCreationProvider[];
  projects: Array<{ id: string; path: string; scope?: string }>;
  default: string | null;
}

export function fetchAgentCreationOptions(): Promise<AgentCreationOptionsPayload> {
  return getJson('/api/agents/create');
}

export function startAgentCreationSession(input: {
  project: string;
  name?: string;
  description?: string;
  objective: string;
  model: string;
  reasoning?: ReasoningLevel;
  schedule?: string;
  guided?: boolean;
}): Promise<{ success: true; job: OnboardingJobHandle }> {
  return postJson('/api/agents', input);
}

export interface ProjectAgentSuggestion {
  id: string;
  name: string;
  description: string;
  objective: string;
  schedule: string;
  scheduleHuman: string;
  evidence: string[];
}

export interface ProjectDiscoveryPayload {
  success: true;
  model: string;
  projectName: string;
  summary: string;
  inspectedFiles: number;
  suggestions: ProjectAgentSuggestion[];
}

export interface OnboardingJobHandle {
  id: string;
  sessionId: string;
  projectId: string;
  kind: 'project-discovery' | 'agent-creation' | 'agent-revision';
  status: 'running' | 'completed' | 'error';
  /** Absent on jobs created by older daemons; treat those as already running. */
  phase?: 'preparing' | 'running';
  model: string;
  createdAt: number;
  sessionToken?: string;
}

export type OnboardingJob = OnboardingJobHandle & {
  result?: ProjectDiscoveryPayload | { success: true; agent: AgentRow };
  error?: { code: string; message: string };
};

export function startProjectDiscoverySession(project: string, model: string): Promise<{ success: true; job: OnboardingJobHandle }> {
  return postJson('/api/onboarding/discovery', { project, model });
}

export function startOnboardingAgentCreation(input: {
  project: string;
  name: string;
  description: string;
  objective: string;
  model: string;
  schedule: string;
}): Promise<{ success: true; job: OnboardingJobHandle }> {
  return postJson('/api/agents', { ...input, guided: true });
}

export function fetchInternalAgentJob(id: string): Promise<{ success: true; job: OnboardingJob }> {
  return getJson(`/api/internal-agent-jobs/${encodeURIComponent(id)}`);
}

export interface AgentRevisionSummary extends Omit<AgentRevisionRecord, 'proposedSource' | 'previousSource'> {
  href?: string;
}

export function fetchAgentRevisions(
  project: string,
  path: string,
): Promise<{ success: true; revisions: AgentRevisionSummary[] }> {
  return getJson('/api/agents/revisions', { project, path });
}

export function fetchSessionRevisions(
  sessionId: string,
  token?: string,
  project?: string,
): Promise<{ success: true; revisions: AgentRevisionSummary[] }> {
  return getJson(`/sessions/${encodeURIComponent(sessionId)}/revisions`, { token, project });
}

export function startAgentRevision(input: {
  sessionId: string;
  token?: string;
  project?: string;
  instruction: string;
  model: string;
  reasoning?: ReasoningLevel;
}): Promise<{ success: true; job: OnboardingJobHandle }> {
  const path = withToken(`/sessions/${encodeURIComponent(input.sessionId)}/revisions`, input.token);
  return postJson(path, {
    ...(input.project && { project: input.project }),
    instruction: input.instruction,
    model: input.model,
    ...(input.reasoning && { reasoning: input.reasoning }),
  });
}

export function fetchAgentRevision(
  revisionSessionId: string,
  token?: string,
  project?: string,
): Promise<{ success: true; revision: Omit<AgentRevisionRecord, 'previousSource'> & { baseSource?: string; originHref?: string } }> {
  return getJson(`/agent-revisions/${encodeURIComponent(revisionSessionId)}`, { token, project });
}

export function postAgentRevisionAction(
  revisionSessionId: string,
  action: 'apply' | 'discard' | 'restore' | 'cancel',
  project?: string,
): Promise<{ success: true; revision: Omit<AgentRevisionRecord, 'previousSource'> }> {
  const query = project ? `?project=${encodeURIComponent(project)}` : '';
  return postJson(`/agent-revisions/${encodeURIComponent(revisionSessionId)}/${action}${query}`, {});
}

export function requestAgentRevisionChanges(
  revisionSessionId: string,
  prompt: string,
  project?: string,
): Promise<{ sessionId: string; status: string }> {
  const query = project ? `?project=${encodeURIComponent(project)}` : '';
  return postJson(`/agent-revisions/${encodeURIComponent(revisionSessionId)}/request-changes${query}`, { prompt });
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
  scheduleEnabled?: boolean;
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

export function setAgentSchedulePaused(project: string, path: string, paused: boolean): Promise<{ success: true; paused: boolean; scheduleEnabled: boolean }> {
  return postJson('/api/schedules/state', { project, path, paused });
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

export interface ProviderSetupPayload {
  success: true;
  catalog: readonly ProviderCatalogEntry[];
  status: ProviderStatus;
}

export function fetchProviderSetup(): Promise<ProviderSetupPayload> {
  return getJson('/api/providers');
}

export function saveProviderApiKey(provider: string, key: string): Promise<ProviderSetupPayload> {
  return postJson('/api/providers/api-key', { provider, key });
}

export function startProviderOAuth(provider: string, mode?: 'max' | 'console'): Promise<{
  success: true;
  flowId: string;
  provider: 'anthropic' | 'openai';
  authorizationUrl: string;
  expiresAt: number;
}> {
  return postJson('/api/providers/oauth/start', { provider, ...(mode ? { mode } : {}) });
}

export function completeProviderOAuth(flowId: string, code: string): Promise<ProviderSetupPayload> {
  return postJson('/api/providers/oauth/complete', { flowId, code });
}

export function removeProviderCredential(provider: string, kind: 'oauth' | 'api_key'): Promise<ProviderSetupPayload> {
  return postJson('/api/providers/remove', { provider, kind });
}

export type CustomProviderApi = 'openai-completions' | 'openai-responses' | 'anthropic-messages';
export type CustomProviderApiSelection = CustomProviderApi | 'auto';

export function saveCustomProvider(name: string, baseURL: string, api: CustomProviderApiSelection, key?: string, models: string[] = []): Promise<ProviderSetupPayload> {
  return postJson('/api/providers/custom', { name, baseURL, api, ...(key ? { key } : {}), models });
}

export function checkCustomProvider(name: string, baseURL: string, api: CustomProviderApiSelection, key?: string, models: string[] = []): Promise<{
  success: true;
  name: string;
  baseURL: string;
  api: CustomProviderApi;
  models: string[];
}> {
  return postJson('/api/providers/custom/check', { name, baseURL, api, ...(key ? { key } : {}), models });
}

export function refreshCustomProviderModels(name: string): Promise<ProviderSetupPayload> {
  return postJson('/api/providers/custom/refresh', { name });
}

export function removeCustomProvider(name: string): Promise<ProviderSetupPayload> {
  return postJson('/api/providers/custom/remove', { name });
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
