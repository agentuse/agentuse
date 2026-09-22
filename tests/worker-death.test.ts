import { describe, expect, it } from 'bun:test';
import { matchingWorkerDeath, workerDeathDetail } from '../src/worker/death';

describe('observed worker death evidence', () => {
  it('keeps exit signal, code, timestamp and process identity', () => {
    const death = { pid: 42, event: 'exit' as const, exitCode: null, signal: 'SIGKILL', observedAt: 100 };
    expect(JSON.parse(matchingWorkerDeath({ pid: 42 }, 90, death)!)).toEqual(death);
    expect(matchingWorkerDeath({ pid: 43 }, 90, death)).toBeUndefined();
    expect(matchingWorkerDeath(undefined, 90, death)).toBeUndefined();
    expect(matchingWorkerDeath({ pid: 42 }, 110, death)).toBeUndefined();
  });
  it('rejects recycled or unverified process incarnations', () => {
    const owner = { pid: 42, procStartedAt: 'incarnation-a' };
    const death = { pid: 42, event: 'exit' as const, observedAt: 100 };
    expect(matchingWorkerDeath(owner, 90, death)).toBeUndefined();
    expect(matchingWorkerDeath(owner, 90, { ...death, procStartedAt: 'incarnation-b' })).toBeUndefined();
    expect(matchingWorkerDeath(owner, 90, { ...death, procStartedAt: 'incarnation-a' })).toBeDefined();
  });
  it('bounds process errors without inventing exit evidence', () => {
    const result = JSON.parse(workerDeathDetail({ pid: 42, event: 'error', errorMessage: 'x'.repeat(5000), observedAt: 100 }));
    expect(result.errorMessage).toHaveLength(1000);
    expect(result).not.toHaveProperty('exitCode');
    expect(result).not.toHaveProperty('signal');
  });
});
