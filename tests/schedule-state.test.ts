import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPausedSchedules, normalizeScheduleAgentPath, scheduleStatePath, setSchedulePaused } from '../src/scheduler/state';

describe('deployment-local schedule state', () => {
  let root: string;
  let data: string;
  let priorData: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentuse-schedule-project-'));
    data = await mkdtemp(join(tmpdir(), 'agentuse-schedule-data-'));
    priorData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = data;
  });

  afterEach(async () => {
    if (priorData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorData;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]);
  });

  it('stores only paused project-relative agents outside the project', async () => {
    expect(await loadPausedSchedules(root)).toEqual(new Set());
    await setSchedulePaused(root, './agents/weekly.agentuse', true);
    expect(await loadPausedSchedules(root)).toEqual(new Set(['agents/weekly.agentuse']));
    expect(JSON.parse(await readFile(scheduleStatePath(root), 'utf8'))).toEqual({
      version: 1,
      pausedSchedules: ['agents/weekly.agentuse'],
    });
    expect(scheduleStatePath(root).startsWith(data)).toBe(true);

    await setSchedulePaused(root, 'agents/weekly.agentuse', false);
    expect(await loadPausedSchedules(root)).toEqual(new Set());
  });

  it('rejects paths that can escape the project identity', () => {
    expect(() => normalizeScheduleAgentPath('../outside.agentuse')).toThrow('Invalid project-relative agent path');
  });
});
