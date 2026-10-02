import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { Readable } from 'node:stream';
import { normalizeScheduleAgentPath, scheduleStatePath } from '../src/scheduler/state';
import {
  createProjectScheduleState,
  loadProjectScheduleState,
  projectScheduleEnabled,
  retryProjectScheduleState,
  type ProjectScheduleState,
} from '../src/cli/serve/schedule-state';
import { scheduleRoutes } from '../src/cli/serve/routes/schedules';
import { Scheduler } from '../src/scheduler/scheduler';
import type { ServeContext, ServeRequest } from '../src/cli/serve/context';

const AGENT = (name: string) => `---
name: ${name}
model: anthropic:claude-sonnet-4-6
schedule: "0 9 * * *"
---
Run.
`;

describe('serve schedule state recovery without a restart', () => {
  let root: string;
  let data: string;
  let priorData: string | undefined;
  let scheduler: Scheduler;
  let state: ProjectScheduleState;

  const writeState = async (content: string) => {
    const file = scheduleStatePath(root);
    await mkdir(dirname(file), { recursive: true });
    await writeFile(file, content);
  };
  const pausedState = (...paths: string[]) => JSON.stringify({ version: 1, pausedSchedules: paths });

  /** A serve-shaped context over one project with two scheduled agents, loaded with `state`. */
  const setup = async () => {
    const project = { id: 'demo', root, scopeRoot: root, envFile: '', agentFiles: ['daily.agentuse', 'weekly.agentuse'] };
    await writeFile(join(root, 'daily.agentuse'), AGENT('Daily'));
    await writeFile(join(root, 'weekly.agentuse'), AGENT('Weekly'));
    await loadProjectScheduleState(state, project.id, root);
    const scheduleIsEnabled = (p: { id: string }, agentPath: string) =>
      projectScheduleEnabled(state, p.id, normalizeScheduleAgentPath(agentPath));
    for (const file of project.agentFiles) {
      scheduler.add(project.id, file, '0 9 * * *', file, scheduleIsEnabled(project, file));
    }
    return {
      projectsById: new Map([[project.id, project]]),
      scheduler,
      pausedSchedulesByProject: state.paused,
      scheduleStateErrors: state.errors,
      scheduleIsEnabled,
      wakeListHubs: () => {},
    } as unknown as ServeContext;
  };

  const call = async (ctx: ServeContext, method: string, routePath: string, body?: unknown) => {
    let sent = '';
    let status = 0;
    const req = Object.assign(Readable.from(body === undefined ? [] : [JSON.stringify(body)]), { method });
    const res = { writeHead: (code: number) => { status = code; return res; }, end: (chunk: string) => { sent = chunk; } };
    const rq = { req, res, isApi: true, routePath } as unknown as ServeRequest;
    expect(await scheduleRoutes(ctx, rq)).toBe(true);
    return { status, body: JSON.parse(sent) };
  };
  const enabled = () => Object.fromEntries(scheduler.list().map((s) => [s.agentPath, s.enabled]));

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'agentuse-serve-sched-recover-project-'));
    data = await mkdtemp(join(tmpdir(), 'agentuse-serve-sched-recover-data-'));
    priorData = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = data;
    scheduler = new Scheduler({ onExecute: async () => ({ success: true, duration: 0 }) });
    state = createProjectScheduleState();
  });

  afterEach(async () => {
    scheduler.shutdown();
    if (priorData === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = priorData;
    await Promise.all([rm(root, { recursive: true, force: true }), rm(data, { recursive: true, force: true })]);
  });

  it('retries a failed load and keeps the project disarmed while the file stays broken', async () => {
    await writeState('{ not json');
    await loadProjectScheduleState(state, 'demo', root);

    expect(await retryProjectScheduleState(state, 'demo', root)).toBe(false);
    expect(projectScheduleEnabled(state, 'demo', 'daily.agentuse')).toBe(false);

    await writeState(pausedState('daily.agentuse'));
    expect(await retryProjectScheduleState(state, 'demo', root)).toBe(true);
    expect(state.errors.has('demo')).toBe(false);
    expect(projectScheduleEnabled(state, 'demo', 'daily.agentuse')).toBe(false);
    expect(projectScheduleEnabled(state, 'demo', 'weekly.agentuse')).toBe(true);
  });

  it('re-arms on the next /schedules read once the file is fixed, keeping its pauses', async () => {
    await writeState('{ not json');
    const ctx = await setup();
    expect(enabled()).toEqual({ 'daily.agentuse': false, 'weekly.agentuse': false });
    expect((await call(ctx, 'GET', '/schedules')).body.stateErrors).toEqual({ demo: expect.any(String) });

    await writeState(pausedState('daily.agentuse'));
    const { body } = await call(ctx, 'GET', '/schedules');

    expect(body.stateErrors).toBeUndefined();
    expect(enabled()).toEqual({ 'daily.agentuse': false, 'weekly.agentuse': true });
  });

  it('re-arms on the next /schedules read once the file is removed', async () => {
    await writeState('{ not json');
    const ctx = await setup();

    await rm(scheduleStatePath(root));
    expect((await call(ctx, 'GET', '/schedules')).body.stateErrors).toBeUndefined();
    expect(enabled()).toEqual({ 'daily.agentuse': true, 'weekly.agentuse': true });
  });

  it('re-arms the whole project after a pause toggle succeeds on a fixed file', async () => {
    await writeState('{ not json');
    const ctx = await setup();

    // Still broken: the toggle fails and nothing is armed.
    expect((await call(ctx, 'POST', '/schedules/state', { project: 'demo', path: 'weekly.agentuse', paused: false })).status).toBe(500);
    expect(enabled()).toEqual({ 'daily.agentuse': false, 'weekly.agentuse': false });

    await writeState(pausedState('daily.agentuse'));
    const toggled = await call(ctx, 'POST', '/schedules/state', { project: 'demo', path: 'weekly.agentuse', paused: false });

    expect(toggled.status).toBe(200);
    expect(state.errors.has('demo')).toBe(false);
    expect(enabled()).toEqual({ 'daily.agentuse': false, 'weekly.agentuse': true });
  });
});
