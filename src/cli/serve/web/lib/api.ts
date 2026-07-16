import type { AgentSummary, ApprovalLogEntry, ApprovalPageInfo, ApprovalSummary, SessionSummary } from "../../types";
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

async function getJson<T>(path: string, params: Record<string, string | undefined> = {}): Promise<T> {
  const url = new URL(path, location.origin);
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) url.searchParams.set(key, value);
  }
  const response = await fetch(url, { headers: { Accept: 'application/json' } });
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
    days: options.days, project: options.project,
    ...(options.limit !== undefined && { limit: String(options.limit) }), cursor: options.cursor,
  });
}

export function approvalsEventUrl(options: { days?: string | undefined; project?: string | undefined } = {}): string {
  const url = new URL('/api/approvals/events', location.origin);
  if (options.days !== undefined) url.searchParams.set('days', options.days);
  if (options.project !== undefined) url.searchParams.set('project', options.project);
  return url.toString();
}

export interface ApprovalStatusPayload {
  success: true;
  sessionId: string;
  status: string;
  approval: ApprovalPageInfo;
  logs: ApprovalLogEntry[];
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

export function fetchSessionStatus(sessionId: string, token: string | undefined, project?: string): Promise<ApprovalStatusPayload> {
  return getJson(`/sessions/${encodeURIComponent(sessionId)}/status`, { token, project, logs: '1' });
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

export function fetchSessionArtifacts(sessionId: string, token: string | undefined, project?: string): Promise<SessionArtifactsPayload> {
  return getJson(`/sessions/${encodeURIComponent(sessionId)}/artifacts-list`, { token, project });
}

export type SessionLearningSource = 'auto' | 'approval' | 'manual';

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
}

export interface SessionLearningsPayload {
  success: true;
  learnings: SessionLearning[];
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
    stopped: Array<{ sessionId: string; agentId: string; agentName: string; wasStatus: string; stopped: boolean }>;
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

export interface ProjectInfo {
  id: string;
  path: string;
  scope?: string;
  agentCount: number;
  scheduleCount: number;
}

export interface InfoPayload {
  version: string;
  default: string | null;
  projects: ProjectInfo[];
}

export function fetchInfo(): Promise<InfoPayload> {
  return getJson('/api');
}

export type AgentRow = AgentSummary;

export interface AgentsPayload {
  success: true;
  agents: AgentRow[];
  errors: Array<{ projectId: string; path: string; message: string }>;
}

export function fetchAgents(): Promise<AgentsPayload> {
  return getJson('/api/agents');
}

export interface AgentDetailMeta {
  filesystem?: string[];
  bashCommands?: number;
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
  source: string;
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
  const body: Record<string, unknown> = { agent, ...(project ? { project } : {}), detach: true };
  if (prompt && prompt.trim()) body.prompt = prompt.trim();
  return postJson('/api/run', body);
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
  window: { value: string; days?: number | 'all'; hours?: number; createdAfter?: number };
  agent?: string;
  status?: string;
  trigger?: string;
  approval?: string;
  errors: Array<{ projectId: string; message: string }>;
  nextCursor?: string;
  limit?: number;
}

export function fetchSessions(options: {
  agent?: string | undefined;
  status?: string | undefined;
  trigger?: string | undefined;
  approval?: string | undefined;
  window?: string | undefined;
  limit?: number | undefined;
  cursor?: string | undefined;
  detail?: 'feed' | undefined;
} = {}): Promise<SessionsPayload> {
  return getJson('/api/sessions', {
    agent: options.agent,
    status: options.status,
    trigger: options.trigger,
    approval: options.approval,
    window: options.window,
    ...(options.limit !== undefined && { limit: String(options.limit) }),
    cursor: options.cursor,
    detail: options.detail,
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
  trigger?: string | undefined;
  approval?: string | undefined;
  window?: string | undefined;
  limit?: number | undefined;
  detail?: 'feed' | undefined;
} = {}): string {
  const url = new URL('/sessions/events', location.origin);
  if (options.agent !== undefined) url.searchParams.set('agent', options.agent);
  if (options.status !== undefined) url.searchParams.set('status', options.status);
  if (options.trigger !== undefined) url.searchParams.set('trigger', options.trigger);
  if (options.approval !== undefined) url.searchParams.set('approval', options.approval);
  if (options.window !== undefined) url.searchParams.set('window', options.window);
  if (options.limit !== undefined) url.searchParams.set('limit', String(options.limit));
  if (options.detail !== undefined) url.searchParams.set('detail', options.detail);
  return url.toString();
}
