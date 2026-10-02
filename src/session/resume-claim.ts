import { join } from 'node:path';
import { withOwnershipLock } from '../utils/ownership-lock';

/**
 * Run `operation` under a session's durable `.resume-claim`, the per-session
 * lock that approval apply/rollback, cascade bookmark completion, and Stop
 * contend on. It lives in the session directory, so every serve worker and
 * CLI process serializes on the same claim. Not reentrant: never nest two
 * claims for the same session.
 */
export function withSessionResumeClaim<T>(
  sessionDir: string,
  sessionId: string,
  operation: () => Promise<T>
): Promise<T> {
  return withOwnershipLock(join(sessionDir, '.resume-claim'), operation, {
    staleMs: 30_000,
    retryMs: 10,
    maxWaitMs: 35_000,
    label: `resume:${sessionId}`,
  });
}
