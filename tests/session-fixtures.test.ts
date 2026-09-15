import { describe, expect, it } from 'bun:test';
import { buildSessionFixtures, sessionFixture } from '../src/cli/serve/web/fixtures/session-fixtures';
import { FIXTURE_SESSION_PREFIX } from '../src/cli/serve/web/lib/dev';

describe('session page fixtures', () => {
  it('stay off outside a dev web build', () => {
    expect(typeof __AGENTUSE_WEB_DEV__).toBe('undefined');
  });

  it('name every state of the now card, each resolvable from its URL id', () => {
    const fixtures = buildSessionFixtures();
    const ids = fixtures.map((fixture) => fixture.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const state of ['working', 'decision', 'result', 'error', 'expired', 'ended-empty', 'child-suspended']) {
      expect(ids).toContain(state);
    }
    for (const fixture of fixtures) {
      expect(fixture.approval.sessionId).toBe(`${FIXTURE_SESSION_PREFIX}${fixture.id}`);
      expect(sessionFixture(fixture.approval.sessionId)?.id).toBe(fixture.id);
      expect(fixture.hint.length).toBeGreaterThan(20);
    }
    expect(sessionFixture(`${FIXTURE_SESSION_PREFIX}nope`)).toBeUndefined();
    expect(sessionFixture('01M2HQ2PK8BZSTGEGV637G4C87')).toBeUndefined();
  });

  it('give an actionable gate a resume token the pending entry shares', () => {
    for (const id of ['decision', 'decision-options']) {
      const fixture = sessionFixture(`${FIXTURE_SESSION_PREFIX}${id}`)!;
      const gate = fixture.logs.find((entry) => entry.status === 'pending');
      const token = fixture.approval.currentResumeToken;
      expect(token).toBeTruthy();
      expect(gate?.details?.resumeToken).toBe(token as string);
      expect(fixture.approval.expiresAt).toBeGreaterThan(Date.now());
    }
  });

  it('keep a working run on a running step and a view-only child without a token', () => {
    const working = sessionFixture(`${FIXTURE_SESSION_PREFIX}working`)!;
    expect(working.logs[working.logs.length - 1]?.status).toBe('running');
    const child = sessionFixture(`${FIXTURE_SESSION_PREFIX}child-suspended`)!;
    expect(child.approval.viewOnly).toBe(true);
    expect(child.approval.currentResumeToken).toBeUndefined();
    expect(child.approval.parentHref).toContain(FIXTURE_SESSION_PREFIX);
  });
});
