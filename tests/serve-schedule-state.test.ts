import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { scheduleStatePath, setSchedulePaused } from '../src/scheduler/state';
import { createProjectScheduleState, loadProjectScheduleState, projectScheduleEnabled } from '../src/cli/serve/schedule-state';
import { scheduleRoutes } from '../src/cli/serve/routes/schedules';
import { Scheduler } from '../src/scheduler/scheduler';
import type { ServeContext, ServeRequest } from '../src/cli/serve/context';

describe('serve schedule state', () => {
  let root: string;
  let data: string;
  let priorData: string | undefined;

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentuse-serve-sched-project-'));
    data = await mkdtemp(join(tmpdir(), 'agentuse-serve-sched-data-'));
    priorData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = data;
  });

  afterEach(async () => {
    if (priorData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorData;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]);
  });

  it('arms every schedule when no state file exists', async () => {
    const state = createProjectScheduleState();
    await loadProjectScheduleState(state, 'demo', root);
    expect(state.errors.size).toBe(0);
    expect(projectScheduleEnabled(state, 'demo', 'daily.agentuse')).toBe(true);
  });

  it('keeps persisted pauses', async () => {
    await setSchedulePaused(root, 'daily.agentuse', true);
    const state = createProjectScheduleState();
    await loadProjectScheduleState(state, 'demo', root);
    expect(projectScheduleEnabled(state, 'demo', 'daily.agentuse')).toBe(false);
    expect(projectScheduleEnabled(state, 'demo', 'weekly.agentuse')).toBe(true);
  });

  it('disarms the project instead of resuming paused schedules when the state file is unreadable', async () => {
    const file = scheduleStatePath(root);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, '{ not json');
    const state = createProjectScheduleState();
    await loadProjectScheduleState(state, 'demo', root);

    expect(projectScheduleEnabled(state, 'demo', 'daily.agentuse')).toBe(false);
    expect(projectScheduleEnabled(state, 'demo', 'weekly.agentuse')).toBe(false);
    expect(state.errors.get('demo')).toBeString();
    // Other projects are unaffected.
    expect(projectScheduleEnabled(state, 'other', 'daily.agentuse')).toBe(true);
  });

  it('reports unreadable state on /schedules', async () => {
    const state = createProjectScheduleState();
    state.errors.set('demo', 'Unexpected token');
    let body = '';
    const res = { writeHead: () => res, end: (chunk: string) => { body = chunk; } };
    const ctx = {
      projectsById: new Map(),
      scheduler: new Scheduler({ onExecute: async () => ({ success: true, duration: 0 }) }),
      pausedSchedulesByProject: state.paused,
      scheduleStateErrors: state.errors,
      wakeListHubs: () => {},
    } as unknown as ServeContext;
    const rq = { req: { method: 'GET' }, res, isApi: true, routePath: '/schedules' } as unknown as ServeRequest;

    expect(await scheduleRoutes(ctx, rq)).toBe(true);
    expect(JSON.parse(body)).toEqual({ success: true, schedules: [], stateErrors: { demo: 'Unexpected token' } });
  });
});
