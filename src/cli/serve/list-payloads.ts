/**
 * The session and approval list payloads the dashboard polls and the SSE hubs
 * stream, with the row and filter shapes they carry. Moved out of serve.ts.
 */
import type { SessionTrigger } from "../../session/types";
import type { SessionPurpose, SessionResult } from "./types";

export type ApprovalSummaryStatus = 'pending' | 'approved' | 'rejected' | 'commented' | 'expired' | 'errored';

export type ApprovalSessionFilter = 'pending' | 'completed' | 'errored';

export type SessionStatusFilter = 'preparing' | 'running' | 'suspended' | 'completed' | 'error' | 'incomplete';

/** Triage axis, orthogonal to status: has an ended run been reviewed-and-discarded yet? */
export type SessionTriageFilter = 'undismissed' | 'dismissed';

export type SessionWindowFilter = `${number}h` | `${number}d` | 'all';

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
  reviewHref?: string;
  errorCode?: string;
  errorMessage?: string;
  /** The parent can resume by retrying its interrupted delegated child. */
  cascadeRetryable?: boolean;
  channelMessage?: { type?: string; channel?: string; ts?: string; actionTs?: string; url?: string };
  channels?: {
    slack?: Array<{ channel: string; ts: string; channelId?: string; events: Array<'approval' | 'completion' | 'failure'> }>;
  };
}

export type ApprovalRow = ApprovalSummary & { project: string };

export interface ApprovalListPayload {
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

export interface SessionSummary {
  sessionId: string;
  parentSessionId?: string;
  agent: {
    id: string;
    name: string;
    description?: string;
    filePath?: string;
    isSubAgent?: boolean;
  };
  status: string;
  trigger: SessionTrigger;
  createdAt: number;
  updatedAt: number;
  errorCode?: string;
  errorMessage?: string;
  /** Reviewer discarded this ended failed run; needs-attention surfaces skip it. */
  dismissedAt?: number;
  /** Reviewer opened this ended run's page (see serve/types). */
  reviewedAt?: number;
  /** record_metric facts this run wrote (see serve/types). */
  results?: SessionResult[];
  mock?: boolean;
  /** Suspended parent parked on a running delegated child (see serve/types). */
  subagentActive?: boolean;
  finalResponse?: string;
  purpose?: SessionPurpose;
}

export type SessionRow = SessionSummary & { project: string };

/** Status split of a session-list window, used by the list's filter chips. */
export interface SessionStatusCounts {
  all: number;
  running: number;
  done: number;
  /** Crashes only. An agent-declared incomplete run is counted separately. */
  failed: number;
  incomplete: number;
}

export interface SessionsPayload {
  success: true;
  sessions: SessionRow[];
  window: { value: string; days?: number | 'all'; hours?: number; updatedAfter?: number };
  agent?: string;
  status?: string;
  triage?: SessionTriageFilter;
  trigger?: SessionTrigger;
  approval?: string;
  /** Free-text search echoed back, matched against agent id/name and final output. */
  q?: string;
  /** How the window's rows split by status, BEFORE the status filter narrows the
   *  page. Lets the list's status chips show their size without a round trip. */
  counts: SessionStatusCounts;
  errors: Array<{ projectId: string; message: string }>;
  /** Present only when the caller opted into cursor pagination. */
  nextCursor?: string;
  limit?: number;
}
