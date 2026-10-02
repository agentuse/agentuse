import { describe, expect, it } from 'bun:test';
import {
  agentDraftRouteIdentity,
  agentRevisionRouteIdentity,
  agentRouteIdentity,
  changesetRouteIdentity,
  keyedRoute,
  learningsTidyRouteIdentity,
  sessionRouteIdentity,
  storeItemRouteIdentity,
  storeItemsRouteIdentity,
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

  it('gives each session its own context diagnostic page', () => {
    // /sessions/:sessionId/context?project=&token= shares the session page's address shape.
    const route = (sessionId: string, project: string, token: string) => ({ params: { sessionId }, query: { project, token } });
    const a = keyFor(sessionRouteIdentity, route('a', 'p', 'one'));
    expect(keyFor(sessionRouteIdentity, route('b', 'p', 'one'))).not.toBe(a);
    expect(keyFor(sessionRouteIdentity, route('a', 'q', 'one'))).not.toBe(a);
    expect(keyFor(sessionRouteIdentity, route('a', 'p', 'two'))).toBe(a);
  });

  it('keys changesets and agents by project and id', () => {
    expect(keyFor(changesetRouteIdentity, { params: { projectId: 'p', sessionId: 'a' }, query: {} }))
      .not.toBe(keyFor(changesetRouteIdentity, { params: { projectId: 'p', sessionId: 'b' }, query: {} }));
    expect(keyFor(agentRouteIdentity, { params: { project: 'p', agent: 'one' }, query: {} }))
      .not.toBe(keyFor(agentRouteIdentity, { params: { project: 'p', agent: 'two' }, query: {} }));
  });

  it('gives each store, in each project and deep-linked filter, its own page instance', () => {
    const route = (store: string, query: Record<string, string> = {}) => ({ params: { store }, query });
    const a = keyFor(storeItemsRouteIdentity, route('leads'));
    expect(keyFor(storeItemsRouteIdentity, route('deals'))).not.toBe(a);
    expect(keyFor(storeItemsRouteIdentity, route('leads', { project: 'p' }))).not.toBe(a);
    expect(keyFor(storeItemsRouteIdentity, route('leads', { q: 'acme' }))).not.toBe(a);
    expect(keyFor(storeItemsRouteIdentity, route('leads', { agent: 'scout' }))).not.toBe(a);
  });

  it('keeps the store page when only the highlighted row changes', () => {
    const before = keyFor(storeItemsRouteIdentity, { params: { store: 'leads' }, query: { project: 'p', highlight: 'one' } });
    const after = keyFor(storeItemsRouteIdentity, { params: { store: 'leads' }, query: { project: 'p', highlight: 'two' } });
    expect(after).toBe(before);
  });

  it('gives each store item its own page instance', () => {
    const route = (store: string, item: string, project?: string) => ({ params: { store, item }, query: project ? { project } : {} });
    const a = keyFor(storeItemRouteIdentity, route('leads', 'one'));
    expect(keyFor(storeItemRouteIdentity, route('leads', 'two'))).not.toBe(a);
    expect(keyFor(storeItemRouteIdentity, route('deals', 'one'))).not.toBe(a);
    expect(keyFor(storeItemRouteIdentity, route('leads', 'one', 'p'))).not.toBe(a);
  });

  it('keys agent drafts by project and job', () => {
    const a = keyFor(agentDraftRouteIdentity, { params: {}, query: { project: 'p', job: 'one' } });
    expect(keyFor(agentDraftRouteIdentity, { params: {}, query: { project: 'p', job: 'two' } })).not.toBe(a);
    expect(keyFor(agentDraftRouteIdentity, { params: {}, query: { project: 'q', job: 'one' } })).not.toBe(a);
  });

  it('keys agent revisions by project and session, not by resume token', () => {
    const a = keyFor(agentRevisionRouteIdentity, { params: {}, query: { project: 'p', session: 'one', token: 't1' } });
    expect(keyFor(agentRevisionRouteIdentity, { params: {}, query: { project: 'p', session: 'two', token: 't1' } })).not.toBe(a);
    expect(keyFor(agentRevisionRouteIdentity, { params: {}, query: { project: 'q', session: 'one', token: 't1' } })).not.toBe(a);
    expect(keyFor(agentRevisionRouteIdentity, { params: {}, query: { project: 'p', session: 'one', token: 't2' } })).toBe(a);
  });

  it('keys a tidy-up by agent and job, not by the start request', () => {
    const route = (query: Record<string, string>) => ({ params: {}, query: { project: 'p', path: 'agents/a.agentuse', ...query } });
    const a = keyFor(learningsTidyRouteIdentity, route({ job: 'one' }));
    expect(keyFor(learningsTidyRouteIdentity, route({ job: 'two' }))).not.toBe(a);
    expect(keyFor(learningsTidyRouteIdentity, route({ job: 'one', path: 'agents/b.agentuse' }))).not.toBe(a);
    expect(keyFor(learningsTidyRouteIdentity, route({ job: 'one', project: 'q' }))).not.toBe(a);
    expect(keyFor(learningsTidyRouteIdentity, route({ start: '1' })))
      .toBe(keyFor(learningsTidyRouteIdentity, route({})));
  });
});
