import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

async function readResponseFor(rl: ReadlineInterface, id: string, timeoutMs = 10_000): Promise<any> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${id}`)); }, timeoutMs);
    const onLine = (line: string) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.id === id) { cleanup(); resolve(parsed); }
      } catch { /* ignore non-JSON diagnostics */ }
    };
    const cleanup = () => { clearTimeout(timeout); rl.off('line', onLine); };
    rl.on('line', onLine);
  });
}

async function readReady(rl: ReadlineInterface, timeoutMs = 10_000): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error('worker never became ready')); }, timeoutMs);
    const onLine = (line: string) => {
      try { if (JSON.parse(line)?.type === 'ready') { cleanup(); resolve(); } } catch { /* ignore */ }
    };
    const cleanup = () => { clearTimeout(timeout); rl.off('line', onLine); };
    rl.on('line', onLine);
  });
}

const ASSISTANT = (projectRoot: string) => ({
  system: [],
  modelID: 'demo:test',
  providerID: 'demo',
  mode: 'build',
  path: { cwd: projectRoot, root: projectRoot },
  cost: 0,
  tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
});

describe('a failed session that was resumed', () => {
  let worker: { child: ChildProcessWithoutNullStreams; rl: ReadlineInterface } | undefined;
  let dataHome: string | undefined;
  let originalXdg: string | undefined;

  afterEach(async () => {
    worker?.rl.close();
    worker?.child.kill();
    worker = undefined;
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    if (dataHome) await rm(dataHome, { recursive: true, force: true });
    dataHome = undefined;
  });

  it('keeps the failure marker where it happened and stops reporting the run as failed', async () => {
    originalXdg = process.env.XDG_DATA_HOME;
    dataHome = await mkdtemp(join(tmpdir(), 'agentuse-resume-error-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;

    await initStorage(projectRoot);

    const sm = new SessionManager();
    const agentId = 'agents/writer';
    const sessionId = await sm.createSession({
      agent: { id: agentId, name: 'Writer', isSubAgent: false },
      model: 'demo:test', version: 'test', config: {},
      project: { root: projectRoot, cwd: projectRoot },
    });
    const messageId = await sm.createMessage(sessionId, agentId, {
      user: { prompt: { task: 'draft' } }, assistant: ASSISTANT(projectRoot),
    });

    const before = Date.now();
    await sm.addPart(sessionId, agentId, messageId, {
      type: 'text', text: 'work before the failure', time: { start: before, end: before },
    } as any);

    // The run reports itself incomplete: session-level error, no error part.
    await sm.setSessionError(sessionId, agentId, { code: 'INCOMPLETE', message: 'ran out of runway' });

    // A human resumes it; the session goes back to running and produces more work.
    await sm.setSessionRunning(sessionId, agentId);
    const after = Date.now() + 60_000;
    await sm.addPart(sessionId, agentId, messageId, {
      type: 'text', text: 'work after the resume', time: { start: after, end: after },
    } as any);

    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], { cwd: process.cwd(), env: { ...process.env } });
    const rl = createInterface({ input: child.stdout });
    worker = { child, rl };
    await readReady(rl);

    child.stdin.write(`${JSON.stringify({ id: 'info', type: 'approval-info', projectRoot, sessionId, skipTokenCheck: true })}\n`);
    const info = await readResponseFor(rl, 'info');
    expect(info.success).toBe(true);

    const logs: Array<{ id: string; time?: number; title: string }> = info.approval.logs;
    const failure = logs.find((entry) => entry.id === `session-error:${sessionId}`);
    expect(failure).toBeDefined();
    expect(failure!.title).toBe('Session failed');

    // The marker sits at the moment of the failure, not below the work that
    // happened after the resume.
    const resumedWork = logs.find((entry) => entry.title === 'Assistant response' && entry.time === after);
    expect(resumedWork).toBeDefined();
    expect(failure!.time).toBeLessThan(after);
    expect(failure!.time).toBeGreaterThanOrEqual(before);

    // A run that is working again is not a failed run.
    expect(info.approval.sessionStatus).toBe('running');
    expect(info.approval.errorCode).toBeUndefined();
    expect(info.approval.errorMessage).toBeUndefined();
  }, 30_000);

  it('keeps separate historical markers across multiple failed attempts', async () => {
    originalXdg = process.env.XDG_DATA_HOME;
    dataHome = await mkdtemp(join(tmpdir(), 'agentuse-resume-error-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;

    await initStorage(projectRoot);
    const sm = new SessionManager();
    const agentId = 'agents/writer';
    const sessionId = await sm.createSession({
      agent: { id: agentId, name: 'Writer', isSubAgent: false },
      model: 'demo:test', version: 'test', config: {},
      project: { root: projectRoot, cwd: projectRoot },
    });
    await sm.createMessage(sessionId, agentId, {
      user: { prompt: { task: 'draft' } }, assistant: ASSISTANT(projectRoot),
    });
    await sm.setSessionError(sessionId, agentId, { code: 'FIRST', message: 'first attempt failed' });
    await sm.setSessionRunning(sessionId, agentId);
    await sm.setSessionError(sessionId, agentId, { code: 'SECOND', message: 'second attempt failed' });
    await sm.setSessionRunning(sessionId, agentId);

    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], { cwd: process.cwd(), env: { ...process.env } });
    const rl = createInterface({ input: child.stdout });
    worker = { child, rl };
    await readReady(rl);
    child.stdin.write(`${JSON.stringify({ id: 'info', type: 'approval-info', projectRoot, sessionId, skipTokenCheck: true })}\n`);
    const info = await readResponseFor(rl, 'info');

    expect(info.approval.logs.filter((entry: { id: string }) => entry.id.startsWith(`session-error:${sessionId}`))).toHaveLength(2);
    expect(info.approval.sessionStatus).toBe('running');
    expect(info.approval.errorCode).toBeUndefined();
  }, 30_000);

  it('still reports the error while the failure is the current state', async () => {
    originalXdg = process.env.XDG_DATA_HOME;
    dataHome = await mkdtemp(join(tmpdir(), 'agentuse-resume-error-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;

    await initStorage(projectRoot);

    const sm = new SessionManager();
    const agentId = 'agents/writer';
    const sessionId = await sm.createSession({
      agent: { id: agentId, name: 'Writer', isSubAgent: false },
      model: 'demo:test', version: 'test', config: {},
      project: { root: projectRoot, cwd: projectRoot },
    });
    await sm.createMessage(sessionId, agentId, {
      user: { prompt: { task: 'draft' } }, assistant: ASSISTANT(projectRoot),
    });
    await sm.setSessionError(sessionId, agentId, { code: 'INCOMPLETE', message: 'ran out of runway' });

    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], { cwd: process.cwd(), env: { ...process.env } });
    const rl = createInterface({ input: child.stdout });
    worker = { child, rl };
    await readReady(rl);

    child.stdin.write(`${JSON.stringify({ id: 'info', type: 'approval-info', projectRoot, sessionId, skipTokenCheck: true })}\n`);
    const info = await readResponseFor(rl, 'info');
    expect(info.success).toBe(true);
    expect(info.approval.sessionStatus).toBe('error');
    expect(info.approval.errorCode).toBe('INCOMPLETE');
    expect(info.approval.errorMessage).toBe('ran out of runway');
  }, 30_000);
});
