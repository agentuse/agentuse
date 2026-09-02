import { describe, expect, it } from 'bun:test';
import { runInternalJobLifecycle, type InternalJobLifecycleState } from '../src/onboarding/internal-job-runner';

describe('internal job lifecycle', () => {
  it('owns phase promotion, persistence, completion, cleanup, and wakeups', async () => {
    const events: string[] = [];
    const job: InternalJobLifecycleState<{ code: string; message: string }> = { status: 'running', phase: 'preparing' };
    await runInternalJobLifecycle({
      job,
      prepare: async () => { events.push('prepare'); return 'agent'; },
      execute: async (prepared) => { events.push(`execute:${prepared}`); return 'done'; },
      consume: async (result) => { events.push(`consume:${result}`); job.status = 'completed'; },
      mapError: (error) => ({ code: 'FAILED', message: String(error) }),
      persist: async () => { events.push(`persist:${job.phase}:${job.status}`); },
      wake: () => { events.push('wake'); },
      cleanup: async () => { events.push('cleanup'); },
    });

    expect(events).toEqual([
      'prepare', 'persist:running:running', 'wake', 'execute:agent', 'consume:done',
      'persist:running:completed', 'cleanup', 'wake',
    ]);
  });

  it('projects preparation failures once and still finalizes observers', async () => {
    const events: string[] = [];
    const job: InternalJobLifecycleState<{ code: string; message: string }> = { status: 'running', phase: 'preparing' };
    await runInternalJobLifecycle({
      job,
      prepare: async () => { throw new Error('view failed'); },
      execute: async () => 'unused',
      consume: async () => undefined,
      mapError: (error, phase) => ({ code: phase === 'preparing' ? 'START_FAILED' : 'FAILED', message: (error as Error).message }),
      persist: async () => { events.push('persist'); },
      wake: () => { events.push('wake'); },
      failPreparing: async (error) => { events.push(`fail:${error.code}`); },
      cleanup: async () => { events.push('cleanup'); },
    });

    expect(job.error).toEqual({ code: 'START_FAILED', message: 'view failed' });
    expect(events).toEqual(['fail:START_FAILED', 'persist', 'cleanup', 'wake']);
  });

  it('treats phase-persistence failure as a preparation failure and always wakes observers', async () => {
    const events: string[] = [];
    let persistCalls = 0;
    const job: InternalJobLifecycleState<{ code: string; message: string }> = { status: 'running', phase: 'preparing' };
    await runInternalJobLifecycle({
      job,
      prepare: async () => 'agent',
      execute: async () => { throw new Error('must not execute'); },
      consume: async () => undefined,
      mapError: (error, phase) => ({ code: phase === 'preparing' ? 'START_FAILED' : 'FAILED', message: (error as Error).message }),
      persist: async () => {
        persistCalls += 1;
        if (persistCalls === 1) throw new Error('disk unavailable');
      },
      wake: () => { events.push('wake'); },
      failPreparing: async (error) => { events.push(`fail:${error.code}`); },
      cleanup: async () => { events.push('cleanup'); throw new Error('cleanup failed'); },
    });

    expect(job.error).toEqual({ code: 'START_FAILED', message: 'disk unavailable' });
    expect(events).toEqual(['fail:START_FAILED', 'cleanup', 'wake']);
  });
});
