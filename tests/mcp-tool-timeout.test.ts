import { describe, expect, test } from 'bun:test';
import { z } from 'zod';
import { getMCPTools, ToolOutcomeUnknownError, type MCPConnection } from '../src/mcp';
import { ToolDispatcher } from '../src/runner/tool-dispatcher';

/** An MCP tool that performs its effect after `delayMs` unless its signal aborts first. */
function delayedEffectConnection(delayMs: number, toolTimeout: number) {
  const state = { effects: 0, signal: undefined as AbortSignal | undefined };
  const connection = {
    name: 'late-effect',
    config: { command: 'unused-fixture', toolTimeout },
    client: {
      tools: async () => ({
        publish: {
          description: 'Delayed effect fixture',
          inputSchema: z.object({}),
          execute: async (_input: unknown, options: { abortSignal?: AbortSignal }) => {
            state.signal = options.abortSignal;
            await new Promise<void>((resolve, reject) => {
              const timer = setTimeout(resolve, delayMs);
              options.abortSignal?.addEventListener('abort', () => {
                clearTimeout(timer);
                reject(options.abortSignal?.reason);
              }, { once: true });
            });
            state.effects++;
            return { content: [{ type: 'text', text: 'published' }] };
          },
        },
      }),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
    },
  } as unknown as MCPConnection;
  return { connection, state };
}

describe('MCP tool timeout', () => {
  test('aborts the timed-out call and reports its outcome as unknown, not as a safe failure', async () => {
    const { connection, state } = delayedEffectConnection(60, 0.01);
    const tools = await getMCPTools([connection]);
    const events: Array<{ event: string; error?: string }> = [];
    const dispatcher = new ToolDispatcher(tools, { effectWal: { append: (event: any) => events.push(event) } as any });
    const run = new AbortController();

    const failure = await dispatcher
      .dispatch('mcp__late-effect__publish', {}, { abortSignal: run.signal, toolCallId: 'late-effect' })
      .then(() => undefined, (error: unknown) => error as Error);
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(failure?.message).toContain('outcome is unknown');
    expect(failure?.message).toContain('before retrying');
    expect(state.signal?.aborted).toBe(true);
    expect(run.signal.aborted).toBe(false);
    // A cancellation-aware (in-process/HTTP) tool stops; nothing lands late.
    expect(state.effects).toBe(0);
    expect(events.find((event) => event.event === 'tool-error')?.error).toContain('outcome is unknown');
  });

  test('throws a ToolOutcomeUnknownError from the wrapped execute on the deadline', async () => {
    const { connection } = delayedEffectConnection(60, 0.01);
    const tools = await getMCPTools([connection]);
    const execute = tools['mcp__late-effect__publish']!.execute!;
    const error = await Promise.resolve(execute({}, { toolCallId: 'x', messages: [], context: {}, abortSignal: new AbortController().signal }))
      .then(() => undefined, (failure: unknown) => failure);
    expect(error).toBeInstanceOf(ToolOutcomeUnknownError);
  });

  test('a run abort keeps its own reason instead of the unknown-outcome error', async () => {
    const { connection, state } = delayedEffectConnection(1_000, 30);
    const tools = await getMCPTools([connection]);
    const execute = tools['mcp__late-effect__publish']!.execute!;
    const run = new AbortController();
    const pending = Promise.resolve(execute({}, { toolCallId: 'x', messages: [], context: {}, abortSignal: run.signal }))
      .then(() => undefined, (failure: unknown) => failure);
    await new Promise((resolve) => setTimeout(resolve, 10));
    const reason = new Error('run cancelled');
    run.abort(reason);
    expect(await pending).toBe(reason);
    expect(state.signal?.aborted).toBe(true);
  });
});
