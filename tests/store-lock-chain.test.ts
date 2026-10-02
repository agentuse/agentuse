import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { withLearningFileLock } from '../src/learning/store';
import { loadPausedSchedules, scheduleStatePath, setSchedulePaused } from '../src/scheduler/state';
import { withSerializedOwnershipLock } from '../src/utils/ownership-lock';

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

// Store locks share the one in-process chain per lock path, so a caller in this
// process queues behind a holder instead of polling the lock until it times out.
describe('store locks queue on the shared in-process chain', () => {
  let root: string;
  let data: string;
  let priorData: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentuse-lock-chain-project-'));
    data = await mkdtemp(join(tmpdir(), 'agentuse-lock-chain-data-'));
    priorData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = data;
  });

  afterEach(async () => {
    if (priorData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorData;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]);
  });

  it('learnings file lock', async () => {
    const key = join(root, 'learnings.md');
    const order: string[] = [];
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const holder = withLearningFileLock(key, async () => {
      held();
      await sleep(300);
      order.push('holder');
    });
    await holding;
    const waiter = withSerializedOwnershipLock(`${key}.lock`, async () => {
      order.push('waiter');
    }, { maxWaitMs: 50 });
    await Promise.all([holder, waiter]);
    expect(order).toEqual(['holder', 'waiter']);
  });

  it('schedule state lock', async () => {
    const file = scheduleStatePath(root);
    let held!: () => void;
    const holding = new Promise<void>((resolve) => { held = resolve; });
    const holder = withSerializedOwnershipLock(`${file}.lock`, async () => {
      held();
      await sleep(5_300);
    }, { label: 'test' });
    await holding;
    // setSchedulePaused waits at most 5s for the ownership lock; on the shared
    // chain it starts only once the holder is done.
    const write = setSchedulePaused(root, 'agents/a.agentuse', true);
    await Promise.all([holder, write]);
    expect(await loadPausedSchedules(root)).toEqual(new Set(['agents/a.agentuse']));
  }, 15_000);
});
