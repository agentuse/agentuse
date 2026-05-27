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
    expect(output).toContain('Skill trust: trusted');
    expect(output).not.toContain('Skill grants:');
  });
});
