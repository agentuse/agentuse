import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { runDoctor } from '../src/cli/doctor';
import { getSessionStorageDir } from '../src/storage/paths';
import type { Message, SessionInfo, ToolPart } from '../src/session/types';

describe('agentuse doctor', () => {
  let testDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;
  let originalXdgDataHome: string | undefined;
  let originalConsoleLog: typeof console.log;
  let logs: string[];

  async function writeSkill(
    name: string,
    description: string,
    body = 'Follow the skill instructions.'
  ): Promise<void> {
    const skillDir = join(testDir, '.agentuse', 'skills', name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: ${name}
description: ${description}
---

# ${name}

${body}`);
  }

  // A description long enough that a handful of skills push the catalog past the
  // "large" threshold, so the warning fires regardless of how many real skills
  // the host machine happens to have installed.
  const FAT_DESCRIPTION = 'Handles a narrow slice of the workflow and explains exactly when to use it. '.repeat(12);

  async function writeFatCatalog(count: number): Promise<string[]> {
    const names = Array.from({ length: count }, (_, i) => `doctor-fixture-${i + 1}`);
    for (const name of names) {
      await writeSkill(name, FAT_DESCRIPTION);
    }
    return names;
  }

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'doctor-test-'));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    originalConsoleLog = console.log;
    logs = [];

    process.env.HOME = testDir;
    process.env.XDG_DATA_HOME = join(testDir, 'xdg');
    console.log = (...args: unknown[]) => {
      logs.push(args.join(' '));
    };

    await writeFile(join(testDir, 'package.json'), '{}');
    process.chdir(testDir);
    testDir = process.cwd();
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    console.log = originalConsoleLog;
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    if (originalXdgDataHome !== undefined) {
      process.env.XDG_DATA_HOME = originalXdgDataHome;
    } else {
      delete process.env.XDG_DATA_HOME;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  it('analyzes the latest run and suggests the blocked command family', async () => {
    const agentDir = join(testDir, 'agents');
    await mkdir(agentDir, { recursive: true });
    const agentPath = join(agentDir, 'test.agentuse');
    await writeFile(agentPath, `---
name: Test Agent
model: demo:test
---

Do the task.`);

    const sessionId = '01H00000000000000000000000';
    const messageId = '01H00000000000000000000001';
    const partId = '01H00000000000000000000002';
    const sessionDir = join(await getSessionStorageDir(testDir), `${sessionId}-agents-test`);
    const messageDir = join(sessionDir, messageId, 'part');
    await mkdir(messageDir, { recursive: true });

    const session: SessionInfo = {
      id: sessionId,
      status: 'completed',
      agent: {
        id: 'agents/test',
        name: 'Test Agent',
        filePath: agentPath,
        isSubAgent: false,
      },
      model: 'demo:test',
      version: 'test',
      config: {},
      project: {
        root: testDir,
        cwd: testDir,
      },
      time: {
        created: Date.now(),
        updated: Date.now(),
      },
    };
    const message: Message = {
      id: messageId,
      sessionID: sessionId,
      time: { created: Date.now() },
      user: { prompt: { task: 'Do the task.' } },
      assistant: {
        system: [],
        modelID: 'test',
        providerID: 'demo',
        mode: 'build',
        path: { cwd: testDir, root: testDir },
        cost: 0,
        tokens: {
          input: 0,
          output: 0,
          reasoning: 0,
          cache: { read: 0, write: 0 },
        },
      },
    };
    const part: ToolPart = {
      id: partId,
      sessionID: sessionId,
      messageID: messageId,
      type: 'tool',
      callID: 'call-1',
      tool: 'tools__bash',
      state: {
        status: 'error',
        input: { command: 'custom-browser eval "document.title"' },
        error: 'Command blocked by agent configuration.\nReason: Command did not match allowed bash commands.',
        time: {
          start: Date.now(),
          end: Date.now(),
        },
      },
    };

    await writeFile(join(sessionDir, 'session.json'), JSON.stringify(session, null, 2));
    await writeFile(join(sessionDir, messageId, 'message.json'), JSON.stringify(message, null, 2));
    await writeFile(join(messageDir, `${partId}.json`), JSON.stringify(part, null, 2));

    await runDoctor(agentPath, { lastRun: true });

    const output = logs.join('\n');
    expect(output).toContain('Runtime Analysis From Last Run');
    expect(output).toContain('Blocked bash command');
    expect(output).toContain('custom-browser eval "document.title"');
    expect(output).toContain('- custom-browser *');
  });

  it('reports no prior sessions when --last-run has no matching session', async () => {
    const agentPath = join(testDir, 'lonely.agentuse');
    await writeFile(agentPath, `---
name: Lonely Agent
model: demo:test
---

Idle.`);

    await runDoctor(agentPath, { lastRun: true });

    const output = logs.join('\n');
    expect(output).toContain('Runtime Analysis From Last Run');
    expect(output).toContain('No prior sessions found');
  });

  it('reports skill trust banner when skills: trusted', async () => {
    const agentPath = join(testDir, 'trusted.agentuse');
    await writeFile(agentPath, `---
name: Trusted Agent
model: demo:test
skills: trusted
---

Trusted mode agent.`);

    await runDoctor(agentPath);

    const output = logs.join('\n');
    expect(output).toContain('Skill trust: all skills trusted');
    expect(output).not.toContain('not granted');
  });

  it('reports open discovery overhead and explains that listed skills do not restrict it', async () => {
    await writeSkill('preloaded', 'A skill the agent always needs.');
    await writeSkill('optional', 'A skill available through discovery.');
    const agentPath = join(testDir, 'open.agentuse');
    await writeFile(agentPath, `---
name: Open Skills Agent
model: demo:test
skills: [preloaded]
---

Use the preloaded skill.`);

    await runDoctor(agentPath);

    const output = logs.join('\n');
    expect(output).toContain('Skill discovery');
    expect(output).toContain('mode: open');
    const discovered = output.match(/discovered: (\d+)/)?.[1];
    const visible = output.match(/visible: (\d+)/)?.[1];
    expect(Number(discovered)).toBeGreaterThanOrEqual(2);
    expect(visible).toBe(discovered);
    expect(output).toContain('preloaded: preloaded');
    expect(output).toMatch(/estimated catalog: ~[\d.]+k? tokens\/model request/);
    expect(output).toContain('Listed skills are preloaded; they do not restrict discovery.');
    expect(output).toContain('Add `auto: false`');
  });

  it('reports agent-body prompt cost and warns about large dense instructions', async () => {
    const agentPath = join(testDir, 'large.agentuse');
    const largeDenseBody = `Do the task.\n${'Keep this instruction explicit. '.repeat(1600)}`;
    await writeFile(agentPath, `---
name: Large Agent
model: demo:test
---

${largeDenseBody}`);

    await runDoctor(agentPath);

    const output = logs.join('\n');
    expect(output).toContain('Prompt size');
    expect(output).toMatch(/agent body: [\d,]+ words, ~[\d.]+k? tokens\/model request/);
    expect(output).toMatch(/longest line: [\d,]+ characters/);
    expect(output).toContain('Very large body: split/reference it');
    expect(output).toContain('Dense line: split it into one invariant or branch per line');
  });

  it('reports a closed skill catalog without the open-discovery hint', async () => {
    await writeSkill('preloaded', 'The only skill this agent needs.');
    await writeSkill('hidden', 'A discovered skill hidden from this agent.');
    const agentPath = join(testDir, 'closed.agentuse');
    await writeFile(agentPath, `---
name: Closed Skills Agent
model: demo:test
skills:
  auto: false
  preloaded:
---

Use the preloaded skill.`);

    await runDoctor(agentPath);

    const output = logs.join('\n');
    expect(output).toContain('mode: closed');
    expect(Number(output.match(/discovered: (\d+)/)?.[1])).toBeGreaterThanOrEqual(2);
    expect(output).toContain('visible: 1');
    expect(output).toContain('preloaded: preloaded');
    expect(output).not.toContain('Listed skills are preloaded');
  });

  it('counts preloaded skill bodies in the per-request prompt cost', async () => {
    await writeSkill('heavy', 'A skill preloaded on every run.', 'Follow this rule exactly. '.repeat(700));
    await writeSkill('light', 'A small preloaded skill.', 'Keep it short.');
    const agentPath = join(testDir, 'preload.agentuse');
    await writeFile(agentPath, `---
name: Preload Agent
model: demo:test
skills:
  auto: false
  heavy:
  light:
---

Use the preloaded skills.`);

    await runDoctor(agentPath);

    const output = logs.join('\n');
    expect(output).toMatch(/preloaded skill bodies: 2, ~[\d.]+k tokens\/model request/);
    expect(output).toMatch(/heavy: ~[\d.]+k tokens/);
    expect(output).toMatch(/light: ~\d+ tokens/);
    // Heaviest first, so the skill to drop is the one you read first.
    expect(output.indexOf('heavy: ~')).toBeLessThan(output.indexOf('light: ~'));
    expect(output).toContain('Very large preloaded skills');
    expect(output).toMatch(/total: ~[\d.]+k tokens\/model request \(agent body \+ preloaded skills \+ skill catalog\)/);
  });

  it('reports the per-request total without a preloaded line when nothing is preloaded', async () => {
    const agentPath = join(testDir, 'bare.agentuse');
    await writeFile(agentPath, `---
name: Bare Agent
model: demo:test
skills:
  auto: false
---

Do the task.`);

    await runDoctor(agentPath);

    const output = logs.join('\n');
    expect(output).not.toContain('preloaded skill bodies:');
    expect(output).toContain('visible: 0');
    expect(output).toContain('estimated catalog: ~0 tokens/model request');
    expect(output).toMatch(/total: ~\d+ tokens\/model request/);
  });

  it('warns when open discovery makes the skill catalog expensive', async () => {
    await writeFatCatalog(8);
    const agentPath = join(testDir, 'fat-open.agentuse');
    await writeFile(agentPath, `---
name: Fat Catalog Agent
model: demo:test
---

Do the task.`);

    await runDoctor(agentPath);

    const output = logs.join('\n');
    expect(output).toMatch(/(Large|Very large) catalog: \d+ visible skills ship a name and description on every request\./);
    expect(output).toContain('Close discovery with `auto: false`');
  });

  it('does not print the auto: false fix twice when the open-discovery hint also fires', async () => {
    const names = await writeFatCatalog(8);
    const agentPath = join(testDir, 'fat-listed.agentuse');
    await writeFile(agentPath, `---
name: Fat Listed Agent
model: demo:test
skills: [${names[0]}]
---

Do the task.`);

    await runDoctor(agentPath);

    const output = logs.join('\n');
    expect(output).toMatch(/(Large|Very large) catalog: \d+ visible skills ship/);
    expect(output).not.toContain('Close discovery with `auto: false`');
    expect(output).toContain('Add `auto: false` to expose only the listed skills.');
  });

  it('warns about a large closed catalog without suggesting auto: false again', async () => {
    const names = await writeFatCatalog(8);
    const agentPath = join(testDir, 'fat-closed.agentuse');
    await writeFile(agentPath, `---
name: Fat Closed Agent
model: demo:test
skills:
  auto: false
${names.map((name) => `  ${name}:`).join('\n')}
---

Do the task.`);

    await runDoctor(agentPath);

    const output = logs.join('\n');
    expect(output).toContain('visible: 8');
    expect(output).toContain('Large catalog: 8 visible skills ship a name and description on every request.');
    expect(output).toContain('Shorten the listed skills to the ones this agent actually needs.');
    expect(output).not.toContain('Close discovery with `auto: false`');
  });
});
