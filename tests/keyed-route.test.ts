import { describe, expect, it } from 'bun:test';
import {
  agentRouteIdentity,
  changesetRouteIdentity,
  keyedRoute,
  sessionRouteIdentity,
  type RouteMatch,
} from '../src/cli/serve/web/lib/keyed-route';

const Page = (_props: RouteMatch) => null;

function keyFor(identity: (route: RouteMatch) => string, route: RouteMatch) {
  return keyedRoute(Page, identity)(route).key;
}

describe('keyedRoute', () => {
  it('renders the page with the route props and an identity key', () => {
    const route = { params: { sessionId: 'a' }, query: { project: 'p', token: 't' } };
    const vnode = keyedRoute(Page, sessionRouteIdentity)(route);
    expect(vnode.type).toBe(Page);
    expect(vnode.key).toBe('p:a');
    expect(vnode.props.params).toEqual(route.params);
    expect(vnode.props.query).toEqual(route.query);
  });

  it('gives each session, in each project, its own page instance', () => {
    const a = keyFor(sessionRouteIdentity, { params: { sessionId: 'a' }, query: { project: 'p' } });
    expect(keyFor(sessionRouteIdentity, { params: { sessionId: 'b' }, query: { project: 'p' } })).not.toBe(a);
    expect(keyFor(sessionRouteIdentity, { params: { sessionId: 'a' }, query: { project: 'q' } })).not.toBe(a);
  });

  it('keeps the session page when only its resume token changes', () => {
    const before = keyFor(sessionRouteIdentity, { params: { sessionId: 'a' }, query: { project: 'p', token: 'one' } });
    const after = keyFor(sessionRouteIdentity, { params: { sessionId: 'a' }, query: { project: 'p', token: 'two' } });
    expect(after).toBe(before);
  });

  it('keys changesets and agents by project and id', () => {
    expect(keyFor(changesetRouteIdentity, { params: { projectId: 'p', sessionId: 'a' }, query: {} }))
      .not.toBe(keyFor(changesetRouteIdentity, { params: { projectId: 'p', sessionId: 'b' }, query: {} }));
    expect(keyFor(agentRouteIdentity, { params: { project: 'p', agent: 'one' }, query: {} }))
      .not.toBe(keyFor(agentRouteIdentity, { params: { project: 'p', agent: 'two' }, query: {} }));
  });
});
