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

/** A session page is one session in one project. The resume token is left out:
 *  it can change under a live session, and a remount would drop its logs. */
export const sessionRouteIdentity = ({ params, query }: RouteMatch): string =>
  `${query.project ?? ''}:${params.sessionId ?? ''}`;

export const changesetRouteIdentity = ({ params }: RouteMatch): string =>
  `${params.projectId ?? ''}:${params.sessionId ?? ''}`;

export const agentRouteIdentity = ({ params }: RouteMatch): string =>
  `${params.project ?? ''}:${params.agent ?? ''}`;
