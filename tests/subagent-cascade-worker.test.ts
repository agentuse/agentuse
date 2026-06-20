import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

// Drive the internal worker over its stdin/stdout JSON RPC and read the response
// matching a request id (ignoring diagnostic / non-matching lines).
async function readResponseFor(rl: ReadlineInterface, id: string, timeoutMs = 10_000): Promise<any> {
  return await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`Timed out waiting for ${id}`)); }, timeoutMs);
    const onLine = (line: string) => {
      try {
        const parsed = JSON.parse(line);
        if (parsed && parsed.id === id) { cleanup(); resolve(parsed); }
        else if (parsed && parsed.type === 'ready') { /* startup line */ }
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

describe('subagent approval cascade (worker integration)', () => {
  let worker: { child: ChildProcessWithoutNullStreams; rl: ReadlineInterface } | undefined;

  afterEach(() => {
    worker?.rl.close();
    worker?.child.kill();
    worker = undefined;
  });

  it('surfaces a delegated leaf gate at the manager root, with the leaf as view-only', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-cascade-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;
    try {
      await initStorage(projectRoot);

      // Manager (root) session — not a subagent.
      const rootSm = new SessionManager();
      const rootAgentId = 'agents/manager';
      const rootId = await rootSm.createSession({
        agent: { id: rootAgentId, name: 'Manager', isSubAgent: false },
        model: 'demo:test', version: 'test', config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const rootMsg = await rootSm.createMessage(rootId, rootAgentId, {
        user: { prompt: { task: 'delegate' } }, assistant: ASSISTANT(projectRoot),
      });

      // Leaf session — nested under the manager, marked as a sub-agent.
      const leafSm = new SessionManager();
      leafSm.setParentPath(rootSm.getFullPath()!);
      const leafAgentId = 'agents/reply-to-post';
      const leafId = await leafSm.createSession({
        agent: { id: leafAgentId, name: 'reply-to-post', isSubAgent: true },
        parentSessionID: rootId,
        model: 'demo:test', version: 'test', config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const leafMsg = await leafSm.createMessage(leafId, leafAgentId, {
        user: { prompt: { task: 'reply' } }, assistant: ASSISTANT(projectRoot),
      });
      // Leaf holds the real human gate.
      await leafSm.addPart(leafId, leafAgentId, leafMsg, {
        type: 'tool', callID: 'leaf-call', tool: 'await_human',
        state: {
          status: 'pending', input: { prompt: 'Approve this reply?' }, suspendedAt: Date.now(),
          resumePayload: { kind: 'await_human', resumeToken: 'leaf-token', approvalUrl: 'http://leaf/url' },
        },
      } as any);
      await leafSm.setSessionSuspended(leafId, leafAgentId);

      // Manager is parked on the leaf's gate via a subagent_wait bookmark.
      await rootSm.addPart(rootId, rootAgentId, rootMsg, {
        type: 'tool', callID: 'root-call', tool: 'subagent__reply_to_post',
        state: {
          status: 'pending', input: { task: 'reply' }, suspendedAt: Date.now(),
          resumePayload: { kind: 'subagent_wait', childSessionID: leafId, childAgentName: 'reply-to-post' },
        },
      } as any);
      await rootSm.setSessionSuspended(rootId, rootAgentId);

      // Start the worker (inherits XDG_DATA_HOME).
      const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], { cwd: process.cwd(), env: { ...process.env } });
      const rl = createInterface({ input: child.stdout });
      worker = { child, rl };
      await readReady(rl);

      // 1. Gate surfaces at the ROOT, labeled with the leaf, with the leaf token.
      child.stdin.write(`${JSON.stringify({ id: 'root-info', type: 'approval-info', projectRoot, sessionId: rootId, skipTokenCheck: true })}\n`);
      const rootInfo = await readResponseFor(rl, 'root-info');
      expect(rootInfo.success).toBe(true);
      expect(rootInfo.approval.sessionId).toBe(rootId);
      expect(rootInfo.approval.currentResumeToken).toBe('leaf-token');
      expect(rootInfo.approval.prompt).toBe('Approve this reply?');
      expect(rootInfo.approval.originAgent?.name).toBe('reply-to-post');
      expect(typeof rootInfo.approval.approvalUrl).toBe('string');
      expect(rootInfo.approval.approvalUrl).toContain(rootId);

      // 2. The leaf page is view-only: no actionable token, points back at the root.
      child.stdin.write(`${JSON.stringify({ id: 'leaf-info', type: 'approval-info', projectRoot, sessionId: leafId, skipTokenCheck: true })}\n`);
      const leafInfo = await readResponseFor(rl, 'leaf-info');
      expect(leafInfo.success).toBe(true);
      expect(leafInfo.approval.viewOnly).toBe(true);
      expect(leafInfo.approval.rootSessionId).toBe(rootId);
      expect(leafInfo.approval.currentResumeToken).toBeUndefined();

      // 3. The inbox lists exactly one approval — at the root, labeled with the leaf.
      child.stdin.write(`${JSON.stringify({ id: 'list', type: 'list-approvals', projectRoot })}\n`);
      const list = await readResponseFor(rl, 'list');
      expect(list.success).toBe(true);
      expect(list.approvals).toHaveLength(1);
      expect(list.approvals[0]).toMatchObject({
        sessionId: rootId,
        agentName: 'reply-to-post',
        resumeToken: 'leaf-token',
        status: 'pending',
      });
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(dataHome, { recursive: true, force: true });
    }
  });
});
