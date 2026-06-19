import type { ActiveContextUsage, SessionTrigger } from "../../session/types";

export type { SessionTrigger };

export interface RunRequest {
  agent: string;
  project?: string;
  prompt?: string;
  model?: string;
  timeout?: number;
  maxSteps?: number;
  sessionId?: string;
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

export interface ExpiredApproval {
  sessionId: string;
  agentId: string;
  agentName: string;
  prompt?: string;
  expiresAt: number;
  suspendedAt?: number;
  channelMessage?: { type?: string; channel?: string; ts?: string; actionTs?: string; url?: string };
}

export type ApprovalSummaryStatus = 'pending' | 'approved' | 'rejected' | 'commented' | 'expired' | 'errored';
export const APPROVAL_LIST_DEFAULT_DAYS = 30;

export interface ApprovalSummary {
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

export interface SessionSummary {
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

export interface SessionStatusInfo {
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

export interface ChildSessionSummary {
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

export interface SessionTokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  context?: ActiveContextUsage;
}

export interface ApprovalPageInfo {
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

/** Severity carried by `type: 'log'` entries (operational logger output). */
export type LogEntryLevel = 'debug' | 'info' | 'warn' | 'error' | 'system';

export interface ApprovalLogEntry {
  id: string;
  type: string;
  tool?: string;
  status?: string;
  /** Set on `type: 'log'` entries to drive level styling and the debug toggle. */
  level?: LogEntryLevel;
  title: string;
  message?: string;
  time?: number;
  subagentSession?: LogSubagentSession;
  details?: ApprovalLogDetails;
}

export interface LogSubagentSession extends ChildSessionSummary {
  href?: string;
  command: string;
  displayStatus: string;
}

export interface ApprovalLogDetails {
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
  /** Session-storage-relative full tool output artifact, viewable via /sessions/:id/tool-artifacts/*. */
  toolOutputArtifact?: {
    path: string;
    bytes?: number;
    originalChars?: number;
  };
  decisionStatus?: string;
  decisionComment?: string;
  decisionReviewer?: string;
  errorMessage?: string;
}

export interface AgentSummary {
  projectId: string;
  /**
   * Path relative to the project root. Drives the tree layout and the
   * `?agent=` session filter. NOTE: not necessarily what POST /run accepts when
   * the served scope differs from the project root, use `runPath` for that.
   */
  path: string;
  /**
   * Path relative to the served scope, i.e. the exact `agent` value POST /run
   * resolves (resolve(scopeRoot, runPath)). Equals `path` when scope === root.
   */
  runPath: string;
  name: string;
  description?: string;
  model: string;
  /** Raw schedule expression when the agent declares one. */
  schedule?: string;
}

export interface Project {
  id: string;
  /** Detected project/state root. Owns .agentuse/store, sessions, env, plugins. */
  root: string;
  /** Directory used for agent discovery and relative API agent paths. */
  scopeRoot: string;
  envFile: string;
  agentFiles: string[];
}
