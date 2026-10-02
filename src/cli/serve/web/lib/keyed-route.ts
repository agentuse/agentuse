import { h, type ComponentType, type VNode } from 'preact';

/** What preact-iso hands a routed component. */
export interface RouteMatch {
  params: Record<string, string | undefined>;
  query: Record<string, string | undefined>;
}

/**
 * Give a routed page one instance per identity. preact-iso reuses the mounted
 * component whenever the route's component is unchanged, so without a key
 * /sessions/A -> /sessions/B keeps A's dialogs, in-flight submits and refs, and
 * A's late responses paint over B. A key resets all of it at once, including
 * state added later. Call at module level: a fresh wrapper per render would
 * look like a different route to the router.
 */
export function keyedRoute(
  Component: ComponentType<RouteMatch>,
  identity: (route: RouteMatch) => string,
): (props: RouteMatch) => VNode<RouteMatch> {
  return function KeyedRoute(props: RouteMatch) {
    return h(Component, { ...props, key: identity(props) });
  };
}

/** A session page, and its context diagnostic, is one session in one project.
 *  The resume token is left out: it can change under a live session, and a
 *  remount would drop its logs. */
export const sessionRouteIdentity = ({ params, query }: RouteMatch): string =>
  `${query.project ?? ''}:${params.sessionId ?? ''}`;

export const changesetRouteIdentity = ({ params }: RouteMatch): string =>
  `${params.projectId ?? ''}:${params.sessionId ?? ''}`;

export const agentRouteIdentity = ({ params }: RouteMatch): string =>
  `${params.project ?? ''}:${params.agent ?? ''}`;

/** A store page is one store, in one project or across all of them. `q` and
 *  `agent` only seed its filters on mount, so a link that changes them has to
 *  remount to apply. `highlight` is left out: the page scrolls to it in place. */
export const storeItemsRouteIdentity = ({ params, query }: RouteMatch): string =>
  `${query.project ?? ''}:${params.store ?? ''}:${query.q ?? ''}:${query.agent ?? ''}`;

export const storeItemRouteIdentity = ({ params, query }: RouteMatch): string =>
  `${query.project ?? ''}:${params.store ?? ''}:${params.item ?? ''}`;

/** Draft, revision and tidy-up pages are addressed by query, not path. */
export const agentDraftRouteIdentity = ({ query }: RouteMatch): string =>
  `${query.project ?? ''}:${query.job ?? ''}`;

/** The resume token is left out, as on the session page. */
export const agentRevisionRouteIdentity = ({ query }: RouteMatch): string =>
  `${query.project ?? ''}:${query.session ?? ''}`;

/** One tidy-up job for one agent. `start` is left out: it only asks the page to
 *  start a job, and the job id that comes back changes the key anyway. */
export const learningsTidyRouteIdentity = ({ query }: RouteMatch): string =>
  `${query.project ?? ''}:${query.path ?? ''}:${query.job ?? ''}`;
