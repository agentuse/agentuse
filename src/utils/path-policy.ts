import { isAbsolute, relative } from 'node:path';

export interface PathContainmentOptions {
  /** Whether `child === parent` is accepted. Defaults to true. */
  allowEqual?: boolean;
}

/**
 * Compare already-resolved paths without relying on string prefixes.
 *
 * Callers that protect against symlink escapes must realpath both arguments
 * before invoking this helper. Keeping that I/O at the boundary makes the
 * policy usable by synchronous and asynchronous code alike.
 */
export function isPathInside(
  parent: string,
  child: string,
  options: PathContainmentOptions = {},
): boolean {
  const rel = relative(parent, child);
  if (rel === '') return options.allowEqual !== false;
  return rel !== '..' && !rel.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(rel);
}

/**
 * Shared denylist for project files that must never enter a reviewer-visible
 * surface. This is deliberately stricter than ordinary agent filesystem
 * permissions: even example environment files can reveal deployment details.
 */
export function isBlockedReviewPath(projectRoot: string, candidate: string): boolean {
  const segments = relative(projectRoot, candidate).split(/[\\/]+/u);
  return segments.some((segment) => segment.startsWith('.env'))
    || segments[0] === '.git'
    || segments[0] === 'node_modules'
    || (segments[0] === '.agentuse'
      && (segments[1] === 'store' || segments[1] === 'sessions' || segments[1] === 'env'));
}
