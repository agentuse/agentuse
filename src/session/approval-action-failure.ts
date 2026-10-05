/**
 * Why an approval decision did not take effect, in the terms the approval card
 * acts on. Browser-safe: serve computes it for background resume failures and
 * the web page computes it for decision requests the server refused outright,
 * so both paths reach the card through the same kinds.
 */
export type ApprovalDecisionAction = 'approve' | 'reject' | 'comment';

export type ApprovalActionFailureKind =
  /** The provider rejected the saved credential. */
  | 'reconnect'
  /** No credential is configured for the provider. */
  | 'signin'
  /** The provider or its connection failed transiently. */
  | 'unavailable'
  /** The browser never got an answer from the AgentUse server. */
  | 'unreachable'
  /** The process that runs agents stopped before the decision was applied. */
  | 'interrupted'
  /** The gate was already answered or is already resuming. */
  | 'decided'
  /** The gate changed after the page loaded it. */
  | 'stale'
  /** The run can no longer be resumed by any decision. */
  | 'ended'
  | 'expired'
  | 'other';

export interface ApprovalActionFailure {
  action: ApprovalDecisionAction;
  kind: ApprovalActionFailureKind;
  /** Provider id, only when the failure itself named one. */
  provider?: string;
  /**
   * Resending the same decision is safe: the gate is still the one that was
   * decided, nothing was applied, and the failure is transient. Never derived
   * from the kind alone; the producer also confirms the gate state.
   */
  retryable: boolean;
  code: string;
  message: string;
}

export interface ApprovalFailureEvidence {
  code?: string | undefined;
  cause?: string | undefined;
  statusCode?: number | undefined;
}

const KIND_BY_CODE: Record<string, ApprovalActionFailureKind> = {
  PROVIDER_RECONNECT_REQUIRED: 'reconnect',
  WORKER_DIED: 'interrupted',
  WORKER_NOT_READY: 'interrupted',
  WORKER_UNAVAILABLE: 'interrupted',
  WORKER_PROTOCOL_ERROR: 'interrupted',
  WORKER_INTERRUPTED: 'interrupted',
  SESSION_NOT_SUSPENDED: 'decided',
  SESSION_RUNNING: 'decided',
  SESSION_PREPARING: 'decided',
  APPROVAL_RESUMING: 'decided',
  APPROVAL_NOT_FOUND: 'decided',
  PENDING_TOOL_NOT_FOUND: 'decided',
  RESUME_TOKEN_INVALID: 'stale',
  CASCADE_GATE_UNRESOLVABLE: 'ended',
  CASCADE_ORPHANED: 'ended',
  SESSION_NOT_RESUMABLE: 'ended',
  SESSION_CORRUPTED: 'ended',
  SESSION_NOT_FOUND: 'ended',
  APPROVAL_EXPIRED: 'expired',
};

const KIND_BY_CAUSE: Record<string, ApprovalActionFailureKind> = {
  provider_rate_limit: 'unavailable',
  provider_overloaded: 'unavailable',
  provider_timeout: 'unavailable',
  provider_server: 'unavailable',
  model_transport: 'unavailable',
  model_stall: 'unavailable',
  worker_interrupted: 'interrupted',
  worker_protocol: 'interrupted',
  request_deadline: 'interrupted',
};

export function approvalFailureKind(evidence: ApprovalFailureEvidence): ApprovalActionFailureKind {
  const { code, cause, statusCode } = evidence;
  if (code && Object.hasOwn(KIND_BY_CODE, code)) return KIND_BY_CODE[code]!;
  // AUTH_ERROR covers both a missing credential and a provider 401; only the
  // 401 is evidence that a saved credential was rejected.
  if (code === 'AUTH_ERROR' || cause === 'authentication') return statusCode === 401 ? 'reconnect' : 'signin';
  if (cause && Object.hasOwn(KIND_BY_CAUSE, cause)) return KIND_BY_CAUSE[cause]!;
  return 'other';
}

/** Kinds where an identical resend can succeed once the gate is confirmed open. */
export function isTransientApprovalFailure(kind: ApprovalActionFailureKind): boolean {
  return kind === 'unavailable' || kind === 'interrupted';
}

export function approvalDecisionAction(status: string): ApprovalDecisionAction | undefined {
  if (status === 'approve' || status === 'approved') return 'approve';
  if (status === 'reject' || status === 'rejected') return 'reject';
  if (status === 'comment') return 'comment';
  return undefined;
}
