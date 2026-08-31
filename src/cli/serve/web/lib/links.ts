/**
 * Deep links to routed pages.
 *
 * Its own module so a component can link to a page without importing the
 * route that renders it.
 */

export type AgentDetailTab = 'jobs' | 'learnings' | 'source';
export type AgentTutorialStep = 'run' | 'schedule' | null;

export interface AgentDetailLinkOptions {
  tab?: AgentDetailTab;
  spotlightRun?: boolean;
}

/** Build the deep link a list row points at: /agents/<project>/<runPath>. */
export function agentDetailHref(
  projectId: string,
  runPath: string,
  options: AgentDetailLinkOptions = {},
): string {
  const segs = runPath.split('/').map(encodeURIComponent).join('/');
  const path = `/agents/${encodeURIComponent(projectId)}/${segs}`;
  const params = new URLSearchParams();
  if (options.tab) params.set('tab', options.tab);
  if (options.spotlightRun) params.set('onboarding', 'first-agent');
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** Read the agent-detail entry state from a deep link. */
export function agentDetailViewState(search: string): { tab: AgentDetailTab; tutorialStep: AgentTutorialStep } {
  const params = new URLSearchParams(search);
  const requested = params.get('tab');
  const tab: AgentDetailTab = requested === 'learnings' || requested === 'source' ? requested : 'jobs';
  const onboarding = params.get('onboarding');
  const tutorialStep: AgentTutorialStep = onboarding === 'first-agent'
    ? 'run'
    : onboarding === 'first-agent-schedule'
      ? 'schedule'
      : null;
  return { tab, tutorialStep };
}

/** Stable onboarding destination used across provider setup reloads and app
 * focus changes. Keeping project discovery in the URL prevents an established
 * project from falling back to the dashboard mid-flow. */
export function projectDiscoveryHref(projectId: string, options: { connectProvider?: boolean } = {}): string {
  const params = new URLSearchParams({ project: projectId });
  if (options.connectProvider) params.set('provider', 'connect');
  return `/onboarding?${params.toString()}`;
}

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
