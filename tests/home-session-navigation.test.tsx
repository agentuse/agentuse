import { describe, expect, it } from 'bun:test';
import { renderToString } from 'preact-render-to-string';
import type { SessionRow } from '../src/cli/serve/web/lib/api';
import { sessionDestinationHref } from '../src/cli/serve/web/lib/links';
import { FailedRow } from '../src/cli/serve/web/routes/home';

const failed: SessionRow = {
  sessionId: 'revision-session',
  project: 'my project',
  agent: { id: 'reviser', name: 'Revise Reddit Engage Reply' },
  status: 'error',
  errorMessage: 'Provider rate limited',
  trigger: 'manual',
  createdAt: 1,
  updatedAt: 2,
};

describe('home session navigation', () => {
  it.each(['revise', 'create'] as const)('opens failed %s changesets in their review page', (mode) => {
    const href = '/projects/my%20project/changesets/revision-session';
    const row: SessionRow = { ...failed, purpose: { kind: 'changeset', mode, href } };
    const html = renderToString(<FailedRow row={row} onDismiss={() => {}} />);
    expect(html).toContain(`href="${href}"`);
    expect(html).toContain('Provider rate limited');
    expect(html).toContain('Dismiss Revise Reddit Engage Reply');
    expect(html).not.toContain('href="/sessions/');
  });

  it('opens legacy revisions in their revision view', () => {
    const row: SessionRow = {
      ...failed,
      purpose: { kind: 'agent-revision', targetAgentName: 'Reddit Engage Reply' },
    };
    expect(sessionDestinationHref(row)).toBe('/agents/revision?project=my+project&session=revision-session');
    expect(renderToString(<FailedRow row={row} onDismiss={() => {}} />)).toContain('href="/agents/revision?');
  });

  it('preserves normal session links and encodes project and session identifiers', () => {
    const row = { ...failed, sessionId: 'run/id' };
    expect(sessionDestinationHref(row)).toBe('/sessions/run%2Fid?project=my%20project');
    expect(renderToString(<FailedRow row={row} onDismiss={() => {}} />))
      .toContain('href="/sessions/run%2Fid?project=my%20project"');
  });

  it('keeps running and completed changesets in the same review flow', () => {
    for (const status of ['running', 'completed']) {
      expect(sessionDestinationHref({
        ...failed, status,
        purpose: { kind: 'changeset', mode: 'revise', href: '/projects/demo/changesets/revision-session' },
      } as SessionRow)).toBe('/projects/demo/changesets/revision-session');
    }
  });
});
