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

describe('renderAgentsPage', () => {
  it('renders loaded agents and surfaces the active nav item', async () => {
    const { agents, errors } = await __testing.collectAgents([makeProject()]);
    const html = __testing.renderAgentsPage({ agents, errors, multiProject: false });

    expect(html).toContain('<h1>Agents</h1>');
    expect(html).toContain('daily.agentuse');
    expect(html).toContain('anthropic:claude-sonnet-4-6');
    expect(html).toContain('0 9 * * *');
    expect(html).toContain('href="/agents"');
    expect(html).toContain('aria-current="page"');
    // Group carries the anchor id the dashboard project rows link to
    expect(html).toContain('id="project-demo"');
    // Parse error is surfaced behind a popover badge, not a full-width banner
    expect(html).toContain('<details class="issues">');
    expect(html).toContain('class="issues-badge"');
    expect(html).toContain('class="issues-popover"');
    expect(html).toContain('broken.agentuse');
    expect(html).not.toContain('class="errors"');
  });

  it('omits the issues badge when all agents parse', () => {
    const agents = [{ projectId: 'demo', path: 'a.agentuse', name: 'A', model: 'anthropic:claude-haiku-4-5' }];
    const html = __testing.renderAgentsPage({ agents, errors: [], multiProject: false });
    expect(html).not.toContain('class="issues-badge"');
    expect(html).not.toContain('class="issues-popover"');
  });

  it('shows an empty state when no agents are loaded', () => {
    const html = __testing.renderAgentsPage({ agents: [], errors: [], multiProject: false });
    expect(html).toContain('No agents loaded by this serve daemon.');
  });

  it('renders nested agent paths as a file tree', () => {
    const agents = [
      { projectId: 'demo', path: 'top.agentuse', name: 'Top', model: 'anthropic:claude-haiku-4-5' },
      { projectId: 'demo', path: 'sub/child.agentuse', name: 'Child', model: 'anthropic:claude-haiku-4-5' },
      { projectId: 'demo', path: 'sub/deep/leaf.agentuse', name: 'Leaf', model: 'anthropic:claude-haiku-4-5', schedule: '0 9 * * *' },
    ];
    const html = __testing.renderAgentsPage({ agents, errors: [], multiProject: false });

    expect(html).toContain('class="tree"');
    // Folder branch nodes for sub/ and sub/deep/
    expect(html).toContain('>sub/<');
    expect(html).toContain('>deep/<');
    // Leaf files keep their basename
    expect(html).toContain('>top.agentuse<');
    expect(html).toContain('>child.agentuse<');
    expect(html).toContain('>leaf.agentuse<');
    // CSS-drawn tree guides (elbow connectors) are present
    expect(html).toContain('class="guide elbow');
    expect(html).toContain('class="guide v"');
    // Leaf metadata still rendered
    expect(html).toContain('0 9 * * *');
  });

  it('groups agents into one section per project', async () => {
    const project = makeProject();
    const other = { ...project, id: 'second' };
    const { agents, errors } = await __testing.collectAgents([project, other]);
    const html = __testing.renderAgentsPage({ agents, errors, multiProject: true });

    // One group-title per project
    const groupTitles = html.match(/class="group-title"/g) ?? [];
    expect(groupTitles).toHaveLength(2);
    expect(html).toContain('>demo<');
    expect(html).toContain('>second<');
    expect(html).toContain('2 agents');
  });
});

describe('renderHomePage', () => {
  const projects = [
    { id: 'demo', path: '/work/demo', agentCount: 3, scheduleCount: 1 },
    { id: 'other', path: '/work/other', scope: '/work/other/scope', agentCount: 0, scheduleCount: 0 },
  ];

  it('renders the dashboard with nav cards and project rollup', () => {
    const html = __testing.renderHomePage({ version: '1.2.3', defaultProject: 'demo', projects, multiProject: true });

    expect(html).toContain('<h1>AgentUse</h1>');
    // Brand renders the wordmark SVG (currentColor, theme-aware) and the page
    // declares the SVG favicon.
    expect(html).toContain('<a class="brand" href="/" aria-label="AgentUse home"><svg');
    expect(html).toContain('fill="currentColor"');
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/favicon.svg">');
    // Nav cards link to each human-facing page
    expect(html).toContain('href="/agents"');
    expect(html).toContain('href="/sessions"');
    expect(html).toContain('href="/schedules"');
    expect(html).toContain('href="/stores"');
    expect(html).toContain('href="/approvals"');
    // Aggregate counts (3 + 0 agents, 1 + 0 schedules)
    expect(html).toContain('3 agents');
    expect(html).toContain('1 run');
    // Project rows deep-link into the agents view at that project's section
    expect(html).toContain('<a class="proj" href="/agents#project-demo">');
    expect(html).toContain('<a class="proj" href="/agents#project-other">');
    // Project list with default badge and scope
    expect(html).toContain('>demo<');
    expect(html).toContain('>other<');
    expect(html).toContain('<span class="proj-default">default</span>');
    expect(html).toContain('/work/other/scope');
    // API hint mentions the JSON surface, and version is surfaced
    expect(html).toContain('/api');
    expect(html).toContain('1.2.3');
    // No active nav item on the dashboard itself
    expect(html).not.toContain('aria-current="page"');
  });

  it('omits the default badge when no project is marked default', () => {
    const html = __testing.renderHomePage({ version: '1.0.0', defaultProject: null, projects, multiProject: true });
    expect(html).not.toContain('<span class="proj-default">default</span>');
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

describe('renderSchedulesPage', () => {
  it('renders scheduled agents with cron details', () => {
    const scheduler = new Scheduler({
      onExecute: async () => ({ success: true, duration: 1 }),
    });
    scheduler.add('demo', 'daily.agentuse', '0 9 * * *');
    const html = __testing.renderSchedulesPage({
      schedules: scheduler.listSerialized(),
      multiProject: false,
    });

    expect(html).toContain('<h1>Schedules</h1>');
    expect(html).toContain('daily.agentuse');
    expect(html).toContain('0 9 * * *');
    expect(html).toContain('href="/schedules"');

    scheduler.shutdown();
  });

  it('shows an empty state when nothing is scheduled', () => {
    const html = __testing.renderSchedulesPage({ schedules: [], multiProject: false });
    expect(html).toContain('No scheduled agents.');
  });

  it('renders a day-grouped timetable with time slots', () => {
    const scheduler = new Scheduler({
      onExecute: async () => ({ success: true, duration: 1 }),
    });
    scheduler.add('demo', 'morning.agentuse', '0 9 * * *');
    scheduler.add('demo', 'evening.agentuse', '0 18 * * *');
    const html = __testing.renderSchedulesPage({
      schedules: scheduler.listSerialized(),
      multiProject: false,
    });

    expect(html).toContain('class="day-title"');
    expect(html).toContain('class="timetable"');
    expect(html).toContain('class="slot-time"');
    expect(html).toContain('morning.agentuse');
    expect(html).toContain('evening.agentuse');

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
