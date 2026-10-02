/**
 * Every surface resolves an await_human gate through core resume, so the
 * reviewer-decision rules serve enforces must hold there too: the CLI, the
 * worker, the cascade and the legacy resume route cannot complete a gate with
 * a malformed decision, approve a draft strict review escalated, or approve a
 * pick gate without naming the option (which would lease every option).
 */
import { afterEach, describe, expect, it, mock } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'fs/promises';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { applyResumeToolResult } from '../src/runner/resume';
import { LeaseStore, LEASE_FILENAME } from '../src/runner/approval-lease';
import { createSessionsCommand } from '../src/cli/sessions';

const ESCALATION = { kind: 'fresh-review-exhausted', critique: 'Unsafe draft.', attempts: 1, maxAttempts: 1 };
const PICK_GATE = {
  prompt: 'Which post?',
  options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
  changes: [{ optionId: 'a', content: 'publish a' }, { optionId: 'b', content: 'publish b' }],
};
const PLAIN_GATE = { prompt: 'Publish?', changes: [{ label: 'Post', content: 'publish unsafe-draft' }] };

const roots: string[] = [];
const savedEnv = { XDG_DATA_HOME: process.env.XDG_DATA_HOME, AGENTUSE_CONFIG_DIR: process.env.AGENTUSE_CONFIG_DIR };

afterEach(async () => {
  for (const [key, value] of Object.entries(savedEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function suspendedGate(options: {
  input: Record<string, unknown>;
  tool?: string;
  resumePayload?: Record<string, unknown>;
}) {
  const root = await mkdtemp(join(tmpdir(), 'agentuse-decision-validation-'));
  roots.push(root);
  const projectRoot = join(root, 'project');
  await mkdir(projectRoot, { recursive: true });
  process.env.XDG_DATA_HOME = join(root, 'data');
  process.env.AGENTUSE_CONFIG_DIR = join(root, 'config');
  await initStorage(projectRoot);
  const sessionManager = new SessionManager();
  const agentId = 'agents/gate';
  const sessionID = await sessionManager.createSession({
    agent: { id: agentId, name: 'gate', isSubAgent: false, filePath: join(projectRoot, 'gate.agentuse') },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const messageID = await sessionManager.createMessage(sessionID, agentId, {
    user: { prompt: { task: 'Draft a post' } },
    assistant: {
      system: ['system'], modelID: 'test', providerID: 'demo', mode: 'build',
      path: { cwd: projectRoot, root: projectRoot }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  const partID = await sessionManager.addPart(sessionID, agentId, messageID, {
    type: 'tool',
    callID: 'call-gate',
    tool: options.tool ?? 'await_human',
    state: {
      status: 'pending',
      input: options.input,
      suspendedAt: 1_000,
      resumePayload: { kind: 'await_human', prompt: 'Approve?', resumeToken: 'tok-1', ...options.resumePayload },
    },
  } as any);
  await sessionManager.updateSession(sessionID, agentId, { status: 'suspended' });
  const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
  const partStatus = async () => {
    const part = await sessionManager.getPart(sessionID, agentId, messageID, partID as string) as { state: { status: string } } | null;
    return part?.state.status;
  };
  return { projectRoot, sessionManager, sessionID, sessionDir, partStatus };
}

const resume = (gate: Awaited<ReturnType<typeof suspendedGate>>, toolResult: unknown) => applyResumeToolResult({
  sessionManager: gate.sessionManager,
  sessionId: gate.sessionID,
  toolResult,
  resumeToken: 'tok-1',
});

describe('core resume validates await_human decisions', () => {
  it('refuses a result that is not a reviewer decision and leaves the gate pending', async () => {
    const gate = await suspendedGate({ input: PLAIN_GATE });
    await expect(resume(gate, {})).rejects.toThrow('DECISION_INVALID');
    await expect(resume(gate, { status: 'done' })).rejects.toThrow('DECISION_INVALID');
    expect(await gate.partStatus()).toBe('pending');
  });

  it('refuses an approve on a gate strict review escalated, on every spelling, and grants nothing', async () => {
    const gate = await suspendedGate({ input: PLAIN_GATE, resumePayload: { reviewEscalation: ESCALATION } });
    await expect(resume(gate, { status: 'approve', reviewer: { username: 'cli' } })).rejects.toThrow('REVIEW_REVISION_REQUIRED');
    await expect(resume(gate, { status: 'approved', reviewer: { username: 'legacy' } })).rejects.toThrow('REVIEW_REVISION_REQUIRED');
    expect(await gate.partStatus()).toBe('pending');
    expect(fs.existsSync(join(gate.sessionDir, LEASE_FILENAME))).toBe(false);

    await resume(gate, { status: 'comment', comment: 'Tone it down', reviewer: { username: 'cli' } });
    expect(await gate.partStatus()).toBe('completed');
  });

  it('refuses an approve without a choice on a pick gate instead of leasing every option', async () => {
    const gate = await suspendedGate({ input: PICK_GATE });
    await expect(resume(gate, { status: 'approve', reviewer: { username: 'cli' } })).rejects.toThrow('CHOICE_REQUIRED');
    await expect(resume(gate, { status: 'approve', choice: 'c' })).rejects.toThrow('CHOICE_INVALID');
    await expect(resume(gate, { status: 'reject', choice: 'a' })).rejects.toThrow('CHOICE_REQUIRES_APPROVE');
    expect(fs.existsSync(join(gate.sessionDir, LEASE_FILENAME))).toBe(false);

    await resume(gate, { status: 'approve', choice: 'b', reviewer: { username: 'cli' } });
    expect(new LeaseStore(gate.sessionDir).read()?.entries.map((entry) => entry.content)).toEqual(['publish b']);
  });

  it('still stores any result for a suspended tool that is not an approval gate', async () => {
    const gate = await suspendedGate({ input: { question: 'Ready?' }, tool: 'await_signal' });
    await resume(gate, { status: 'done' });
    expect(await gate.partStatus()).toBe('completed');
  });
});

describe('sessions resume CLI on an approval gate', () => {
  async function runCli(args: string[]): Promise<string> {
    let stderr = '';
    const write = process.stderr.write;
    const exit = process.exit;
    process.stderr.write = ((chunk: string) => { stderr += chunk; return true; }) as typeof process.stderr.write;
    process.exit = mock((code?: number) => { throw new Error(`exit ${code}`); }) as unknown as typeof process.exit;
    try {
      await createSessionsCommand().parseAsync(args, { from: 'user' }).catch((error: Error) => {
        if (!error.message.startsWith('exit ')) throw error;
      });
    } finally {
      process.stderr.write = write;
      process.exit = exit;
    }
    return stderr;
  }

  it('refuses --tool-result for await_human', async () => {
    const gate = await suspendedGate({ input: PLAIN_GATE });
    const stderr = await runCli(['resume', gate.sessionID, '-C', gate.projectRoot, '--tool-result', '{}']);
    expect(stderr).toContain('not --tool-result');
    expect(await gate.partStatus()).toBe('pending');
  });

  it('requires --approve for --choice and a choice for an approve on a pick gate', async () => {
    const gate = await suspendedGate({ input: PICK_GATE });
    expect(await runCli(['resume', gate.sessionID, '-C', gate.projectRoot, '--choice', 'a'])).toContain('--choice requires --approve');
    expect(await runCli(['resume', gate.sessionID, '-C', gate.projectRoot, '--approve'])).toContain('CHOICE_REQUIRED');
    expect(await gate.partStatus()).toBe('pending');
    expect(fs.existsSync(join(gate.sessionDir, LEASE_FILENAME))).toBe(false);
  });
});
