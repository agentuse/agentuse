/**
 * Settling a `running` authoring record (an agent revision or a change set)
 * against its durable session.
 *
 * The host callback that normally settles such a record lives in daemon
 * memory, so a restart, or a worker that outlived its daemon, leaves the record
 * `running` with nothing left to move it. Reads call this instead: the durable
 * session says whether the turn is over, and a turn that is over without the
 * submission that would have moved the record is a failed turn.
 */
import type { SessionStatusInfo } from "./session-types";
import type { WorkerExecuteError } from "./worker-types";

export interface AuthoringFailure {
  code: string;
  message: string;
}

/** What each way a session can show its turn ended is recorded as. */
export interface AuthoringSessionFailures {
  /** No durable session once the start-up window has passed. */
  missing: AuthoringFailure;
  /** The session errored without naming its own code or message. */
  failed: AuthoringFailure;
  /** The session completed without the submission that moves the record. */
  notSubmitted: AuthoringFailure;
}

export const REVISION_SESSION_FAILURES: AuthoringSessionFailures = {
  missing: { code: 'REVISION_SESSION_MISSING', message: 'The revision session was lost before execution started' },
  failed: { code: 'REVISION_SESSION_FAILED', message: 'The revision session did not finish successfully' },
  notSubmitted: { code: 'REVISION_NOT_SUBMITTED', message: 'The revision session ended without submitting a validated outcome' },
};

export const CHANGESET_SESSION_FAILURES: AuthoringSessionFailures = {
  missing: { code: 'CHANGESET_SESSION_MISSING', message: 'The change set session was lost before execution started' },
  failed: { code: 'CHANGESET_SESSION_FAILED', message: 'The change set session did not finish successfully' },
  notSubmitted: {
    code: 'CHANGESET_NOT_SUBMITTED',
    message: 'The change set session ended without submitting a validated outcome',
  },
};

/** The one worker call this needs. */
export interface AuthoringSessionStatusSource {
  getSessionStatusInfo(options: {
    projectRoot: string;
    sessionId: string;
  }): Promise<{ success: true; session: SessionStatusInfo } | WorkerExecuteError>;
}

/** The durable record is written just before its preparing session shell. A
 *  missing session younger than this is that handoff, not a loss. */
const SESSION_START_GRACE_MS = 30_000;

/**
 * Fail a `running` record whose durable session has ended without settling it,
 * and leave it alone otherwise: a session still running, suspended on an
 * approval, or unreadable is not evidence of anything. Returns what `fail`
 * returned, or undefined when nothing was settled.
 *
 * The caller must skip a record whose session is mid-handoff (a request-changes
 * continuation): its durable session still shows the previous turn's terminal
 * status.
 */
export async function settleRunningAuthoringRecord<T>(input: {
  worker: AuthoringSessionStatusSource | undefined;
  projectRoot: string;
  sessionId: string;
  createdAt: number;
  failures: AuthoringSessionFailures;
  fail: (error: AuthoringFailure) => Promise<T | undefined>;
}): Promise<T | undefined> {
  if (!input.worker) return undefined;
  const status = await input.worker.getSessionStatusInfo({
    projectRoot: input.projectRoot,
    sessionId: input.sessionId,
  });
  if (!status.success) {
    if (status.error.code !== 'SESSION_NOT_FOUND') return undefined;
    if (Date.now() - input.createdAt < SESSION_START_GRACE_MS) return undefined;
    return input.fail(input.failures.missing);
  }
  if (status.session.sessionStatus === 'error') {
    return input.fail({
      code: status.session.errorCode ?? input.failures.failed.code,
      message: status.session.errorMessage ?? input.failures.failed.message,
    });
  }
  if (status.session.sessionStatus === 'completed') return input.fail(input.failures.notSubmitted);
  return undefined;
}
