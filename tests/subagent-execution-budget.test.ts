import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runner from '../src/runner';
import { createSubAgentTool } from '../src/subagent';
import { ExecutionBudget, executionBudgetFor } from '../src/runner/execution-budget';

async function withChild(run: (path: string, root: string) => Promise<void>, timeoutLine = 'timeout: 1\n') {
  const root = await mkdtemp(join(tmpdir(), 'agentuse-budget-child-'));
  const path = join(root, 'child.agentuse');
  await writeFile(path, `---\nname: Child\nmodel: openai:gpt-5.6-luna\n${timeoutLine}skills:\n  auto: false\n---\nCheck one claim.\n`);
  try { await run(path, root); } finally { await rm(root, { recursive: true, force: true }); }
}

describe('delegated deadline wiring', () => {
  it('returns a timed-out child outcome to a still-running parent', async () => withChild(async (path, root) => {
    const parent = new ExecutionBudget(10_000);
    const core = spyOn(runner, 'executeAgentCore').mockImplementation((async function* (_agent: unknown, _tools: unknown, options: any) {
      const signal = options.abortSignal as AbortSignal;
      if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw signal.reason;
      yield;
    }) as any);
    try {
      const child = await createSubAgentTool(path, undefined, root, undefined, 0, [], undefined, undefined, undefined, undefined, parent.signal);
      const result = await (child.execute as any)({}, { toolCallId: 'child', messages: [] });
      expect(result.output).toContain('timed out');
      expect(parent.signal.aborted).toBe(false);
    } finally { core.mockRestore(); await parent.finish(); }
  }));
  it('inherits the parent budget when the child declares no timeout of its own', async () => withChild(async (path, root) => {
    // A 1-hour parent: a child with no `timeout:` must not fall back to the
    // 300s default and die with 55 minutes still on the parent's clock.
    const parent = new ExecutionBudget(3_600_000);
    let childRemaining = 0;
    const core = spyOn(runner, 'executeAgentCore').mockImplementation((async function* (_agent: unknown, _tools: unknown, options: any) {
      childRemaining = executionBudgetFor(options.abortSignal)?.remainingMs ?? 0;
      yield { type: 'finish' } as any;
    }) as any);
    try {
      const child = await createSubAgentTool(path, undefined, root, undefined, 0, [], undefined, undefined, undefined, undefined, parent.signal);
      await (child.execute as any)({}, { toolCallId: 'child', messages: [] });
      expect(childRemaining).toBeGreaterThan(300_000);
    } finally { core.mockRestore(); await parent.finish(); }
  }, ''));
  it('propagates parent cancellation rather than treating it as recoverable child failure', async () => withChild(async (path, root) => {
    const parent = new ExecutionBudget(10_000);
    const reason = new Error('operator stopped parent');
    const core = spyOn(runner, 'executeAgentCore').mockImplementation((async function* (_agent: unknown, _tools: unknown, options: any) {
      parent.controller.abort(reason);
      throw options.abortSignal.reason;
      yield;
    }) as any);
    try {
      const child = await createSubAgentTool(path, undefined, root, undefined, 0, [], undefined, undefined, undefined, undefined, parent.signal);
      await expect((child.execute as any)({}, { toolCallId: 'child', messages: [] })).rejects.toThrow('operator stopped parent');
    } finally { core.mockRestore(); await parent.finish(); }
  }));
});
