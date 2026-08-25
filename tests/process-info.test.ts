import { describe, expect, it } from 'bun:test';
import { isProcessRefAliveAsync } from '../src/utils/process-info';

describe('process identity after PID reuse', () => {
  it('re-probes a cached mismatch before declaring a live process dead', async () => {
    const calls: string[] = [];
    const alive = await isProcessRefAliveAsync(
      { pid: 123, procStartedAt: 'new-worker' },
      {
        isPidAlive: () => true,
        readStartTime: async () => {
          calls.push('cached');
          return 'old-worker';
        },
        readFreshStartTime: async () => {
          calls.push('fresh');
          return 'new-worker';
        },
      }
    );

    expect(alive).toBe(true);
    expect(calls).toEqual(['cached', 'fresh']);
  });

  it('still reports dead when the fresh process identity also differs', async () => {
    expect(await isProcessRefAliveAsync(
      { pid: 123, procStartedAt: 'expected-worker' },
      {
        isPidAlive: () => true,
        readStartTime: async () => 'old-worker',
        readFreshStartTime: async () => 'different-live-process',
      }
    )).toBe(false);
  });
});
