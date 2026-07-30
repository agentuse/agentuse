import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { gatherApprovalContext, gatherHumanApprovalHistory } from '../src/runner';

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

  it('includes structured changes and the reference excerpt in the paired work', async () => {
    await withSession('agentuse-approval-ctx-changes-', async ({ sessionManager, sessionID, messageID }) => {
      await sessionManager.addPart(sessionID, AGENT_ID, messageID, {
        type: 'tool',
        callID: 'call-1',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: {
            prompt: 'Post this comment?',
            reference: { label: 'Replying to', excerpt: 'The economy reorganized.' },
            changes: [
              {
                label: 'Comment to post',
                content: 'birdc reply 1 "The electricity comparison is the right one."',
                displayContent: 'The electricity comparison is the right one.',
              },
              { content: 'Like the post' },
            ],
          },
          output: { status: 'comment', comment: 'soften the opener' },
          time: { start: 1, end: 2 },
        },
      } as any);

      const ctx = await gatherApprovalContext(sessionManager, sessionID, AGENT_ID);
      expect(ctx.reviews).toHaveLength(1);
      expect(ctx.reviews[0].work).toContain('The economy reorganized.');
      expect(ctx.reviews[0].work).toContain('Comment to post: The electricity comparison is the right one.');
      expect(ctx.reviews[0].work).toContain('Comment to post — exact command: birdc reply 1');
      expect(ctx.reviews[0].work).toContain('Change 2: Like the post');
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

  it('excludes judge, preflight and runtime comments so they cannot become human learnings', async () => {
    // These resolve await_human with the same shape a person does. Captured as
    // reviews they become confidence-0.95 "reviewer corrections" that outrank
    // everything the agent worked out for itself, i.e. the runtime teaching
    // itself from its own diagnostics.
    await withSession('agentuse-approval-ctx-machine-', async ({ sessionManager, sessionID, messageID }) => {
      const machineGates = [
        { callID: 'judge', output: { status: 'rejected', source: 'pre-review', comment: 'judge says rewrite this', reviewer: { username: 'verify-judge' } } },
        { callID: 'preflight', output: { status: 'commented', source: 'gate-preflight', comment: 'gate plan is invalid' } },
        { callID: 'runtime', output: { status: 'commented', comment: 'runtime diagnostic', reviewer: { name: 'agentuse-runtime' } } },
      ];
      for (const gate of machineGates) {
        await sessionManager.addPart(sessionID, AGENT_ID, messageID, {
          type: 'tool',
          callID: gate.callID,
          tool: 'await_human',
          state: {
            status: 'completed',
            input: { prompt: 'Draft?', changes: [{ content: 'a draft' }] },
            output: gate.output,
            time: { start: 1, end: 2 },
          },
        } as any);
      }
      await sessionManager.addPart(sessionID, AGENT_ID, messageID, {
        type: 'tool',
        callID: 'human',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Draft?', changes: [{ content: 'a draft' }] },
          output: { status: 'commented', comment: 'do not lecture the author', reviewer: { username: 'leon' } },
          time: { start: 3, end: 4 },
        },
      } as any);

      const { reviews } = await gatherApprovalContext(sessionManager, sessionID, AGENT_ID);

      expect(reviews.map((r) => r.comment)).toEqual(['do not lecture the author']);
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

  it('gathers approvals and comments but excludes machine pre-review bounces', async () => {
    await withSession('agentuse-human-approval-history-', async ({ sessionManager, sessionID, messageID }) => {
      await sessionManager.addPart(sessionID, AGENT_ID, messageID, {
        type: 'tool',
        callID: 'machine',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Draft?', changes: [{ content: 'machine draft' }] },
          output: {
            status: 'rejected',
            source: 'pre-review',
            comment: 'rewrite this',
            reviewer: { username: 'verify-judge' },
          },
          time: { start: 1, end: 2 },
        },
      } as any);
      await sessionManager.addPart(sessionID, AGENT_ID, messageID, {
        type: 'tool',
        callID: 'comment',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Draft?', changes: [{ content: 'revised draft' }] },
          output: {
            status: 'commented',
            comment: 'use the first-party framing',
            reviewer: { username: 'leon' },
          },
          time: { start: 3, end: 4 },
        },
      } as any);
      await sessionManager.addPart(sessionID, AGENT_ID, messageID, {
        type: 'tool',
        callID: 'approve',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: {
            prompt: 'Pick?',
            options: [{ id: 'a', label: 'A' }, { id: 'b', label: 'B' }],
            changes: [{ content: 'final B', optionId: 'b' }],
          },
          output: {
            status: 'approved',
            choice: 'b',
            reviewer: { username: 'leon' },
          },
          time: { start: 5, end: 6 },
        },
      } as any);

      const history = await gatherHumanApprovalHistory(sessionManager, sessionID, AGENT_ID);
      expect(history).toHaveLength(2);
      expect(history.map((decision) => decision.status)).toEqual(['commented', 'approved']);
      expect(history[0].comment).toBe('use the first-party framing');
      expect(history[1].choice).toBe('b');
      expect(history[1].work).toContain('choice: B [b]');
      expect(JSON.stringify(history)).not.toContain('rewrite this');
    });
  });
});
