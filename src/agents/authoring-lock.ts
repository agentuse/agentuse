import { join } from 'node:path';
import { getProjectDirSync } from '../storage/paths.js';
import { withOwnershipLock } from '../utils/ownership-lock.js';

/**
 * One lock per project for the authoring records (drafts, revisions, change
 * sets) and the project files their Apply and Restore write.
 *
 * Apply and Restore hold it end to end, so two of them cannot both pass their
 * base-hash checks and then overwrite each other, and a read that finds an
 * `applying`/`restoring` marker can tell a live operation (lock held: wait for
 * it) from an interrupted one (lock free or its owner dead: reconcile). Record
 * mutations take it too, so a read-modify-write cannot interleave with another
 * writer. It is cross-process because the worker's submit tools write change
 * set records while the daemon applies them.
 *
 * Not reentrant: code already holding it must use the lock-free read and write
 * helpers, never the public readers that reconcile.
 */
export function withAuthoringLock<T>(projectRoot: string, operation: () => Promise<T>): Promise<T> {
  return withOwnershipLock(join(getProjectDirSync(projectRoot), 'authoring.lock'), operation, {
    label: 'authoring',
  });
}
