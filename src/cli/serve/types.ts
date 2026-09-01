import type { ActiveContextUsage, SessionTrigger } from "../../session/types";
import type { DescendantBreadcrumb, ImportantDescendantEvent, ImportantDescendantKind, ImportantDescendantSummary } from "../../session/important-descendants";

export type { SessionTrigger };

export interface RunRequest {
  agent: string;
  project?: string;
  prompt?: string;
  model?: string;
  timeout?: number;
  maxSteps?: number;
  sessionId?: string;
  /** Best-effort caller report; not an authentication claim. */
  reportedSurface?: 'web_ui';
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

/**
 * One attributable slice of what the model was actually sent. Layers are
 * returned in send order (system messages first, then the user turn), so the
 * diagnostic page reads top-to-bottom as the model saw it.
 *
 * Everything here is reconstructed from what a run already persists - the
 * resolved `system[]` array, the resolved instructions, and the tool snapshot -
 * so it works on sessions that ran before this page existed.
 */
/**
 * How many of an agent's stored corrections the `learnings` layer's text
 * actually carried into the run.
 *
 * `applied` is always known: with no marker it is recoverable by counting the
 * bullets in the injected block. `active` and `cap` come from the run's
 * corrections marker, so they are absent on runs recorded before that marker
 * existed. They are left absent rather than defaulted, because "10 applied" and
 * "10 of 10 applied" are different claims and only one of them is supported.
 */
export interface ContextCorrectionCounts {
  /** Injected into this run's instructions. */
  applied: number;
  /** Active corrections stored for the agent, injected and dormant together. */
  active?: number;
  /** The per-run injection cap that decided the split. */
  cap?: number;
}

export interface ContextStackLayer {
  id: string;
  kind: 'system' | 'instructions' | 'approval' | 'skills' | 'learnings' | 'prompt' | 'tools';
  label: string;
  /** Set on the `learnings` layer only: what the cap let through, and what it
   *  held back. */
  corrections?: ContextCorrectionCounts;
  /** Where this text came from, when the origin is a real file or a config
   *  switch worth naming (the agent file, a frontmatter flag, the learning store). */
  source?: string;
  /** One line on why this is in the context, for readers who did not write the runtime. */
  note?: string;
  chars: number;
  /** chars/4 heuristic, the same one the runtime's context manager uses. Never
   *  a provider-reported count - `measured` carries the real numbers. */
  estTokens: number;
  /** Full text. Omitted on the tools layer, whose weight is in `tools` instead. */
  text?: string;
}

export interface ContextToolRow {
  name: string;
  description?: string;
  /** Serialized JSON Schema the model receives for this tool. */
  schema?: string;
  chars: number;
  estTokens: number;
}

/**
 * A file the agent pulled into the context window mid-run, via a read tool.
 * Distinct from the layers above: those are the opening prompt, these arrive
 * as tool results while the run is going, and a file read twice costs its
 * tokens twice.
 */
/**
 * The text of one read, as the model received it - line numbering and all.
 * `text` may be shortened for transport; `chars` is always the real size, so
 * the weight figures stay honest even when the preview is cut.
 */
export interface ContextFileReadContent {
  chars: number;
  text: string;
  /** True when `text` is a prefix of what the model actually got. */
  truncated: boolean;
}

export interface ContextFileRead {
  /** Absolute path when known, otherwise the best label the tool input gives. */
  path: string;
  /** Which tool pulled it in, e.g. `tools__filesystem_read`. */
  tool: string;
  /** How many times this run read it. Repeats each cost context again. */
  reads: number;
  /** Characters that actually entered the context, summed over every read. */
  chars: number;
  estTokens: number;
  /** Set when the tool truncated the file: the full size it was cut down from. */
  truncatedFrom?: number;
  firstReadAt?: number;
  /**
   * What the model received, one entry per read, in read order. Omitted
   * entirely once the payload budget is spent; `reads` may exceed its length
   * when a file was read more times than the page will show.
   */
  content?: ContextFileReadContent[];
}

/**
 * One tool's activity for this run: how often it ran, how often it failed, and
 * how much window its results took. Counted from the session's tool parts, so
 * it is the whole run rather than however much log a page has loaded.
 *
 * Calls and result size are worth seeing together but are not the same story:
 * a tool called twice can return more text than one called twenty times, and
 * it is the characters, not the calls, that occupy the context.
 */
/**
 * One call of one tool: what it was asked to do, and how much its result
 * added. A tool's total says it was expensive; this says which call made it
 * so, which is usually the thing worth changing.
 */
export interface ContextToolCallDetail {
  /** The command, path, or argument that identifies this call. */
  label: string;
  chars: number;
  estTokens: number;
  status: 'ok' | 'failed' | 'pending';
}

export interface ContextToolResultStat {
  tool: string;
  /** Completed calls. */
  calls: number;
  /** Calls that errored. They return no result text, so they add no `chars`. */
  failed: number;
  /**
   * Calls still in flight - running, or parked on an approval gate. They have
   * no result yet, so they add no `chars`, but a suspended run's pending call
   * is often the most interesting row on the page.
   */
  pending: number;
  chars: number;
  estTokens: number;
  /**
   * True for the read tools, whose result text is itemised as `fileReads`
   * instead. Their `chars` are excluded from `traffic.toolResultChars` so the
   * two are never counted twice.
   */
  countedAsFiles?: boolean;
  /**
   * The individual calls, heaviest first. Capped, so `calls` can exceed its
   * length on a tool called very often.
   */
  callDetails?: ContextToolCallDetail[];
}

export interface SessionContextPayload {
  sessionId: string;
  model?: string;
  agent: {
    id: string;
    name: string;
    filePath?: string;
  };
  createdAt?: number;
  layers: ContextStackLayer[];
  tools: ContextToolRow[];
  /** Files read during the run, heaviest first. Empty when the run read none. */
  fileReads: ContextFileRead[];
  /**
   * What the run added to the window as it went: the model's own words and
   * tool arguments, and the results its tools returned. Read-tool results are
   * not included here - they are itemised as `fileReads`.
   */
  traffic: {
    outputChars: number;
    outputEstTokens: number;
    toolResultChars: number;
    toolResultEstTokens: number;
    /** Per tool, heaviest first. Sums to `toolResultChars`. */
    toolResults: ContextToolResultStat[];
  };
  totals: {
    chars: number;
    estTokens: number;
    /** Opening stack plus every mid-run file read. */
    withFileReadsEstTokens: number;
  };
  /** Provider-reported usage, when the run got far enough to report any. This
   *  is what calibrates the estimates above. */
  measured?: {
    input: number;
    output: number;
    reasoning: number;
    cacheRead: number;
    cacheWrite: number;
    context?: ActiveContextUsage;
  };
  /** True when the run compacted, meaning the live window no longer matches
   *  the opening stack shown here. */
  compacted?: boolean;
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
  /** Absolute directory watched by serve for this project's agent files. */
  projectPath?: string;
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
  /** Important sessions at any depth, plus context-only bridge ancestors. The
   * direct-child field above is intentionally retained for API compatibility. */
  importantDescendants?: ImportantDescendantSummary[];
  /** Verification markers with no real Judge child session. These remain
   * events owned by the session that ran verification, never synthetic sessions. */
  importantDescendantEvents?: ImportantDescendantEvent[];
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
  /** On a `type: 'corrections'` entry: how many stored corrections the run
   *  injected, how many were active, and the cap that decided the split. The
   *  row is worded client-side, so these travel as numbers rather than a
   *  sentence — the session log and the result verdict phrase them differently
   *  and would otherwise need the server to compose both. */
  applied?: number;
  active?: number;
  cap?: number;
  subagentSession?: LogSubagentSession;
  details?: ApprovalLogDetails;
}

export interface LogSubagentSession extends ChildSessionSummary {
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

export type LogSubagentEvent = ImportantDescendantEvent & {
  href?: string;
  displayStatus: string;
};

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
  /** Runtime state of the declared schedule; false when locally paused. */
  scheduleEnabled?: boolean;
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
