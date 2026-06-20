import { afterEach, describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { createInterface, type Interface as ReadlineInterface } from 'readline';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

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

// Flatten every part of a session's messages, in order, for assertions.
async function loadParts(sm: InstanceType<typeof SessionManager>, sessionId: string, agentId: string): Promise<any[]> {
  const messages = await sm.getSessionMessages(sessionId, agentId);
  const parts: any[] = [];
  for (const m of messages) {
    parts.push(...(await sm.getMessageParts(sessionId, agentId, (m as any).id)));
  }
  return parts;
}

describe('subagent approval cascade — resume (worker integration)', () => {
  let worker: { child: ChildProcessWithoutNullStreams; rl: ReadlineInterface } | undefined;

  afterEach(() => {
    worker?.rl.close();
    worker?.child.kill();
    worker = undefined;
  });

  // The highest-risk path added in #131: resolving a delegated leaf gate must descend
  // through every parked ancestor, run the leaf, then walk back UP completing each
  // ancestor's subagent_wait bookmark with its child's real output and resuming it,
  // finally reporting the root manager's own text at the root id. This uses a 3-level
  // chain (manager -> mid -> leaf) so the walk-up loop iterates more than once, and
  // gives each level a distinct demo model so propagation at every hop is verifiable.
  it('descends to the leaf gate, resolves it, and walks the chain back up to the root', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-cascade-resume-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;
    try {
      await mkdir(projectRoot, { recursive: true });
      await initStorage(projectRoot);

      // Real .agentuse files so the worker can parse + run them with the (keyless)
      // demo provider. A distinct demo variant per level => distinct, identifiable text.
      const managerPath = join(projectRoot, 'manager.agentuse');
      const midPath = join(projectRoot, 'mid.agentuse');
      const leafPath = join(projectRoot, 'leaf.agentuse');
      await writeFile(managerPath, '---\nmodel: demo:default\n---\nDelegate the work and report back.\n');
      await writeFile(midPath, '---\nmodel: demo:welcome\n---\nDelegate the reply and report back.\n');
      await writeFile(leafPath, '---\nmodel: demo:hello\n---\nReply to the post, then finish.\n');
      const MANAGER_TEXT = 'The demo provider is used for testing'; // unique to demo:default
      const MID_TEXT = 'To get started with real AI models';        // unique to demo:welcome
      const LEAF_TEXT = 'Happy building';                            // unique to demo:hello

      // Manager (root) session — not a subagent.
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

      // Mid session — sub-agent of the manager.
      const midSm = new SessionManager();
      midSm.setParentPath(rootSm.getFullPath()!);
      const midAgentId = 'agents/coordinator';
      const midId = await midSm.createSession({
        agent: { id: midAgentId, name: 'coordinator', isSubAgent: true, filePath: midPath },
        parentSessionID: rootId,
        model: 'demo:welcome', version: 'test', config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const midMsg = await midSm.createMessage(midId, midAgentId, {
        user: { prompt: { task: 'coordinate' } }, assistant: ASSISTANT(projectRoot),
      });

      // Leaf session — sub-agent of the mid, holds the real human gate.
      const leafSm = new SessionManager();
      leafSm.setParentPath(midSm.getFullPath()!);
      const leafAgentId = 'agents/reply-to-post';
      const leafId = await leafSm.createSession({
        agent: { id: leafAgentId, name: 'reply-to-post', isSubAgent: true, filePath: leafPath },
        parentSessionID: midId,
        model: 'demo:hello', version: 'test', config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const leafMsg = await leafSm.createMessage(leafId, leafAgentId, {
        user: { prompt: { task: 'reply' } }, assistant: ASSISTANT(projectRoot),
      });
      await leafSm.addPart(leafId, leafAgentId, leafMsg, {
        type: 'tool', callID: 'leaf-call', tool: 'await_human',
        state: {
          status: 'pending', input: { prompt: 'Approve this reply?' }, suspendedAt: Date.now(),
          resumePayload: { kind: 'await_human', resumeToken: 'leaf-token', approvalUrl: 'http://leaf/url' },
        },
      } as any);
      await leafSm.setSessionSuspended(leafId, leafAgentId);

      // Mid is parked on the leaf's gate via a subagent_wait bookmark.
      await midSm.addPart(midId, midAgentId, midMsg, {
        type: 'tool', callID: 'mid-call', tool: 'subagent__reply_to_post',
        state: {
          status: 'pending', input: { task: 'reply' }, suspendedAt: Date.now(),
          resumePayload: { kind: 'subagent_wait', childSessionID: leafId, childAgentName: 'reply-to-post' },
        },
      } as any);
      await midSm.setSessionSuspended(midId, midAgentId);

      // Manager is parked on the mid's bookmark, one level up.
      await rootSm.addPart(rootId, rootAgentId, rootMsg, {
        type: 'tool', callID: 'root-call', tool: 'subagent__coordinator',
        state: {
          status: 'pending', input: { task: 'coordinate' }, suspendedAt: Date.now(),
          resumePayload: { kind: 'subagent_wait', childSessionID: midId, childAgentName: 'coordinator' },
        },
      } as any);
      await rootSm.setSessionSuspended(rootId, rootAgentId);

      // Resume rehydrates each session's conversation from stored parts
      // (rehydrateMessages) and binds a tools snapshot. The demo model uses no tools,
      // so an empty snapshot satisfies the "Missing tools snapshot" guard per session.
      await leafSm.writeToolsSnapshot(leafId, leafAgentId, { tools: [] });
      await midSm.writeToolsSnapshot(midId, midAgentId, { tools: [] });
      await rootSm.writeToolsSnapshot(rootId, rootAgentId, { tools: [] });

      // Start the worker (inherits XDG_DATA_HOME).
      const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], { cwd: process.cwd(), env: { ...process.env } });
      const rl = createInterface({ input: child.stdout });
      worker = { child, rl };
      await readReady(rl);

      // Resume the ROOT with the LEAF's token + an approve decision. The cascade must
      // descend manager -> mid -> leaf, resolve the leaf, then walk back up to the root.
      child.stdin.write(`${JSON.stringify({
        id: 'resume', type: 'resume', projectRoot, sessionId: rootId,
        resumeToken: 'leaf-token',
        toolResult: { status: 'approve', reviewer: { username: 'test' } },
      })}\n`);
      const res = await readResponseFor(rl, 'resume');

      // 1. The chain resumed and the final response is reported at the ROOT id, carrying
      //    the manager's own final text (not the leaf's, not the mid's).
      expect(res.success).toBe(true);
      expect(res.result.sessionId).toBe(rootId);
      expect(res.result.finishReason).not.toBe('suspended');
      expect(res.result.text).toContain(MANAGER_TEXT);

      // 2. Durable state: every level ran to completion.
      const verifySm = new SessionManager();
      expect((await verifySm.findSession(leafId))?.session.status).toBe('completed');
      expect((await verifySm.findSession(midId))?.session.status).toBe('completed');
      const rootFound = await verifySm.findSession(rootId);
      expect(rootFound?.session.status).toBe('completed');

      // 3. Each ancestor's subagent_wait bookmark is completed with its child's real
      //    output — verifying the child->parent propagation at both walk-up hops.
      const midFound = await verifySm.findSession(midId);
      const midParts = await loadParts(verifySm, midId, midFound!.agentId);
      const midBookmark = midParts.find((p: any) => p?.tool === 'subagent__reply_to_post');
      expect(midBookmark?.state?.status).toBe('completed');
      expect(JSON.stringify(midBookmark?.state?.output ?? '')).toContain(LEAF_TEXT);

      const rootParts = await loadParts(verifySm, rootId, rootFound!.agentId);
      const rootBookmark = rootParts.find((p: any) => p?.tool === 'subagent__coordinator');
      expect(rootBookmark?.state?.status).toBe('completed');
      expect(JSON.stringify(rootBookmark?.state?.output ?? '')).toContain(MID_TEXT);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(dataHome, { recursive: true, force: true });
    }
  }, 30_000);

  it('restores the delegated gate when leaf resume setup fails before execution', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const dataHome = await mkdtemp(join(tmpdir(), 'agentuse-cascade-rollback-'));
    const projectRoot = join(dataHome, 'project');
    process.env.XDG_DATA_HOME = dataHome;
    try {
      await mkdir(projectRoot, { recursive: true });
      await initStorage(projectRoot);

      const managerPath = join(projectRoot, 'manager.agentuse');
      const leafPath = join(projectRoot, 'leaf.agentuse');
      await writeFile(managerPath, '---\nmodel: demo:default\n---\nDelegate the work and report back.\n');
      await writeFile(leafPath, '---\nmodel: demo:hello\n---\nReply to the post, then finish.\n');

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
        agent: { id: leafAgentId, name: 'reply-to-post', isSubAgent: true, filePath: leafPath },
        parentSessionID: rootId,
        model: 'demo:hello', version: 'test', config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      const leafMsg = await leafSm.createMessage(leafId, leafAgentId, {
        user: { prompt: { task: 'reply' } }, assistant: ASSISTANT(projectRoot),
      });
      await leafSm.addPart(leafId, leafAgentId, leafMsg, {
        type: 'tool', callID: 'leaf-call', tool: 'await_human',
        state: {
          status: 'pending', input: { prompt: 'Approve this reply?' }, suspendedAt: Date.now(),
          resumePayload: { kind: 'await_human', resumeToken: 'leaf-token', approvalUrl: 'http://leaf/url' },
        },
      } as any);
      await leafSm.setSessionSuspended(leafId, leafAgentId);

      await rootSm.addPart(rootId, rootAgentId, rootMsg, {
        type: 'tool', callID: 'root-call', tool: 'subagent__reply_to_post',
        state: {
          status: 'pending', input: { task: 'reply' }, suspendedAt: Date.now(),
          resumePayload: { kind: 'subagent_wait', childSessionID: leafId, childAgentName: 'reply-to-post' },
        },
      } as any);
      await rootSm.setSessionSuspended(rootId, rootAgentId);

      const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], { cwd: process.cwd(), env: { ...process.env } });
      const rl = createInterface({ input: child.stdout });
      worker = { child, rl };
      await readReady(rl);

      child.stdin.write(`${JSON.stringify({
        id: 'resume', type: 'resume', projectRoot, sessionId: rootId,
        resumeToken: 'leaf-token',
        toolResult: { status: 'approve', reviewer: { username: 'test' } },
      })}\n`);
      const res = await readResponseFor(rl, 'resume');
      expect(res.success).toBe(false);
      expect(res.error.message).toContain('Missing tools snapshot');

      const verifySm = new SessionManager();
      const leafFound = await verifySm.findSession(leafId);
      expect(leafFound?.session.status).toBe('suspended');
      const leafParts = await loadParts(verifySm, leafId, leafFound!.agentId);
      const leafGate = leafParts.find((p: any) => p?.tool === 'await_human');
      expect(leafGate?.state?.status).toBe('pending');
      expect(leafGate?.state?.resumePayload?.resumeToken).toBe('leaf-token');

      const rootFound = await verifySm.findSession(rootId);
      expect(rootFound?.session.status).toBe('suspended');
      const rootParts = await loadParts(verifySm, rootId, rootFound!.agentId);
      const rootBookmark = rootParts.find((p: any) => p?.tool === 'subagent__reply_to_post');
      expect(rootBookmark?.state?.status).toBe('pending');
      expect(rootBookmark?.state?.resumePayload?.childSessionID).toBe(leafId);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(dataHome, { recursive: true, force: true });
    }
  }, 30_000);
});
