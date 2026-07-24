import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import {
  acquireSchedulerLock,
  releaseSchedulerLock,
  schedulerLockPath,
  type SchedulerLockHolder,
} from '../src/utils/scheduler-lock';
import { getProcessStartTime } from '../src/utils/process-info';

const inspectablePid = 1;
const inspectablePidStart = getProcessStartTime(inspectablePid);
const itWithProcessStartTime = inspectablePidStart ? it : it.skip;

describe('scheduler lock', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = mkdtempSync(join(tmpdir(), 'agentuse-schedlock-'));
  });

  afterEach(() => {
    rmSync(projectRoot, { recursive: true, force: true });
  });

  function writeHolder(holder: SchedulerLockHolder): void {
    mkdirSync(join(projectRoot, '.agentuse'), { recursive: true });
    writeFileSync(schedulerLockPath(projectRoot), JSON.stringify(holder));
  }

  it('acquires a fresh lock and records this process as holder', () => {
    const result = acquireSchedulerLock(projectRoot);
    expect(result.acquired).toBe(true);
    const holder = JSON.parse(readFileSync(schedulerLockPath(projectRoot), 'utf-8')) as SchedulerLockHolder;
    expect(holder.pid).toBe(process.pid);
  });

  it('re-acquiring its own lock succeeds', () => {
    expect(acquireSchedulerLock(projectRoot).acquired).toBe(true);
    expect(acquireSchedulerLock(projectRoot).acquired).toBe(true);
  });

  it('refuses when a live process holds the lock', () => {
    // PID 1 (launchd/init) is always alive; pair it with its real start-time
    // token so the liveness check treats the entry as current.
    const token = getProcessStartTime(1);
    writeHolder({ pid: 1, ...(token && { procStartedAt: token }), acquiredAt: Date.now() });
    const result = acquireSchedulerLock(projectRoot);
    expect(result.acquired).toBe(false);
    if (!result.acquired) expect(result.holder.pid).toBe(1);
  });

  it('takes over a lock whose holder is dead', () => {
    // PID far above any real pid: kill(pid, 0) throws ESRCH.
    writeHolder({ pid: 2 ** 30, acquiredAt: Date.now() });
    const result = acquireSchedulerLock(projectRoot);
    expect(result.acquired).toBe(true);
    const holder = JSON.parse(readFileSync(schedulerLockPath(projectRoot), 'utf-8')) as SchedulerLockHolder;
    expect(holder.pid).toBe(process.pid);
  });

  itWithProcessStartTime('takes over a recycled PID (start-time token mismatch)', () => {
    writeHolder({
      pid: inspectablePid,
      procStartedAt: `not:${inspectablePidStart}`,
      acquiredAt: Date.now(),
    });
    const result = acquireSchedulerLock(projectRoot);
    expect(result.acquired).toBe(true);
  });

  it('takes over a corrupt lock file', () => {
    mkdirSync(join(projectRoot, '.agentuse'), { recursive: true });
    writeFileSync(schedulerLockPath(projectRoot), 'not json');
    expect(acquireSchedulerLock(projectRoot).acquired).toBe(true);
  });

  it('release removes only its own lock', () => {
    acquireSchedulerLock(projectRoot);
    releaseSchedulerLock(projectRoot);
    expect(existsSync(schedulerLockPath(projectRoot))).toBe(false);

    const token = getProcessStartTime(1);
    writeHolder({ pid: 1, ...(token && { procStartedAt: token }), acquiredAt: Date.now() });
    releaseSchedulerLock(projectRoot);
    expect(existsSync(schedulerLockPath(projectRoot))).toBe(true);
  });
});
