import type { ActiveContextUsage, ReviewEscalation, SessionTrigger } from '../session';

export interface ExecuteRequest {
  id: string;
  type: 'execute' | 'resume' | 'continue-session' | 'finish-cascade' | 'retry-cascade' | 'approval-info' | 'session-status' | 'create-preparing-session' | 'fail-preparing-session' | 'session-context' | 'sweep-expired' | 'reconcile-orphans' | 'list-approvals' | 'list-sessions' | 'session-final-responses' | 'stop-session' | 'mark-session-reviewed' | 'reopen-gate' | 'invalidate-lists' | 'reset-provider-plugins' | 'release';
  agentPath?: string;
  /** In-memory agent definition. Fresh execute only; never persisted as a file. */
  agentContent?: string;
  agentName?: string;
  agentId?: string;
  agentDescription?: string;
  projectRoot: string;
  /** invalidate-lists: hold the short list TTL for a window (start pokes). */
  externalActivity?: boolean;
  prompt?: string;
  model?: string;
  timeout?: number;
  /** Runtime timeout persisted on a preparing shell; distinct from IPC timeout. */
  sessionTimeout?: number;
  maxSteps?: number;
  debug?: boolean;
  sessionId?: string;
  /** Pre-assigned id for a fresh `execute` (serve detached run). */
  newSessionId?: string;
  /** Fresh execution must atomically promote an existing preparing shell. */
  preparedSession?: boolean;
  preparerOwner?: { pid: number; procStartedAt?: string };
  errorCause?: string;
  errorCode?: string;
  errorMessage?: string;
  toolResult?: unknown;
  resumeToken?: string;
  allowHistorical?: boolean;
  approvalCreatedAfter?: number;
  sessionsUpdatedAfter?: number;
  includeSubagents?: boolean;
  sessionsLimit?: number;
  sessionsPerAgent?: number;
  sessionsMock?: 'exclude' | 'include' | 'only';
  sessionRefs?: Array<{ sessionId: string; agentId: string }>;
  /** reconcile-orphans: only sessions last touched before this timestamp (the
   *  reconciling worker's ready time) are treated as orphans of a dead worker. */
  reconcileCutoff?: number;
  workerDeath?: import('./death').WorkerDeath;
  // Trusted, server-set only: when the serve process has already authorized
  // the viewer (session token / api key / local), it asks for full approval
  // info regardless of the gate resumeToken. Never derived from client input.
  skipTokenCheck?: boolean;
  trigger?: SessionTrigger;
  runChannelHandles?: Array<{ channel: string; ts: string; channelId?: string; events: Array<'approval' | 'completion' | 'failure'> }>;
  reason?: string;
  /** Trusted lifecycle evidence, separate from the operator's display text. */
  stopCause?: 'user_stopped' | 'client_disconnect';
  /** stop-session: reviewer-initiated, so an already-ended failed session is
   *  stamped dismissedAt (reviewed) instead of being a no-op. */
  dismissEnded?: boolean;
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

export interface SessionTokenUsage {
  input: number;
  cachedInput: number;
  output: number;
  context?: ActiveContextUsage;
}

export type ApprovalSummaryStatus = 'pending' | 'approved' | 'rejected' | 'commented' | 'expired' | 'errored';

export interface ApprovalChange {
  label?: string;
  content: string;
  displayContent?: string;
  /** A multi-post submission (a thread), one entry per post in order. When
   *  present, `displayContent` holds the same posts joined for text surfaces. */
  displayParts?: string[];
  /** External media that belongs to this exact action and should be previewed
   *  inline in the approval card. */
  mediaUrls?: string[];
  optionId?: string;
}

export interface ApprovalReference {
  label?: string;
  author?: string;
  title?: string;
  url?: string;
  excerpt?: string;
}

export interface ApprovalOption {
  id: string;
  label: string;
  description?: string;
  recommended?: boolean;
}

/** Structured verdict of one verify marker (mirrors serve/types LogVerifySummary). */
export interface LogVerifySummary {
  verdict: 'pass' | 'fail' | 'error' | 'skipped';
  attempt: number;
  maxAttempts: number;
  judge?: string;
  critique?: string;
  candidates?: Array<{ id: string; pass: boolean; critique?: string; settled?: boolean }>;
}

export interface ApprovalLogDetails {
  resumeToken?: string;
  /** Strict automated review exhausted; this gate accepts revision guidance or stop, not approval. */
  reviewEscalation?: ReviewEscalation;
  toolApproval?: {
    approvalId: string;
    toolName: string;
    canonicalInput: string;
    canonicalInputDigest?: string;
    signedRawInput: string;
    signedRawInputDigest?: string;
    signature?: string;
  };
  prompt?: string;
  /** Model-declared goal of this call (the injected `intent` parameter). */
  intent?: string;
  /** Earlier failed call this tool call declares it is trying to recover. */
  recoversCallId?: string;
  /** Later successful call that recovered this failed call. */
  recoveredByCallId?: string;
  /** Relationship was inferred from an immediate corrected retry. */
  recoveryInferred?: boolean;
  input?: string;
  output?: string;
  returnedBytes?: number;
  contextAddedTokens?: number;
  responseMetadata?: import('../telemetry/response-metadata').ResponseMetadata;
  requestFingerprint?: import('../telemetry/request-fingerprint').RequestFingerprint;
  modelStepId?: string;
  /** Bounded tail of a still-running tool call, replaced by `output` when it finishes. */
  liveOutput?: string;
  tokenUsage?: {
    // Model request usage, displayed once per step.
    input: number;
    output: number;
    cachedInput: number;
    sharedCalls?: number;
  };
  summary?: string;
  context?: string;
  risk?: string;
  draft?: string;
  changes?: ApprovalChange[];
  reference?: ApprovalReference;
  options?: ApprovalOption[];
  draftUrl?: string;
  artifactUrl?: string;
  artifactPaths?: string[];
  /** Gate-time snapshots of referenced media (see session/gate-artifacts). */
  artifactSnapshots?: Array<{ path: string; hash: string; ext: string; bytes?: number }>;
  toolOutputArtifact?: {
    path: string;
    bytes?: number;
    originalChars?: number;
  };
  /** A completed sub-agent call's result as the child declared it (see
   *  subagentResultFromState), so the parent's row reads on its own. */
  subagentResult?: {
    headline?: string;
    incomplete?: string;
    artifacts?: string[];
    body?: string;
  };
  /** The run's own verdict and report as delivered through `report_complete` /
   *  `report_incomplete` (see collectRunOutcomes), rendered on that call's row
   *  instead of behind its expand toggle. */
  runOutcome?: {
    kind: 'complete' | 'incomplete';
    headline: string;
    body?: string;
    artifacts?: string[];
  };
  /** A deliverable saved by `tools__artifact_save`, rendered as a viewable tile. */
  savedArtifact?: {
    url: string;
    path: string;
    title?: string;
    group?: string;
  };
  /** The pre-review verdict that immediately preceded this gate, so the
   *  reviewer sees which candidate the judge failed and why without hunting
   *  the log for the marker. `sessionId` names the judge child; serve
   *  resolves it to `sessionHref`. */
  judge?: LogVerifySummary & { sessionId?: string; sessionHref?: string; previous?: LogVerifySummary };
  decisionStatus?: string;
  decisionComment?: string;
  decisionChoice?: string;
  decisionReviewer?: string;
  errorMessage?: string;
}

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
  /** The gate needs revision guidance after strict automated review exhausted. */
  needsRevisionGuidance?: boolean;
  /** Which look this is for the reviewer: one more than the earlier gates in
   *  this session a human answered with a comment. Omitted on round one. */
  round?: number;
  suspendedAt?: number;
  expiresAt?: number;
  createdAt?: number;
  decisionAt?: number;
  decisionStatus?: string;
  decisionComment?: string;
  decisionReviewer?: string;
  resumeToken?: string;
  errorCause?: string;
  errorCode?: string;
  errorMessage?: string;
  channelMessage?: { type?: string; channel?: string; ts?: string; actionTs?: string; url?: string };
  channels?: {
    slack?: Array<{ channel: string; ts: string; channelId?: string; events: Array<'approval' | 'completion' | 'failure'> }>;
  };
}

export interface ApprovalProjectionIndexV1 {
  version: 1;
  approvalGeneration: number;
  approvals: ApprovalSummary[];
}

export interface ApprovalProjectionIndexV2 {
  version: 2;
  approvalGeneration: number;
  approvals: ApprovalSummary[];
  /** Newest approval-relevant session-index timestamp in each root cascade.
   * Used to refresh only approval-bearing runs whose durable gate state changed. */
  sourceUpdatedAt: Record<string, number>;
}

export type ApprovalProjectionIndex = ApprovalProjectionIndexV1 | ApprovalProjectionIndexV2;
