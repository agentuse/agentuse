import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { acquireOwnershipLock } from '../src/utils/ownership-lock';

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// Drive the internal worker over its stdin/stdout JSON RPC and read the response
// matching a request id (ignoring diagnostic / non-matching lines).
async function readResponseFor(rl: ReadlineInterface, id: string, timeoutMs = 30_000): Promise<any> {
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

async function loadParts(sm: InstanceType<typeof SessionManager>, sessionId: string, agentId: string): Promise<any[]> {
  const messages = await sm.getSessionMessages(sessionId, agentId);
  const parts: any[] = [];
  for (const m of messages) {
    parts.push(...(await sm.getMessageParts(sessionId, agentId, (m as any).id)));
  }
  return parts;
}

/**
 * The stranded state issue #199 describes: a delegated child that ran to
 * completion (final text + report_complete on disk) while its manager is still
 * parked on the subagent_wait bookmark — the worker that should have walked the
 * chain up died in between.
 */
async function makeStrandedCascade(projectRoot: string) {
  const managerPath = join(projectRoot, 'manager.agentuse');
  await writeFile(managerPath, '---\nmodel: demo:default\n---\nDelegate the work and report back.\n');

  const rootSm = new SessionManager();
  const rootAgentId = 'agents/manager';
  const rootId = await rootSm.createSession({
    agent: { id: rootAgentId, name: 'Manager', isSubAgent: false, filePath: managerPath },
    model: 'demo:default', version: 'test', config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const rootMsg = await rootSm.createMessage(rootId, rootAgentId, {
    user: { prompt: { task: 'delegate' } }, assistant: ASSISTANT(projectRoot),
  });

  const leafSm = new SessionManager();
  leafSm.setParentPath(rootSm.getFullPath()!);
  const leafAgentId = 'agents/reply-to-post';
  const leafId = await leafSm.createSession({
    agent: { id: leafAgentId, name: 'reply-to-post', isSubAgent: true },
    parentSessionID: rootId,
    model: 'demo:hello', version: 'test', config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const leafMsg = await leafSm.createMessage(leafId, leafAgentId, {
    user: { prompt: { task: 'reply' } }, assistant: ASSISTANT(projectRoot),
  });
  // The child's durable result: streamed prose plus a declared outcome.
  await leafSm.addPart(leafId, leafAgentId, leafMsg, {
    type: 'text', text: 'Posted the reply and verified the count went up.',
  } as any);
  await leafSm.addPart(leafId, leafAgentId, leafMsg, {
    type: 'tool', callID: 'leaf-report', tool: 'report_complete',
    state: {
      status: 'completed',
      input: { headline: 'Posted 1/1 replies, verified', details: 'Reply landed on the target thread.' },
      output: 'Recorded and delivered',
      time: { start: Date.now() - 2_000, end: Date.now() - 1_000 },
    },
  } as any);
  await leafSm.updateSession(leafId, leafAgentId, { status: 'completed' });

  // The manager is still parked on that (finished) child.
  await rootSm.addPart(rootId, rootAgentId, rootMsg, {
    type: 'tool', callID: 'root-call', tool: 'subagent__reply_to_post',
    state: {
      status: 'pending', input: { task: 'reply' }, suspendedAt: Date.now() - 3_000,
      resumePayload: { kind: 'subagent_wait', childSessionID: leafId, childAgentName: 'reply-to-post' },
    },
  } as any);
  await rootSm.setSessionSuspended(rootId, rootAgentId);
  // Resume rehydrates the manager's conversation from stored parts and binds a
  // tools snapshot; the demo model uses no tools, so an empty snapshot suffices.
  await rootSm.writeToolsSnapshot(rootId, rootAgentId, { tools: [] });

  return { rootSm, rootId, rootAgentId, rootMsg, leafId };
}

describe('finish-cascade (worker integration)', () => {
  let workers: Array<{ child: ChildProcessWithoutNullStreams; rl: ReadlineInterface }> = [];

  afterEach(() => {
    for (const worker of workers) {
      worker.rl.close();
      worker.child.kill();
    }
    workers = [];
  });

  it('completes a stranded manager from the child\'s stored result', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-finish-cascade-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;
    try {
      await mkdir(projectRoot, { recursive: true });
      await initStorage(projectRoot);
      const { rootId } = await makeStrandedCascade(projectRoot);

      const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], { cwd: process.cwd(), env: { ...process.env } });
      const rl = createInterface({ input: child.stdout });
      workers.push({ child, rl });
      await readReady(rl);

      child.stdin.write(`${JSON.stringify({ id: 'finish', type: 'finish-cascade', projectRoot, sessionId: rootId })}\n`);
      const res = await readResponseFor(rl, 'finish');

      // The manager resumed and finished; the response reports the root.
      expect(res.success).toBe(true);
      expect(res.result.sessionId).toBe(rootId);
      expect(res.result.finishReason).not.toBe('suspended');

      const verifySm = new SessionManager();
      const rootFound = await verifySm.findSession(rootId);
      expect(rootFound?.session.status).toBe('completed');

      // The bookmark carries the child's real result — headline and prose both.
      const rootParts = await loadParts(verifySm, rootId, rootFound!.agentId);
      const bookmark = rootParts.find((p: any) => p?.tool === 'subagent__reply_to_post') as any;
      expect(bookmark?.state?.status).toBe('completed');
      const bookmarkOutput = JSON.stringify(bookmark?.state?.output ?? '');
      expect(bookmarkOutput).toContain('Posted 1/1 replies, verified');
      expect(bookmarkOutput).toContain('Posted the reply and verified the count went up.');
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(dataHome, { recursive: true, force: true });
    }
  }, 30_000);

  // A run an older sweep already stamped CASCADE_ORPHANED is the same durable
  // state with a stale verdict on top; finish-cascade clears it and completes.
  it('recovers a manager an earlier sweep already stamped CASCADE_ORPHANED', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-finish-orphaned-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;
    try {
      await mkdir(projectRoot, { recursive: true });
      await initStorage(projectRoot);
      const { rootSm, rootId, rootAgentId } = await makeStrandedCascade(projectRoot);
      await rootSm.setSessionError(rootId, rootAgentId, {
        code: 'CASCADE_ORPHANED',
        message: 'Waiting on delegated sub-agent "reply-to-post", but it ended completed.',
      });

      const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], { cwd: process.cwd(), env: { ...process.env } });
      const rl = createInterface({ input: child.stdout });
      workers.push({ child, rl });
      await readReady(rl);

      child.stdin.write(`${JSON.stringify({ id: 'finish', type: 'finish-cascade', projectRoot, sessionId: rootId })}\n`);
      const res = await readResponseFor(rl, 'finish');
      expect(res.success).toBe(true);

      const verifySm = new SessionManager();
      const rootFound = await verifySm.findSession(rootId);
      expect(rootFound?.session.status).toBe('completed');
      expect(rootFound?.session.error).toBeUndefined();
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(dataHome, { recursive: true, force: true });
    }
  }, 30_000);

  // Finishing must be single-shot: once a live process resumed the chain (or it
  // ended), a second finish-cascade is a double-fire and must refuse.
  it('refuses a session that is not stranded', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-finish-refuse-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;
    try {
      await mkdir(projectRoot, { recursive: true });
      await initStorage(projectRoot);
      const { rootSm, rootId, rootAgentId } = await makeStrandedCascade(projectRoot);
      await rootSm.updateSession(rootId, rootAgentId, { status: 'completed' });

      const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], { cwd: process.cwd(), env: { ...process.env } });
      const rl = createInterface({ input: child.stdout });
      workers.push({ child, rl });
      await readReady(rl);

      child.stdin.write(`${JSON.stringify({ id: 'finish', type: 'finish-cascade', projectRoot, sessionId: rootId })}\n`);
      const res = await readResponseFor(rl, 'finish');
      expect(res.success).toBe(false);
      expect(res.error.code).toBe('SESSION_NOT_SUSPENDED');
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(dataHome, { recursive: true, force: true });
    }
  }, 30_000);

  it('allows only one cross-process recovery to claim a stranded root', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-finish-concurrent-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;
    let blocker: Awaited<ReturnType<typeof acquireOwnershipLock>> | undefined;
    try {
      await mkdir(projectRoot, { recursive: true });
      await initStorage(projectRoot);
      const { rootSm, rootId, rootAgentId } = await makeStrandedCascade(projectRoot);
      const sessionDirectory = await rootSm.getSessionDirectory(rootId, rootAgentId);

      // Hold the shared claim while both workers enter finish-cascade. This
      // makes the simultaneous precondition deterministic instead of relying
      // on process scheduling to place both requests in the race window.
      blocker = await acquireOwnershipLock(join(sessionDirectory, '.finish-cascade-claim'), {
        label: 'test-blocker',
      });

      for (let i = 0; i < 2; i++) {
        const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
          cwd: process.cwd(),
          env: { ...process.env },
        });
        const rl = createInterface({ input: child.stdout });
        workers.push({ child, rl });
        await readReady(rl);
      }

      let responseLanded = false;
      const responses = workers.map(({ child, rl }, index) => {
        const id = `finish-${index + 1}`;
        const response = readResponseFor(rl, id).then((value) => {
          responseLanded = true;
          return value;
        });
        child.stdin.write(`${JSON.stringify({ id, type: 'finish-cascade', projectRoot, sessionId: rootId })}\n`);
        return response;
      });

      await sleep(200);
      expect(responseLanded).toBe(false);
      await blocker.release();
      blocker = undefined;

      const results = await Promise.all(responses);
      expect(results.filter((result) => result.success)).toHaveLength(1);
      expect(results.filter((result) => !result.success)).toEqual([
        expect.objectContaining({ error: expect.objectContaining({ code: 'SESSION_NOT_SUSPENDED' }) }),
      ]);
      expect((await rootSm.findSession(rootId))?.session.status).toBe('completed');
    } finally {
      await blocker?.release();
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(dataHome, { recursive: true, force: true });
    }
  }, 45_000);
});
