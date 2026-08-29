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
let migrationDir: string;

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

  migrationDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentuse-migration-'));
  fs.writeFileSync(path.join(migrationDir, 'daily.agentuse'), VALID_AGENT);
});

afterAll(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(migrationDir, { recursive: true, force: true });
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

describe('bare serve migration warning', () => {
  it('explains how to re-adopt a current directory that contains agents', async () => {
    const warning = await __testing.bareServeMigrationWarning(migrationDir);

    expect(warning).toContain('v0.19 no longer adopts the current directory');
    expect(warning).toContain('agentuse serve -C .');
    expect(warning).toContain('daily.agentuse');
  });

  it('stays quiet when the current directory has no agents', async () => {
    const emptyDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentuse-empty-project-'));
    try {
      expect(await __testing.bareServeMigrationWarning(emptyDir)).toBeUndefined();
    } finally {
      fs.rmSync(emptyDir, { recursive: true, force: true });
    }
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
  it('shows every project in serve ps output', () => {
    const table = __testing.formatPsTable([{
      pid: 12345,
      port: 12233,
      host: '127.0.0.1',
      projectRoot: '/workspace/alpha',
      startTime: Date.now(),
      agentCount: 8,
      scheduleCount: 2,
      version: '1.0.0',
      projects: ['alpha', 'bravo', 'charlie', 'delta'].map((id) => ({
        id,
        root: `/workspace/${id}`,
        agentCount: 2,
        scheduleCount: 0,
      })),
    }]);

    expect(table).toContain('alpha');
    expect(table).toContain('bravo');
    expect(table).toContain('charlie');
    expect(table).toContain('delta');
    expect(table).not.toContain('alpha +3');
  });

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

describe('redactAgentDetailSource', () => {
  const detail = {
    projectId: 'demo',
    path: 'daily.agentuse',
    runPath: 'daily.agentuse',
    name: 'Daily Report',
    model: 'anthropic:claude-sonnet-4-6',
    schedule: '0 9 * * *',
    source: '---\nname: Daily Report\n---\nGenerate the daily report.\n',
    meta: {
      skills: { auto: true, trusted: false, explicit: [] },
      mcpServers: [],
      subagents: [],
      channels: [],
    },
  };

  it('strips the raw source and flags the hiding', () => {
    const redacted = __testing.redactAgentDetailSource(detail);
    expect('source' in redacted).toBe(false);
    expect(redacted.sourceHidden).toBe(true);
  });

  it('keeps the capability summary intact', () => {
    const redacted = __testing.redactAgentDetailSource(detail);
    expect(redacted.name).toBe('Daily Report');
    expect(redacted.model).toBe('anthropic:claude-sonnet-4-6');
    expect(redacted.schedule).toBe('0 9 * * *');
    expect(redacted.meta).toEqual(detail.meta);
  });
});
