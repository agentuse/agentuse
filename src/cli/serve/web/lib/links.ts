/**
 * Deep links to the tidy-up page.
 *
 * Its own module so a component can link to the page without importing the
 * route that renders it.
 */

/**
 * The tidy-up progress/result page.
 *
 * Addressed by query string rather than path segments because an agent's path
 * contains slashes of its own, which would be ambiguous against the
 * `/agents/:project/:agent*` detail hub.
 *
 * `start: true` asks the page to kick off a run; `job` opens an existing one.
 */
export function learningsTidyHref(
  projectId: string,
  runPath: string,
  opts: { job?: string; start?: boolean } = {},
): string {
  const params = new URLSearchParams({ project: projectId, path: runPath });
  if (opts.job) params.set('job', opts.job);
  if (opts.start) params.set('start', '1');
  return `/learnings/tidy?${params.toString()}`;
}
