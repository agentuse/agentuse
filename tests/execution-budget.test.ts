import { afterAll, afterEach, describe, expect, it, spyOn } from 'bun:test';
import { ExecutionBudget, BUDGET_WRAP_UP_NOTICE } from '../src/runner/execution-budget';
import { budgetLabel } from '../src/session/budget-label';
import type { SessionManager } from '../src/session';

let now = 1_000;
const clock = spyOn(Date, 'now').mockImplementation(() => now);
const active: ExecutionBudget[] = [];
afterAll(() => clock.mockRestore());
function budget(ms: number, parentSignal?: AbortSignal) {
  const b = new ExecutionBudget(ms, parentSignal ? { parentSignal } : {});
  active.push(b);
  return b;
}
afterEach(async () => {
  for (const b of active.splice(0)) await b.finish();
  now = 1_000;
});
// The storage double exercises the same session snapshots used on durable resume.
function storage() {
  const sessions = new Map<string, any>();
  const manager = {
    findSession: async (id: string) => sessions.has(id) ? { session: sessions.get(id), agentId: id } : undefined,
    updateSession: async (id: string, _agent: string, patch: object) => Object.assign(sessions.get(id), structuredClone(patch)),
  } as unknown as SessionManager;
  return { sessions, manager };
}

describe('execution budgets', () => {
  it('reserves a final model turn using observed latency without extending the deadline', async () => {
    const b = budget(300000);
    b.observeModelDuration(64000);
    now += 180000;
    expect(await b.takeNotice()).toBe(BUDGET_WRAP_UP_NOTICE);
    expect(b.remainingMs).toBe(120000);
    expect(b.snapshot().effectiveMs).toBe(300000);
    expect(b.snapshot().wrappedUpAt).toBeUndefined();
  });
  it('retains latency through suspension and respects the earlier parent deadline', async () => {
    const { sessions, manager } = storage();
    sessions.set('leaf', { id: 'leaf' });
    const first = budget(300000);
    await first.bind(manager, 'leaf', 'leaf');
    first.observeModelDuration(60000);
    now += 150000;
    await first.finish();
    now += 60000;
    const resumed = budget(300000);
    await resumed.bind(manager, 'leaf', 'leaf', true);
    expect(await resumed.takeNotice()).toBeUndefined();
    now += 30000;
    expect(await resumed.takeNotice()).toBeDefined();
    const child = budget(300000, resumed.signal);
    child.observeModelDuration(60000);
    expect(await child.takeNotice()).toBeDefined();
  });

  it('delivers once at 80%, never claims completion from the notice', async () => {
    const b = budget(1000);
    now += 799;
    expect(await b.takeNotice()).toBeUndefined();
    now++;
    expect(await b.takeNotice()).toBe(BUDGET_WRAP_UP_NOTICE);
    expect(await b.takeNotice()).toBeUndefined();
    expect(b.snapshot().wrappedUpAt).toBeUndefined();
    await b.finish(true);
    expect(b.snapshot().wrappedUpAt).toBe(now);
  });
  it('uses the earlier parent deadline and gives a child its own notice', async () => {
    const { sessions, manager } = storage();
    sessions.set('parent', { id: 'parent' });
    const parent = budget(1000);
    await parent.bind(manager, 'parent', 'parent');
    now += 600;
    const child = budget(1000, parent.signal);
    expect(child.snapshot().effectiveMs).toBe(400);
    expect(child.snapshot().limitingSessionId).toBe('parent');
    now += 320;
    expect(await child.takeNotice()).toBeDefined();
    expect(await parent.takeNotice()).toBeDefined();
  });
  it('keeps a child expiry local while parent cancellation stops siblings', async () => {
    const parent = budget(1000);
    const child = budget(10, parent.signal);
    const sibling = budget(1000, parent.signal);
    await new Promise(resolve => setTimeout(resolve, 25));
    expect(child.signal.aborted).toBe(true);
    expect(child.signal.reason.causeCode).toBe('run_deadline');
    expect(parent.signal.aborted).toBe(false);
    expect(sibling.signal.aborted).toBe(false);
    parent.controller.abort(new Error('parent stopped'));
    expect(sibling.signal.aborted).toBe(true);
  });
  it('retains consumed time and one notice across approval suspension', async () => {
    const { sessions, manager } = storage();
    sessions.set('leaf', { id: 'leaf' });
    const first = budget(1000);
    await first.bind(manager, 'leaf', 'leaf');
    now += 800;
    await first.takeNotice();
    await first.finish();
    now += 60_000; // Human approval wait is excluded.
    const resumed = budget(1000);
    await resumed.bind(manager, 'leaf', 'leaf', true);
    expect(resumed.remainingMs).toBe(200);
    expect(resumed.snapshot().configuredMs).toBe(1000);
    expect(await resumed.takeNotice()).toBeUndefined();
    expect(resumed.notice).toBeDefined();
    await resumed.finish(true);
    expect(sessions.get('leaf').executionBudget.wrappedUpAt).toBe(now);
  });
  it('honors a new configured timeout on resume while still charging consumed time', async () => {
    const { sessions, manager } = storage();
    sessions.set('leaf', { id: 'leaf' });
    const first = budget(1000);
    await first.bind(manager, 'leaf', 'leaf');
    now += 800;
    await first.finish();
    // `agentuse run --session <id> --timeout 9`: the caller's value is the live
    // one, and the docs promise the flag overrides the agent's configured value.
    const resumed = budget(9000);
    await resumed.bind(manager, 'leaf', 'leaf', true);
    expect(resumed.snapshot().configuredMs).toBe(9000);
    expect(resumed.remainingMs).toBe(8200);
  });
  it('keeps an ancestor wrapped-up marker when a descendant resumes', async () => {
    const { sessions, manager } = storage();
    sessions.set('parent', { id: 'parent', executionBudget: { configuredMs: 10_000, elapsedMs: 100, effectiveMs: 10_000, noticeDeliveredAt: 900, wrappedUpAt: 950 } });
    sessions.set('child', { id: 'child', parentSessionID: 'parent', executionBudget: { configuredMs: 2000, elapsedMs: 0, effectiveMs: 2000 } });
    const child = budget(2000);
    await child.bind(manager, 'child', 'child', true);
    await child.finish();
    expect(sessions.get('parent').executionBudget.wrappedUpAt).toBe(950);
  });
  it('charges resumed delegated work to ancestors without charging human wait', async () => {
    const { sessions, manager } = storage();
    sessions.set('parent', { id: 'parent', executionBudget: { configuredMs: 1000, elapsedMs: 600, effectiveMs: 1000 } });
    sessions.set('child', { id: 'child', parentSessionID: 'parent', executionBudget: { configuredMs: 2000, elapsedMs: 100, effectiveMs: 500 } });
    const child = budget(2000);
    await child.bind(manager, 'child', 'child', true);
    expect(child.remainingMs).toBe(400);
    now += 100;
    await child.finish();
    expect(sessions.get('parent').executionBudget.elapsedMs).toBe(700);
    expect(sessions.get('child').executionBudget.elapsedMs).toBe(200);
    expect(sessions.get('parent').executionBudget.wrappedUpAt).toBeUndefined();
  });
  it('does not mark a notice as wrapped up on timeout or interruption', async () => {
    const b = budget(1000);
    now += 800;
    await b.takeNotice();
    b.controller.abort(new Error('stopped'));
    await b.finish(true);
    expect(b.snapshot().wrappedUpAt).toBeUndefined();
  });
  it('preserves outcomes and distinguishes notice from a returned response', () => {
    const state = { configuredMs: 1000, elapsedMs: 800, effectiveMs: 1000, noticeDeliveredAt: 1800 };
    expect(budgetLabel('running', undefined, state)).toBe('Wrapping up · execution budget nearly used');
    expect(budgetLabel('suspended', undefined, state)).toBe('Budget wrap-up notice received');
    expect(budgetLabel('error', 'TIMEOUT', state)).toBe('Budget wrap-up notice received');
    expect(budgetLabel('error', 'INCOMPLETE', state)).toBe('Budget wrap-up notice received');
    expect(budgetLabel('error', 'INCOMPLETE', { ...state, wrappedUpAt: 1900 })).toBe('Wrapped up before timeout');
    expect(budgetLabel('completed', undefined, { ...state, wrappedUpAt: 1900 })).toBe('Budget wrap-up notice received');
    expect(budgetLabel('running', undefined)).toBeUndefined();
  });
});
