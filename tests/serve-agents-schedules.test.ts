import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { __testing } from '../src/cli/serve';
import { normalizeApiPath } from '../src/cli/serve/ui';
import { Scheduler } from '../src/scheduler/scheduler';

/**
 * Tests for the serve `/agents` and `/schedules` read surfaces:
 * collectAgents (data), the HTML render functions, the CLI table
 * formatters, and Scheduler.listSerialized.
 */

let tmpDir: string;

const VALID_AGENT = `---
name: Daily Report
model: anthropic:claude-sonnet-4-6
description: Sends a daily report
schedule: "0 9 * * *"
---
Generate the daily report.
`;

const PLAIN_AGENT = `---
name: Helper
model: anthropic:claude-haiku-4-5
---
Help out.
`;

const INVALID_AGENT = `---
description: missing required model field
---
This agent has no model.
`;

beforeAll(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentuse-agents-'));
  fs.writeFileSync(path.join(tmpDir, 'daily.agentuse'), VALID_AGENT);
  fs.writeFileSync(path.join(tmpDir, 'helper.agentuse'), PLAIN_AGENT);
  fs.writeFileSync(path.join(tmpDir, 'broken.agentuse'), INVALID_AGENT);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeProject() {
  return {
    id: 'demo',
    root: tmpDir,
    scopeRoot: tmpDir,
    envFile: path.join(tmpDir, '.env'),
    agentFiles: ['daily.agentuse', 'helper.agentuse', 'broken.agentuse'],
  };
}

describe('normalizeApiPath', () => {
  it('strips the /api prefix and flags API requests', () => {
    expect(normalizeApiPath('/api/agents')).toEqual({ isApi: true, routePath: '/agents' });
    expect(normalizeApiPath('/api/approvals/abc/decision')).toEqual({ isApi: true, routePath: '/approvals/abc/decision' });
  });

  it('collapses bare /api and /api/ to the root route', () => {
    expect(normalizeApiPath('/api')).toEqual({ isApi: true, routePath: '/' });
    expect(normalizeApiPath('/api/')).toEqual({ isApi: true, routePath: '/' });
  });

  it('passes root-level page paths through unchanged', () => {
    expect(normalizeApiPath('/agents')).toEqual({ isApi: false, routePath: '/agents' });
    expect(normalizeApiPath('/')).toEqual({ isApi: false, routePath: '/' });
    expect(normalizeApiPath('/approvals/abc')).toEqual({ isApi: false, routePath: '/approvals/abc' });
  });

  it('does not treat a path that merely starts with "api" as API', () => {
    expect(normalizeApiPath('/apiary')).toEqual({ isApi: false, routePath: '/apiary' });
  });
});

describe('collectAgents', () => {
  it('summarizes parseable agents and collects parse errors', async () => {
    const { agents, errors } = await __testing.collectAgents([makeProject()]);

    expect(agents).toHaveLength(2);
    const daily = agents.find((a) => a.path === 'daily.agentuse');
    expect(daily).toMatchObject({
      projectId: 'demo',
      name: 'Daily Report',
      model: 'anthropic:claude-sonnet-4-6',
      description: 'Sends a daily report',
      schedule: '0 9 * * *',
    });
    const helper = agents.find((a) => a.path === 'helper.agentuse');
    expect(helper?.schedule).toBeUndefined();

    expect(errors).toHaveLength(1);
    expect(errors[0].path).toBe('broken.agentuse');
  });

  it('sorts agents by project then path', async () => {
    const { agents } = await __testing.collectAgents([makeProject()]);
    expect(agents.map((a) => a.path)).toEqual(['daily.agentuse', 'helper.agentuse']);
  });
});

describe('Scheduler.listSerialized', () => {
  it('serializes schedules with a human description and ISO timestamps', () => {
    const scheduler = new Scheduler({
      onExecute: async () => ({ success: true, duration: 1 }),
    });
    scheduler.add('demo', 'daily.agentuse', '0 9 * * *');

    const serialized = scheduler.listSerialized();
    expect(serialized).toHaveLength(1);
    const entry = serialized[0];
    expect(entry.projectId).toBe('demo');
    expect(entry.agentPath).toBe('daily.agentuse');
    expect(entry.expression).toBe('0 9 * * *');
    expect(typeof entry.human).toBe('string');
    expect(entry.human.length).toBeGreaterThan(0);
    expect(entry.lastRun).toBeNull();
    // nextRun should be a parseable ISO string
    expect(entry.nextRun === null || Number.isFinite(Date.parse(entry.nextRun))).toBe(true);

    scheduler.shutdown();
  });

  it('sorts schedules with soonest next run first and disabled last', () => {
    const scheduler = new Scheduler({
      onExecute: async () => ({ success: true, duration: 1 }),
    });
    scheduler.add('demo', 'a.agentuse', '0 9 * * *');
    scheduler.add('demo', 'b.agentuse', '0 10 * * *');

    const serialized = scheduler.listSerialized();
    const withNext = serialized.filter((s) => s.nextRun !== null);
    for (let i = 1; i < withNext.length; i++) {
      expect(Date.parse(withNext[i].nextRun as string)).toBeGreaterThanOrEqual(
        Date.parse(withNext[i - 1].nextRun as string)
      );
    }

    scheduler.shutdown();
  });
});

describe('CLI table formatters', () => {
  it('formats the agents table with a schedule column', async () => {
    const { agents } = await __testing.collectAgents([makeProject()]);
    const table = __testing.formatAgentsTable(agents);
    expect(table).toContain('AGENT');
    expect(table).toContain('MODEL');
    expect(table).toContain('SCHEDULE');
    expect(table).toContain('daily.agentuse');
  });

  it('prefixes the agent path with project id in multi-project output', async () => {
    const project = makeProject();
    const other = { ...project, id: 'second' };
    const { agents } = await __testing.collectAgents([project, other]);
    const table = __testing.formatAgentsTable(agents);
    expect(table).toContain('demo/daily.agentuse');
    expect(table).toContain('second/daily.agentuse');
  });

  it('formats the schedules table', () => {
    const scheduler = new Scheduler({
      onExecute: async () => ({ success: true, duration: 1 }),
    });
    scheduler.add('demo', 'daily.agentuse', '0 9 * * *');
    const table = __testing.formatSchedulesTable(scheduler.listSerialized());
    expect(table).toContain('NEXT RUN');
    expect(table).toContain('daily.agentuse');
    scheduler.shutdown();
  });

  it('reports empty states for both tables', () => {
    expect(__testing.formatAgentsTable([])).toContain('No agents loaded');
    expect(__testing.formatSchedulesTable([])).toContain('No scheduled agents');
  });
});
