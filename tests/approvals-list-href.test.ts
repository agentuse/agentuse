import { describe, expect, test } from 'bun:test';
import { sessionHref } from '../src/cli/serve/web/routes/approvals-list';
import type { ApprovalRow } from '../src/cli/serve/web/lib/api';

const base: ApprovalRow = {
  project: 'demo',
  sessionId: '01SESSION',
  agentId: 'agent',
  agentName: 'Agent',
  status: 'pending',
  sessionStatus: 'suspended',
  resumeToken: 'tok',
};

describe('approvals list row links', () => {
  test('an ordinary gate opens the session log', () => {
    expect(sessionHref(base, true)).toBe('/sessions/01SESSION?token=tok&project=demo');
  });

  test('a change set gate opens the review page with the resume token', () => {
    const row: ApprovalRow = { ...base, reviewHref: '/projects/demo/changesets/01SESSION' };
    expect(sessionHref(row, true)).toBe('/projects/demo/changesets/01SESSION?token=tok');
  });

  test('a row with no resume token stays static', () => {
    const row: ApprovalRow = { ...base, resumeToken: undefined, reviewHref: '/projects/demo/changesets/01SESSION' };
    expect(sessionHref(row, true)).toBeNull();
  });
});
