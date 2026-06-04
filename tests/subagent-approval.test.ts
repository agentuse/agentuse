import { describe, it, expect } from 'bun:test';
import { resolve } from 'path';
import {
  createSubAgentTool,
  createSubAgentTools,
  SubAgentApprovalUnsupportedError,
} from '../src/subagent';
import { parseAgent } from '../src/parser';
import { isApprovalEnabled } from '../src/runner/approval';
import { createAwaitHumanTool } from '../src/tools/await-human';
import { isSuspendSignal } from '../src/runner/suspend';

const fixtures = resolve(__dirname, '__fixtures__/approval');

describe('approval gate in delegated sub-agents (fail loud)', () => {
  async function expectRejectsWithApprovalError(promise: Promise<unknown>): Promise<void> {
    let caught: unknown;
    try {
      await promise;
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(SubAgentApprovalUnsupportedError);
  }

  it('rejects a sub-agent with approval: true at load time', async () => {
    const path = resolve(fixtures, 'sub-approval-bool.agentuse');
    await expectRejectsWithApprovalError(createSubAgentTool(path, 50, fixtures));
  });

  it('rejects a sub-agent with an approval object (timeout) at load time', async () => {
    const path = resolve(fixtures, 'sub-approval-object.agentuse');
    await expectRejectsWithApprovalError(createSubAgentTool(path, 50, fixtures));
  });

  it('produces a clear error message naming the offending sub-agent', async () => {
    const path = resolve(fixtures, 'sub-approval-bool.agentuse');
    try {
      await createSubAgentTool(path, 50, fixtures);
      throw new Error('expected SubAgentApprovalUnsupportedError');
    } catch (err) {
      expect(err).toBeInstanceOf(SubAgentApprovalUnsupportedError);
      const message = (err as Error).message;
      expect(message).toContain('sub-approval-bool');
      expect(message).toContain('approval');
      expect(message).toContain('top-level');
    }
  });

  it('propagates the error through createSubAgentTools instead of swallowing it', async () => {
    // The manager delegates to an approval-enabled sub-agent. The plural loader
    // normally logs-and-continues on per-subagent failures; the approval error
    // must abort the whole load so the manager never runs with a missing tool.
    await expectRejectsWithApprovalError(
      createSubAgentTools(
        [{ path: './sub-approval-bool.agentuse', name: 'approver' }],
        fixtures
      )
    );
  });

  it('does not register a phantom pending approval (guard fires before execute)', async () => {
    // createSubAgentTool rejects before returning a tool, so its `execute` (the
    // only place a session/pending approval is created) never runs. The orphaned
    // "pending" row from the original bug is therefore impossible on this path.
    let tool: unknown;
    try {
      tool = await createSubAgentTool(
        resolve(fixtures, 'sub-approval-bool.agentuse'),
        50,
        fixtures
      );
    } catch {
      tool = undefined;
    }
    expect(tool).toBeUndefined();
  });

  it('does not over-fire: a plain sub-agent with no approval still loads', async () => {
    const path = resolve(fixtures, 'sub-plain.agentuse');
    const tool = await createSubAgentTool(path, 50, fixtures);
    expect(tool).toBeDefined();
    expect(typeof tool.execute).toBe('function');
  });
});

describe('top-level approval gate still works (unchanged)', () => {
  it('recognizes approval on the top-level agent config', async () => {
    const agent = await parseAgent(resolve(fixtures, 'sub-approval-bool.agentuse'));
    expect(isApprovalEnabled(agent.config)).toBe(true);
  });

  it('suspends the run via SuspendSignal when await_human is called at top level', async () => {
    // This is the mechanism that suspends a top-level session: the await_human
    // tool throws a SuspendSignal, which executeAgentCore -> processAgentStream ->
    // runAgent turn into a suspended, resumable session. (The subagent path can
    // never reach this, since it is rejected at load above.)
    const tool = createAwaitHumanTool('session-top', { projectRoot: '/tmp/project-a' });
    try {
      await tool.execute?.({ prompt: 'Approve this?' } as any, {} as any);
      throw new Error('expected suspend signal');
    } catch (err) {
      expect(isSuspendSignal(err)).toBe(true);
    }
  });
});
