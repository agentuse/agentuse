import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { gatherApprovalContext } from '../src/runner';

const AGENT_ID = 'agents/review';

async function makeSession(projectRoot: string) {
  const sessionManager = new SessionManager();
  const sessionID = await sessionManager.createSession({
    agent: { id: AGENT_ID, name: 'review', isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const messageID = await sessionManager.createMessage(sessionID, AGENT_ID, {
    user: { prompt: { task: 'do work' } },
    assistant: {
      system: [],
      modelID: 'demo:test',
      providerID: 'demo',
      mode: 'build',
      path: { cwd: projectRoot, root: projectRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  return { sessionManager, sessionID, messageID };
}

async function withSession(
  prefix: string,
  fn: (ctx: Awaited<ReturnType<typeof makeSession>>) => Promise<void>,
) {
  const originalXdg = process.env.XDG_DATA_HOME;
  const projectRoot = await mkdtemp(join(tmpdir(), prefix));
  process.env.XDG_DATA_HOME = projectRoot;
  try {
    await initStorage(projectRoot);
    await fn(await makeSession(projectRoot));
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    await rm(projectRoot, { recursive: true, force: true });
  }
}

describe('gatherApprovalContext', () => {
  it('pairs each reviewer comment with the work shown at its gate', async () => {
    await withSession('agentuse-approval-ctx-', async ({ sessionManager, sessionID, messageID }) => {
      // addPart's param type (Omit<Part, ...>) collapses the discriminated union
      // to its common keys, so the literals are cast — mirrors production usage.
      await sessionManager.addPart(sessionID, AGENT_ID, messageID, {
        type: 'tool',
        callID: 'call-1',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: {
            prompt: 'Approve this post?',
            summary: 'A blog post about productivity',
            draft: 'Unlock the secret to 10x productivity!',
            risk: 'Tone may be too promotional',
          },
          output: { status: 'comment', comment: 'too salesy' },
          time: { start: 1, end: 2 },
        },
      } as any);

      const ctx = await gatherApprovalContext(sessionManager, sessionID, AGENT_ID);
      expect(ctx.reviews).toHaveLength(1);
      expect(ctx.reviews[0].comment).toBe('too salesy');
      expect(ctx.reviews[0].work).toContain('Approve this post?');
      expect(ctx.reviews[0].work).toContain('Unlock the secret to 10x productivity!');
      expect(ctx.reviews[0].work).toContain('Tone may be too promotional');
    });
  });

  it('collects comments from multiple gates and skips bare approvals', async () => {
    await withSession('agentuse-approval-ctx-multi-', async ({ sessionManager, sessionID, messageID }) => {
      await sessionManager.addPart(sessionID, AGENT_ID, messageID, {
        type: 'tool',
        callID: 'call-1',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Round 1?', draft: 'first draft' },
          output: { status: 'comment', comment: 'always agree first' },
          time: { start: 1, end: 2 },
        },
      } as any);
      await sessionManager.addPart(sessionID, AGENT_ID, messageID, {
        type: 'tool',
        callID: 'call-2',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Round 2?', draft: 'second draft' },
          output: { status: 'approve' },
          time: { start: 3, end: 4 },
        },
      } as any);

      const ctx = await gatherApprovalContext(sessionManager, sessionID, AGENT_ID);
      expect(ctx.reviews).toHaveLength(1);
      expect(ctx.reviews[0].comment).toBe('always agree first');
    });
  });

  it('returns no reviews when the session has no commented gate', async () => {
    await withSession('agentuse-approval-ctx-none-', async ({ sessionManager, sessionID, messageID }) => {
      await sessionManager.addPart(sessionID, AGENT_ID, messageID, {
        type: 'text',
        text: 'Just some output, no gate.',
        role: 'assistant',
      } as any);

      const ctx = await gatherApprovalContext(sessionManager, sessionID, AGENT_ID);
      expect(ctx.reviews).toEqual([]);
    });
  });
});
