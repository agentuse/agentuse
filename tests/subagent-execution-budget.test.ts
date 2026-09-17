import { describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as runner from '../src/runner';
import { createSubAgentTool } from '../src/subagent';
import { ExecutionBudget } from '../src/runner/execution-budget';

async function withChild(run: (path: string, root: string) => Promise<void>) {
  const root = await mkdtemp(join(tmpdir(), 'agentuse-budget-child-'));
  const path = join(root, 'child.agentuse');
  await writeFile(path, '---\nname: Child\nmodel: openai:gpt-5.6-luna\ntimeout: 1\nskills:\n  auto: false\n---\nCheck one claim.\n');
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
