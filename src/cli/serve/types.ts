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
  /** Reviewer discarded this ended failed run; needs-attention surfaces skip it. */
  dismissedAt?: number;
  mock?: boolean;
  /** Suspended parent parked on a running delegated child: the run is live, work
   *  is in a subagent, so surfaces render it "running · subagent" rather than the
   *  bare "suspended" that means "waiting on you". */
  subagentActive?: boolean;
  /** Present on session-list rows only when the caller requests feed detail. */
  finalResponse?: string;
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
  mock?: boolean;
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
  /** Resolved project id, stamped by the serve daemon on session lookups so
   *  clients without ?project= in the URL can address project-scoped
   *  endpoints (e.g. "Run new session" on a multi-project daemon). */
  project?: string;
  createdAt?: number;
  model?: string;
  agent: {
    id: string;
    name: string;
    filePath?: string;
    /**
     * Path relative to the served scope (AgentSummary.runPath), stamped by the
     * serve daemon when the agent file is one of the project's loaded agents.
     * Lets the session page link to that agent's detail hub. Absent for agents
     * outside the served scope (e.g. a run started from elsewhere).
     */
    runPath?: string;
    description?: string;
  };
  learning?: {
    capture: boolean;
    apply: boolean;
  };
  prompt?: string;
  /** The per-run instruction the session was started with (CLI args / the "run
   *  with custom instruction" composer), appended to the agent's own body. */
  additionalInstruction?: string;
  summary?: string;
  draft?: string;
  changes?: ApprovalChange[];
  reference?: ApprovalReference;
  options?: ApprovalOption[];
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
  /** Reviewer discarded this ended failed run (see SessionSummary.dismissedAt). */
  dismissedAt?: number;
  /** True when an ended (error/completed) session can be rolled back to its
   *  suspended approval gate for a manual retry (POST /sessions/:id/reopen). */
  reopenable?: boolean;
  childSessions?: ChildSessionSummary[];
  /** The delegated leaf that actually raised this gate, when surfaced at a manager
   *  root via the subagent approval cascade. The gate is addressed at sessionId
   *  (the root) but labeled with this leaf. */
  originAgent?: {
    id: string;
    name: string;
    filePath?: string;
    description?: string;
  };
  /** True when this page is a delegated child viewed directly: approval happens at
   *  the root (rootSessionId), so the child page shows no decision controls. */
  viewOnly?: boolean;
  rootSessionId?: string;
  /** The immediate parent (manager) of a delegated child: id, agent name, and a
   *  tokenized link, so the child page can render a breadcrumb back to it. */
  parentSessionId?: string;
  parentAgentName?: string;
  parentHref?: string;
  tokenUsage?: SessionTokenUsage;
  logs?: ApprovalLogEntry[];
  /** True when the run was started with --mock (tool outputs are LLM-generated). */
  mock?: boolean;
}

/** Severity carried by `type: 'log'` entries (operational logger output). */
export type LogEntryLevel = 'debug' | 'info' | 'warn' | 'error' | 'system';

export interface ApprovalLogEntry {
  id: string;
  type: string;
  tool?: string;
  /** Tool-call id of a `type: 'tool'` entry (matches a log entry's `toolId`). */
  callId?: string;
  /** On a `type: 'log'` entry: the tool call this line is about, so the session
   *  view can nest it under the matching tool entry instead of the flat stream. */
  toolId?: string;
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

/** One discrete action executed on approval: verbatim content, no rationale. */
export interface ApprovalChange {
  label?: string;
  content: string;
  /** Exact business content shown prominently when `content` is a command. */
  displayContent?: string;
  optionId?: string;
}

/** The original item an approval's action responds to (post, message, document). */
export interface ApprovalReference {
  label?: string;
  author?: string;
  title?: string;
  url?: string;
  excerpt?: string;
}

/** One selectable alternative on a pick-among-options approval gate. */
export interface ApprovalOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

export interface ToolTokenUsage {
  /** Provider input tokens for the model step, including cached reads. */
  input: number;
  output: number;
  cachedInput: number;
  /** Tool calls emitted by the same model step and sharing these counters. */
  sharedCalls?: number;
}

export interface ApprovalLogDetails {
  resumeToken?: string;
  prompt?: string;
  /** Model-declared goal of this call (the injected `intent` parameter), shown
   *  as the tool row's primary label with the tool chip demoted to metadata. */
  intent?: string;
  input?: string;
  output?: string;
  /**
   * Bounded tail of a tool call that is still running (bash today), refreshed
   * as it prints and replaced by `output` once the call finishes. Never part of
   * the model's view of the run.
   */
  liveOutput?: string;
  tokenUsage?: ToolTokenUsage;
  summary?: string;
  context?: string;
  risk?: string;
  draft?: string;
  changes?: ApprovalChange[];
  reference?: ApprovalReference;
  options?: ApprovalOption[];
  draftUrl?: string;
  artifactUrl?: string;
  /** Project-root-relative paths to local file artifacts, viewable via /sessions/:id/artifacts/*. */
  artifactPaths?: string[];
  /** Gate-time snapshots of media the gate referenced (explicit or mentioned in
   *  payload prose). Served via /sessions/:id/artifacts/<path>?snap=<hash>, so
   *  the reviewer sees the exact bytes the approval covers even if the live
   *  file changed since. */
  artifactSnapshots?: Array<{ path: string; hash: string; ext: string; bytes?: number }>;
  /** Session-storage-relative full tool output artifact, viewable via /sessions/:id/tool-artifacts/*. */
  toolOutputArtifact?: {
    path: string;
    bytes?: number;
    originalChars?: number;
  };
  /**
   * A completed sub-agent call's result, as the child declared it: the run's
   * verdict, what it produced, and its report body. Rendered in the parent's
   * row so a manager's log reads on its own, instead of forcing a click into
   * the child session to find out what came back.
   */
  subagentResult?: {
    /** One-line verdict from the child's `report_complete`. */
    headline?: string;
    /** Set instead of `headline` when the child declared itself blocked. */
    incomplete?: string;
    /** Paths and URLs the child produced or changed. */
    artifacts?: string[];
    /** The report body, verdict line already stripped. Markdown. */
    body?: string;
  };
  /**
   * The run's own verdict and report, as delivered through `report_complete` /
   * `report_incomplete`. That call IS the run's answer, not a step of the work,
   * so the row renders this inline instead of leaving the report one expand
   * click deep inside a JSON input dump. The raw input/output stay behind the
   * toggle.
   */
  runOutcome?: {
    kind: 'complete' | 'incomplete';
    /** One-line verdict: `headline` on complete, `reason` on incomplete. */
    headline: string;
    /**
     * The report body as the runtime composed it — the attached `details`
     * merged with any prose the agent streamed alongside it, verdict line
     * already stripped. Markdown.
     */
    body?: string;
    /** Paths and URLs the run produced or changed. */
    artifacts?: string[];
  };
  /** A deliverable saved by `tools__artifact_save`, rendered as a viewable tile linking to the artifact. */
  savedArtifact?: {
    url: string;
    /** Project-root-relative path, viewable via /sessions/:id/artifacts/*. */
    path: string;
    title?: string;
    group?: string;
  };
  decisionStatus?: string;
  decisionComment?: string;
  /** Option id the reviewer selected, when the gate offered options. */
  decisionChoice?: string;
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
  /** Human-readable form of `schedule` (e.g. "Every 5 minutes"). */
  scheduleHuman?: string;
  /**
   * Free-form frontmatter `metadata:`. Opaque to the daemon, passed through so
   * the UI can surface it (selectable column, detail list). Omitted when the
   * agent declares none.
   */
  metadata?: Record<string, unknown>;
  /**
   * Declared relationships, all normalized to the same project-relative
   * notation as `path` so the client resolves edges by string equality.
   * Targets outside the project keep their `../` form. Omitted when empty.
   */
  subagents?: string[];
  /** Advisory cross-run ordering from frontmatter `dependsOn` (never runtime). */
  dependsOn?: string[];
  /** Shared store name when frontmatter `store` is a string; isolated (`true`) is omitted. */
  store?: string;
  /** Frontmatter `type:` when declared (currently only 'manager'). */
  type?: string;
  /** Server-computed lint findings on declared relationships (dangling/self/cycle). */
  warnings?: string[];
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
