import { describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import {
  codeModeEligibleToolNames,
  createCodeExecTool,
  executeCodeMode,
  isCodeModeEnabled,
} from '../src/runner/code-mode';
import { ToolDispatcher, ToolDispatchDeniedError } from '../src/runner/tool-dispatcher';
import { EffectWAL } from '../src/runner/effect-wal';

describe('Code Mode', () => {
  it('is default-on and can be disabled only by runtime policy', () => {
    const previous = process.env.AGENTUSE_CODE_MODE;
    try {
      delete process.env.AGENTUSE_CODE_MODE;
      expect(isCodeModeEnabled()).toBe(true);

      process.env.AGENTUSE_CODE_MODE = '1';
      expect(isCodeModeEnabled()).toBe(true);

      process.env.AGENTUSE_CODE_MODE = '0';
      expect(isCodeModeEnabled()).toBe(false);
    } finally {
      if (previous === undefined) delete process.env.AGENTUSE_CODE_MODE;
      else process.env.AGENTUSE_CODE_MODE = previous;
    }
  });

  it('runs TypeScript and composes permitted tools', async () => {
    const calls: Array<{ name: string; input: unknown }> = [];
    const dispatcher = {
      async dispatch(name: string, input: unknown) {
        calls.push({ name, input });
        return { value: (input as { value: number }).value * 2 };
      },
    };

    const output = await executeCodeMode(`
      const values: number[] = [1, 2, 3];
      const rows = [];
      for (const value of values) rows.push(await tools.double({ value }));
      return { total: rows.reduce((sum, row) => sum + row.value, 0) };
    `, {
      dispatcher,
      toolNames: ['double'],
      parentCallId: 'parent',
    });

    expect(output).toEqual({ total: 12 });
    expect(calls).toEqual([
      { name: 'double', input: { value: 1 } },
      { name: 'double', input: { value: 2 } },
      { name: 'double', input: { value: 3 } },
    ]);
  });

  it('allows bounded parallel nested calls', async () => {
    let active = 0;
    let maxActive = 0;
    const dispatcher = {
      async dispatch(_name: string, input: unknown) {
        active++;
        maxActive = Math.max(maxActive, active);
        await new Promise(resolve => setTimeout(resolve, 10));
        active--;
        return input;
      },
    };
    const output = await executeCodeMode(`
      return Promise.all([1, 2, 3].map(value => tools.echo({ value })));
    `, {
      dispatcher,
      toolNames: ['echo'],
      parentCallId: 'parallel',
    });

    expect(output).toEqual([{ value: 1 }, { value: 2 }, { value: 3 }]);
    expect(maxActive).toBe(3);
  });

  it('does not expose host filesystem, network, process, or module globals', async () => {
    const output = await executeCodeMode(`
      return {
        process: typeof process,
        require: typeof require,
        fetch: typeof fetch,
        buffer: typeof Buffer,
      };
    `, {
      dispatcher: { dispatch: async () => null },
      toolNames: [],
      parentCallId: 'isolation',
    });

    expect(output).toEqual({
      process: 'undefined',
      require: 'undefined',
      fetch: 'undefined',
      buffer: 'undefined',
    });
  });

  it('interrupts runaway guest computation', async () => {
    await expect(executeCodeMode('while (true) {}', {
      dispatcher: { dispatch: async () => null },
      toolNames: [],
      parentCallId: 'timeout',
      limits: { timeoutMs: 25 },
    })).rejects.toThrow(/timed out|interrupted/i);
  });

  it('keeps suspending and recursive tools direct-only', () => {
    expect(codeModeEligibleToolNames([
      'store_list',
      'await_human',
      'tools__bash',
      'code_exec',
      'subagent__worker',
      'submit_agent_revision',
      'submit_changes',
      'report_complete',
    ])).toEqual(['store_list']);
  });

  it('fails closed for static and dynamic imports', async () => {
    const options = {
      dispatcher: { dispatch: async () => null },
      toolNames: [],
      parentCallId: 'imports',
    };
    await expect(executeCodeMode(`
      import fs from 'fs';
      return fs;
    `, options)).rejects.toThrow(/import|unexpected/i);
    await expect(executeCodeMode(`
      return import('fs');
    `, options)).rejects.toThrow(/module|import|load/i);
  });

  it('enforces nested result, call-count, and concurrency limits', async () => {
    await expect(executeCodeMode(`return tools.large({});`, {
      dispatcher: { dispatch: async () => 'too large' },
      toolNames: ['large'],
      parentCallId: 'result-limit',
      limits: { resultCharsPerCall: 4 },
    })).rejects.toThrow(/per-call Code Mode size limit/i);

    await expect(executeCodeMode(`
      for (let i = 0; i < 3; i++) await tools.echo({ i });
      return true;
    `, {
      dispatcher: { dispatch: async (_name, input) => input },
      toolNames: ['echo'],
      parentCallId: 'call-limit',
      limits: { nestedCalls: 2 },
    })).rejects.toThrow(/nested-call limit/i);

    await expect(executeCodeMode(`
      return Promise.all([tools.wait({ i: 1 }), tools.wait({ i: 2 })]);
    `, {
      dispatcher: { dispatch: async (_name, input) => {
        await new Promise(resolve => setTimeout(resolve, 10));
        return input;
      } },
      toolNames: ['wait'],
      parentCallId: 'concurrency-limit',
      limits: { concurrency: 1 },
    })).rejects.toThrow(/concurrency limit/i);
  });

  it('keeps approval-required tools direct-only', () => {
    const dispatcher = new ToolDispatcher({
      safe: { description: 'Safe', inputSchema: z.object({}), execute: async () => null },
      reviewed: {
        description: 'Needs approval',
        inputSchema: z.object({}),
        needsApproval: true,
        execute: async () => null,
      },
      conditional: {
        description: 'May need approval',
        inputSchema: z.object({}),
        needsApproval: async () => true,
        execute: async () => null,
      },
    });
    expect(dispatcher.codeModeToolNames()).toEqual(['safe']);
  });

  it('rejects binary media at the JSON bridge', async () => {
    await expect(executeCodeMode(`return tools.read_image({});`, {
      dispatcher: {
        dispatch: async () => ({
          content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
        }),
      },
      toolNames: ['read_image'],
      parentCallId: 'media',
    })).rejects.toThrow(/binary media.*directly/i);
  });

  it('releases the guest heap when a nested tool ignores cancellation', async () => {
    const startedAt = Date.now();
    await expect(executeCodeMode(`return tools.stuck({});`, {
      dispatcher: { dispatch: async () => new Promise(() => {}) },
      toolNames: ['stuck'],
      parentCallId: 'stuck',
      limits: { timeoutMs: 20 },
    })).rejects.toThrow(/timed out/i);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('journals the outer execution and each nested tool call', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentuse-code-wal-'));
    try {
      const wal = new EffectWAL(dir);
      const dispatcher = new ToolDispatcher({
        add: {
          description: 'Add one',
          inputSchema: z.object({ value: z.number() }),
          execute: async ({ value }: { value: number }) => ({ value: value + 1 }),
        },
      }, { effectWal: wal });
      dispatcher.register('code_exec', createCodeExecTool({
        dispatcher,
        toolNames: dispatcher.names(),
      }));

      await dispatcher.dispatch('code_exec', {
        code: 'return tools.add({ value: 1 });',
      }, { toolCallId: 'outer' });

      const records = (await readFile(wal.filePath!, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line));
      expect(records).toEqual(expect.arrayContaining([
        expect.objectContaining({ event: 'tool-start', callId: 'outer', tool: 'code_exec' }),
        expect.objectContaining({ event: 'tool-end', callId: 'outer', tool: 'code_exec' }),
        expect.objectContaining({ event: 'tool-start', callId: 'outer:nested:1', tool: 'add' }),
        expect.objectContaining({ event: 'tool-end', callId: 'outer:nested:1', tool: 'add' }),
      ]));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is exposed by default and documents the resolved nested catalog', () => {
    const tool = createCodeExecTool({
      dispatcher: { dispatch: async () => null },
      toolNames: ['store_list', 'await_human'],
    });
    expect(tool.description).toContain('Available nested tools: store_list');
    expect(tool.description).not.toContain('Available nested tools: await_human');
  });
});

describe('ToolDispatcher', () => {
  const tools: ToolSet = {
    add: {
      description: 'Add one',
      inputSchema: z.object({ value: z.number() }),
      execute: async ({ value }: { value: number }) => ({ value: value + 1 }),
    },
  };

  it('validates nested tool inputs before execution', async () => {
    const dispatcher = new ToolDispatcher(tools);
    await expect(dispatcher.dispatch('add', { value: '1' }, {
      toolCallId: 'invalid',
    })).rejects.toThrow(/Invalid input/);
  });

  it('applies plugin preflight and result hooks to nested calls', async () => {
    const events: string[] = [];
    const dispatcher = new ToolDispatcher(tools, {
      pluginEvents: {
        async toolCall(event) {
          events.push(`call:${event.toolName}`);
          event.input.value = 4;
          return {};
        },
        async toolResult(event) {
          events.push(`result:${event.toolName}`);
          return { ...event, output: { value: 99 }, isError: false };
        },
      },
    });
    const output = await dispatcher.dispatch('add', { value: 1 }, { toolCallId: 'hooked' });
    expect(output).toEqual({ value: 99 });
    expect(events).toEqual(['call:add', 'result:add']);
  });

  it('fails closed when a plugin blocks a nested call', async () => {
    const dispatcher = new ToolDispatcher(tools, {
      pluginEvents: {
        async toolCall() { return { block: true, reason: 'policy says no' }; },
      },
    });
    await expect(dispatcher.dispatch('add', { value: 1 }, {
      toolCallId: 'blocked',
    })).rejects.toBeInstanceOf(ToolDispatchDeniedError);
  });
});
