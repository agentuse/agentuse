import { describe, expect, it, mock } from 'bun:test';
import { mkdtemp, readFile, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { z } from 'zod';
import type { ToolSet } from 'ai';
import {
  CodeModeRunBudget,
  DEFAULT_CODE_MODE_LIMITS,
  codeModeEligibleToolNames,
  createCodeExecTool,
  executeCodeMode,
  isCodeModeEnabled,
} from '../src/runner/code-mode';
import { ToolDispatcher, ToolDispatchDeniedError } from '../src/runner/tool-dispatcher';
import { EffectWAL } from '../src/runner/effect-wal';
import { trustedOutputTool } from '../src/tools/tool-contract';
import { buildCodeModeToolContracts, codeModeDeclarations } from '../src/runner/code-mode-contracts';
import { Store } from '../src/store/store';
import { createStoreTools } from '../src/store/tools';
import { extractToolIntent, injectIntentParam } from '../src/runner/tool-intent';

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
      toolDefinitions: {
        double: trustedOutputTool({
          inputSchema: z.object({ value: z.number() }),
          outputSchema: z.object({ value: z.number() }),
          execute: async () => ({ value: 0 }),
        }),
      },
      parentCallId: 'parent',
    });

    expect(output).toEqual({ total: 12 });
    expect(calls).toEqual([
      { name: 'double', input: { value: 1 } },
      { name: 'double', input: { value: 2 } },
      { name: 'double', input: { value: 3 } },
    ]);
  });

  it('preserves ES2022 syntax while routing async work through tracked promises', async () => {
    await expect(executeCodeMode(`
      const value = 123n;
      await Promise.resolve();
      return Number(value);
    `, {
      dispatcher: { dispatch: async () => null },
      toolNames: [],
      parentCallId: 'es2022-syntax',
    })).resolves.toBe(123);
  });

  it('preserves Promise subclass fields, static constructors, and species', async () => {
    await expect(executeCodeMode(`
      class Derived<T> extends Promise<T> { marker = 'derived'; }
      class Alternate<T> extends Promise<T> { marker = 'alternate'; }
      class Source<T> extends Promise<T> {
        static get [Symbol.species]() { return Alternate; }
      }
      const resolved = Derived.resolve(2);
      const chained = resolved.then(value => value + 1);
      const combined = Derived.all([resolved]);
      const species = Source.resolve(4).then(value => value + 1);
      return {
        resolveSubclass: resolved instanceof Derived,
        resolveField: (resolved as Derived<number>).marker,
        thenSubclass: chained instanceof Derived,
        thenField: (chained as Derived<number>).marker,
        allSubclass: combined instanceof Derived,
        speciesSubclass: species instanceof Alternate,
        speciesField: (species as Alternate<number>).marker,
        values: [await chained, (await combined)[0], await species],
      };
    `, {
      dispatcher: { dispatch: async () => null },
      toolNames: [],
      parentCallId: 'promise-subclass',
    })).resolves.toEqual({
      resolveSubclass: true,
      resolveField: 'derived',
      thenSubclass: true,
      thenField: 'derived',
      allSubclass: true,
      speciesSubclass: true,
      speciesField: 'alternate',
      values: [3, 2, 5],
    });
  });

  it('adopts finally results through a species constructor without reading its static resolve', async () => {
    await expect(executeCodeMode(`
      class FinalSpecies<T> extends Promise<T> { marker = 'final-species'; }
      class Source<T> extends Promise<T> {
        static get [Symbol.species]() { return FinalSpecies; }
      }
      Object.defineProperty(FinalSpecies, 'resolve', { value: undefined });
      const settled = Source.resolve(7).finally(() => Promise.resolve('cleanup'));
      return {
        speciesSubclass: settled instanceof FinalSpecies,
        speciesField: (settled as FinalSpecies<number>).marker,
        value: await settled,
      };
    `, {
      dispatcher: { dispatch: async () => null },
      toolNames: [],
      parentCallId: 'finally-species',
    })).resolves.toEqual({
      speciesSubclass: true,
      speciesField: 'final-species',
      value: 7,
    });
  });

  it('disables eval and Function constructor aliases', async () => {
    const programs = [
      'return eval("1 + 1");',
      'return Function("return 2")();',
      'return (() => {}).constructor("return 3")();',
    ];
    for (const code of programs) {
      await expect(executeCodeMode(code, {
        dispatcher: { dispatch: async () => null },
        toolNames: [],
        parentCallId: 'dynamic-code',
      })).rejects.toThrow(/Dynamic code construction is unavailable in Code Mode/i);
    }
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
      typecheck: false,
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
    let markStarted: (() => void) | undefined;
    const nestedStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const runBudget = new CodeModeRunBudget({ ...DEFAULT_CODE_MODE_LIMITS, timeoutMs: 100 });
    const startedAt = Date.now();
    const execution = executeCodeMode(`return tools.stuck({});`, {
      dispatcher: { dispatch: async () => { markStarted!(); return new Promise(() => {}); } },
      toolNames: ['stuck'],
      parentCallId: 'stuck',
      typecheck: false,
      runBudget,
      limits: { timeoutMs: 100 },
    });
    await nestedStarted;
    await expect(execution).rejects.toThrow(/Code Mode timed out after 100ms/i);
    expect(Date.now() - startedAt).toBeLessThan(500);
    await expect(executeCodeMode('return 42;', {
      dispatcher: { dispatch: async () => null },
      toolNames: [],
      parentCallId: 'after-stuck',
      typecheck: false,
      runBudget,
      limits: { timeoutMs: 200 },
    })).resolves.toBe(42);
  });

  it('drains nested calls started by floating guest continuations', async () => {
    let releaseFirst: (() => void) | undefined;
    let releaseSecond: (() => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    let markSecondStarted: (() => void) | undefined;
    const firstRelease = new Promise<void>(resolve => { releaseFirst = resolve; });
    const secondRelease = new Promise<void>(resolve => { releaseSecond = resolve; });
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const secondStarted = new Promise<void>(resolve => { markSecondStarted = resolve; });
    let completed = false;
    const execution = executeCodeMode(`
      void (async () => {
        await tools.first({});
        await tools.second({});
      })();
      return "program result";
    `, {
      dispatcher: {
        dispatch: async (name: string) => {
          if (name === 'first') {
            markFirstStarted!();
            await firstRelease;
          } else {
            markSecondStarted!();
            await secondRelease;
          }
          return { name };
        },
      },
      toolNames: ['first', 'second'],
      parentCallId: 'floating-continuation',
      typecheck: false,
      limits: { timeoutMs: 1_000 },
    });
    void execution.then(() => { completed = true; });
    await firstStarted;
    releaseFirst!();
    await secondStarted;
    await new Promise(resolve => setTimeout(resolve, 10));
    expect(completed).toBe(false);
    releaseSecond!();
    await expect(execution).resolves.toBe('program result');
  });

  it('returns cancellation and the effect ledger after the guest result settles', async () => {
    const controller = new AbortController();
    let releaseDispatch: (() => void) | undefined;
    let markStarted: (() => void) | undefined;
    const dispatchRelease = new Promise<void>(resolve => { releaseDispatch = resolve; });
    const nestedStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const execution = executeCodeMode(`
      void tools.slow_write({ id: "floating-write" });
      return "program result";
    `, {
      dispatcher: {
        dispatch: async () => {
          markStarted!();
          await dispatchRelease;
          return { committed: true };
        },
      },
      toolNames: ['slow_write'],
      parentCallId: 'cancel-after-result',
      abortSignal: controller.signal,
      typecheck: false,
      limits: { timeoutMs: 1_000 },
    });
    await nestedStarted;
    controller.abort(new Error('cancel after guest result'));
    let message = '';
    try {
      await execution;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('cancel after guest result');
    expect(message).toMatch(/Completed nested calls before failure.*floating-write/i);
    expect(message).toContain('completion unknown, verify before retry');
    releaseDispatch!();
  });

  it('records an unavailable completed effect when binary inspection throws', async () => {
    const hostileResult = new Proxy({}, {
      get(_target, property) {
        // Promise resolution reads `then` while adopting returned values.
        if (property === 'then') return undefined;
        throw new Error('hostile result getter');
      },
    });
    let message = '';
    try {
      await executeCodeMode('return tools.hostile({ id: "written" });', {
        dispatcher: { dispatch: async () => hostileResult },
        toolNames: ['hostile'],
        parentCallId: 'hostile-result',
        typecheck: false,
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('could not be inspected for binary media');
    expect(message).toContain('hostile result getter');
    expect(message).toMatch(/Completed nested calls before failure.*written/i);
    expect(message).toContain('[unavailable:');
  });

  it('retains a nested-call lease until an aborted dispatcher actually settles', async () => {
    const controller = new AbortController();
    const runBudget = new CodeModeRunBudget({ ...DEFAULT_CODE_MODE_LIMITS, concurrency: 1 });
    let releaseFirst: ((value: unknown) => void) | undefined;
    let markFirstStarted: (() => void) | undefined;
    const firstStarted = new Promise<void>(resolve => { markFirstStarted = resolve; });
    const firstDispatch = new Promise<unknown>(resolve => { releaseFirst = resolve; });
    const dispatcher = {
      dispatch: async (name: string) => {
        if (name === 'first') {
          markFirstStarted!();
          return firstDispatch;
        }
        return { name };
      },
    };
    const firstExecution = executeCodeMode('return tools.first({});', {
      dispatcher,
      toolNames: ['first'],
      parentCallId: 'lease-first',
      abortSignal: controller.signal,
      typecheck: false,
      runBudget,
      limits: { timeoutMs: 1_000 },
    });
    await firstStarted;
    controller.abort(new Error('cancel first dispatcher'));
    await expect(firstExecution).rejects.toThrow(/cancel first dispatcher/i);

    await expect(executeCodeMode('return tools.second({});', {
      dispatcher,
      toolNames: ['second'],
      parentCallId: 'lease-second',
      typecheck: false,
      runBudget,
      limits: { timeoutMs: 500 },
    })).rejects.toThrow(/1-call concurrency limit/i);

    releaseFirst!({ committed: true });
    await Promise.resolve();
    await expect(executeCodeMode('return tools.third({});', {
      dispatcher,
      toolNames: ['third'],
      parentCallId: 'lease-third',
      typecheck: false,
      runBudget,
      limits: { timeoutMs: 500 },
    })).resolves.toEqual({ name: 'third' });
  });

  it('bounds an aborted start hook and releases its pre-dispatch lease', async () => {
    const controller = new AbortController();
    const runBudget = new CodeModeRunBudget({ ...DEFAULT_CODE_MODE_LIMITS, concurrency: 1 });
    let markHookStarted: (() => void) | undefined;
    const hookStarted = new Promise<void>(resolve => { markHookStarted = resolve; });
    const execution = executeCodeMode('return tools.write({});', {
      dispatcher: { dispatch: async () => ({ committed: true }) },
      toolNames: ['write'],
      parentCallId: 'hanging-start-hook',
      abortSignal: controller.signal,
      typecheck: false,
      runBudget,
      limits: { timeoutMs: 1_000 },
      onNestedToolStart: async () => {
        markHookStarted!();
        await new Promise(() => {});
      },
    });
    await hookStarted;
    controller.abort(new Error('cancel hanging start hook'));
    await expect(execution).rejects.toThrow(/cancel hanging start hook/i);
    await expect(executeCodeMode('return tools.next({});', {
      dispatcher: { dispatch: async () => ({ available: true }) },
      toolNames: ['next'],
      parentCallId: 'after-hanging-start-hook',
      typecheck: false,
      runBudget,
      limits: { timeoutMs: 500 },
    })).resolves.toEqual({ available: true });
  });

  it('bounds an aborted finish hook after releasing the dispatcher lease', async () => {
    const controller = new AbortController();
    const runBudget = new CodeModeRunBudget({ ...DEFAULT_CODE_MODE_LIMITS, concurrency: 1 });
    let markHookStarted: (() => void) | undefined;
    const hookStarted = new Promise<void>(resolve => { markHookStarted = resolve; });
    const execution = executeCodeMode('return tools.write({});', {
      dispatcher: { dispatch: async () => ({ committed: true }) },
      toolNames: ['write'],
      parentCallId: 'hanging-finish-hook',
      abortSignal: controller.signal,
      typecheck: false,
      runBudget,
      limits: { timeoutMs: 1_000 },
      onNestedToolFinish: async () => {
        markHookStarted!();
        await new Promise(() => {});
      },
    });
    await hookStarted;
    controller.abort(new Error('cancel hanging finish hook'));
    await expect(execution).rejects.toThrow(/cancel hanging finish hook/i);
    await expect(executeCodeMode('return tools.next({});', {
      dispatcher: { dispatch: async () => ({ available: true }) },
      toolNames: ['next'],
      parentCallId: 'after-hanging-finish-hook',
      typecheck: false,
      runBudget,
      limits: { timeoutMs: 500 },
    })).resolves.toEqual({ available: true });
  });

  it('marks completion unknown when a cancelled dispatch remains pending past cleanup', async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    let markCommitted: (() => void) | undefined;
    const nestedStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const committed = new Promise<void>(resolve => { markCommitted = resolve; });
    let didCommit = false;
    let serializations = 0;
    const execution = executeCodeMode('return tools.slow_write({ id: "late-commit" });', {
      dispatcher: {
        dispatch: async () => {
          markStarted!();
          await new Promise(resolve => setTimeout(resolve, 250));
          didCommit = true;
          markCommitted!();
          return {
            toJSON() {
              serializations++;
              return { committed: true };
            },
          };
        },
      },
      toolNames: ['slow_write'],
      parentCallId: 'late-commit',
      abortSignal: controller.signal,
      typecheck: false,
      limits: { timeoutMs: 1_000 },
    });
    await nestedStarted;
    controller.abort(new Error('cancel slow write'));
    let message = '';
    try {
      await execution;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('cancel slow write');
    expect(message).toMatch(/Completed nested calls before failure.*late-commit/i);
    expect(message).toContain('completion unknown, verify before retry');
    expect(didCommit).toBe(false);
    await committed;
    await Promise.resolve();
    expect(didCommit).toBe(true);
    expect(serializations).toBe(0);
  });

  it('records a dispatch that completes during bounded cancellation cleanup', async () => {
    const controller = new AbortController();
    let markStarted: (() => void) | undefined;
    const nestedStarted = new Promise<void>(resolve => { markStarted = resolve; });
    const execution = executeCodeMode('return tools.slow_write({ id: "cleanup-commit" });', {
      dispatcher: {
        dispatch: async () => {
          markStarted!();
          await new Promise(resolve => setTimeout(resolve, 30));
          return { committed: true };
        },
      },
      toolNames: ['slow_write'],
      parentCallId: 'cleanup-commit',
      abortSignal: controller.signal,
      typecheck: false,
      limits: { timeoutMs: 1_000 },
    });
    await nestedStarted;
    controller.abort(new Error('cancel during write'));
    let message = '';
    try {
      await execution;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('cancel during write');
    expect(message).toMatch(/Completed nested calls before failure.*cleanup-commit/i);
    expect(message).toContain('\\"committed\\":true');
    expect(message).not.toContain('completion unknown');
  });

  it('preserves completed effects when a result hook hangs until timeout', async () => {
    const execute = mock(async () => ({ committed: true }));
    let markHookStarted: (() => void) | undefined;
    const hookStarted = new Promise<void>(resolve => { markHookStarted = resolve; });
    const dispatcher = new ToolDispatcher({
      write: trustedOutputTool({
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ committed: z.boolean() }),
        execute,
      }),
    }, {
      pluginEvents: {
        async toolResult() {
          markHookStarted!();
          return await new Promise(() => {});
        },
      },
    });
    const execution = executeCodeMode('return tools.write({ id: "hook-committed" });', {
      dispatcher,
      toolNames: ['write'],
      parentCallId: 'hanging-result-hook',
      typecheck: false,
      limits: { timeoutMs: 20 },
    });
    await hookStarted;
    let message = '';
    try {
      await execution;
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(message).toMatch(/Code Mode timed out after 20ms/i);
    expect(message).toMatch(/Completed nested calls before failure.*hook-committed/i);
  });

  it('fails when a floating nested call fails', async () => {
    await expect(executeCodeMode(`
      tools.fail({ effect: "none" });
      return "program result";
    `, {
      dispatcher: { dispatch: async () => { throw new Error('nested failure'); } },
      toolNames: ['fail'],
      parentCallId: 'floating-failure',
    })).rejects.toThrow(/unhandled nested tool failures.*nested failure/i);
  });

  it('allows guest code to catch a nested failure and return a fallback', async () => {
    await expect(executeCodeMode(`
      try {
        await tools.fail({});
      } catch {
        return { fallback: true };
      }
    `, {
      dispatcher: { dispatch: async () => { throw new Error('expected failure'); } },
      toolNames: ['fail'],
      parentCallId: 'caught-failure',
    })).resolves.toEqual({ fallback: true });
  });

  it('allows a delayed catch after another awaited operation', async () => {
    await expect(executeCodeMode(`
      const rejected = tools.fail({});
      await tools.wait({});
      return rejected.catch(() => ({ fallback: true }));
    `, {
      dispatcher: {
        dispatch: async (name: string) => {
          if (name === 'fail') throw new Error('expected failure');
          await new Promise(resolve => setTimeout(resolve, 15));
          return { waited: true };
        },
      },
      toolNames: ['fail', 'wait'],
      parentCallId: 'delayed-catch',
    })).resolves.toEqual({ fallback: true });
  });

  it('does not swallow floating rejection chains', async () => {
    const options = {
      dispatcher: { dispatch: async () => { throw new Error('chained failure'); } },
      toolNames: ['fail'],
      parentCallId: 'floating-chain',
    };
    await expect(executeCodeMode('tools.fail({}).then(() => true); return "done";', options))
      .rejects.toThrow(/unhandled nested tool failures.*chained failure/i);
    await expect(executeCodeMode('tools.fail({}).finally(() => {}); return "done";', options))
      .rejects.toThrow(/unhandled nested tool failures.*chained failure/i);
    await expect(executeCodeMode('tools.fail({}).catch(() => { throw new Error("rethrown"); }); return "done";', options))
      .rejects.toThrow(/unhandled nested tool failures.*rethrown/i);
  });

  it('tracks floating failures through native guest promise assimilation', async () => {
    const programs = [
      'Promise.resolve(tools.fail({})); return "done";',
      'Promise.all([tools.fail({})]); return "done";',
      'new Promise(resolve => resolve(tools.fail({}))); return "done";',
      'void (async () => { await tools.fail({}); })(); return "done";',
    ];
    for (const code of programs) {
      await expect(executeCodeMode(code, {
        dispatcher: { dispatch: async () => { throw new Error('assimilated failure'); } },
        toolNames: ['fail'],
        parentCallId: 'assimilated-failure',
      })).rejects.toThrow(/unhandled nested tool failures.*assimilated failure/i);
    }
  });

  it('allows assimilated failures to be awaited and caught', async () => {
    await expect(executeCodeMode(`
      try {
        await Promise.all([Promise.resolve(tools.fail({}))]);
      } catch {
        return { fallback: true };
      }
    `, {
      dispatcher: { dispatch: async () => { throw new Error('expected failure'); } },
      toolNames: ['fail'],
      parentCallId: 'caught-assimilated-failure',
    })).resolves.toEqual({ fallback: true });
  });

  it('applies the deadline while declarations are loading', async () => {
    await expect(executeCodeMode('return true;', {
      dispatcher: { dispatch: async () => null },
      toolNames: [],
      parentCallId: 'declaration-timeout',
      loadDeclarations: async () => {
        await new Promise(resolve => setTimeout(resolve, 40));
        return 'declare const tools: {};';
      },
      limits: { timeoutMs: 10 },
    })).rejects.toThrow(/timed out/i);
  });

  it('interrupts expensive TypeScript preflight work at the deadline', async () => {
    const startedAt = Date.now();
    await expect(executeCodeMode(`
      type Expand<N extends number, A extends unknown[] = []> =
        A['length'] extends N ? A : Expand<N, [...A, unknown]>;
      type TooLarge = Expand<10000>;
      return true;
    `, {
      dispatcher: { dispatch: async () => null },
      toolNames: [],
      parentCallId: 'expensive-preflight',
      limits: { timeoutMs: 20 },
    })).rejects.toThrow(/timed out/i);
    expect(Date.now() - startedAt).toBeLessThan(500);
  });

  it('uses the trusted TypeScript installation when cwd is outside the repository', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentuse-code-mode-cwd-'));
    const originalCwd = process.cwd();
    try {
      process.chdir(dir);
      await expect(executeCodeMode('return 42;', {
        dispatcher: { dispatch: async () => null },
        toolNames: [],
        parentCallId: 'external-cwd',
      })).resolves.toBe(42);
    } finally {
      process.chdir(originalCwd);
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('reports completed effects when a later nested call fails', async () => {
    await expect(executeCodeMode(`
      await tools.write({ id: "already-written" });
      await tools.fail({});
      return "never";
    `, {
      dispatcher: {
        dispatch: async (name: string, input: unknown) => {
          if (name === 'fail') throw new Error('second call failed');
          return { committed: true, input };
        },
      },
      toolNames: ['write', 'fail'],
      parentCallId: 'partial-effects',
    })).rejects.toThrow(/Completed nested calls before failure.*already-written/i);
  });

  it('reports an effect that completed before trusted output validation failed', async () => {
    const execute = mock(async () => ({ committed: false as const }));
    const dispatcher = new ToolDispatcher({
      write: trustedOutputTool({
        inputSchema: z.object({ id: z.string() }),
        outputSchema: z.object({ committed: z.literal(true) }),
        execute,
      }),
    });
    let message = '';
    try {
      await executeCodeMode('return tools.write({ id: "committed-once" });', {
        dispatcher,
        toolNames: ['write'],
        parentCallId: 'post-effect-contract-failure',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(execute).toHaveBeenCalledTimes(1);
    expect(message).toMatch(/does not match its output schema/i);
    expect(message).toMatch(/Completed nested calls before failure.*committed-once/i);
    expect(message).toContain('result unavailable after completed effect');
  });

  it('records an effect before rejecting an unbridgeable result', async () => {
    let serializations = 0;
    let message = '';
    try {
      await executeCodeMode('return tools.read_image({});', {
        dispatcher: {
          dispatch: async () => ({
            content: [{ type: 'image', data: 'aGVsbG8=', mimeType: 'image/png' }],
            toJSON() {
              serializations++;
              return { unexpected: true };
            },
          }),
        },
        toolNames: ['read_image'],
        parentCallId: 'binary-partial-effect',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(serializations).toBe(0);
    expect(message).toMatch(/binary media.*directly/i);
    expect(message).toMatch(/Completed nested calls before failure.*read_image/i);
    expect(message).toContain('[binary media omitted]');
  });

  it('records one completed effect when result serialization throws a hostile proxy', async () => {
    let hostileThrownValue: object;
    hostileThrownValue = new Proxy({}, {
      get() { throw hostileThrownValue; },
      getPrototypeOf() { throw hostileThrownValue; },
      ownKeys() { throw hostileThrownValue; },
      getOwnPropertyDescriptor() { throw hostileThrownValue; },
    });
    let message = '';
    try {
      await executeCodeMode('return tools.write({ id: "hostile-serialization" });', {
        dispatcher: {
          dispatch: async () => ({
            toJSON() {
              throw hostileThrownValue;
            },
          }),
        },
        toolNames: ['write'],
        parentCallId: 'hostile-serialization',
        typecheck: false,
        limits: { timeoutMs: 500 },
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    // Let any incorrectly detached rejection surface before the test ends.
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(message).toContain('Unformattable thrown value');
    expect(message).not.toMatch(/timed out/i);
    expect(message.match(/Completed nested calls before failure/g)).toHaveLength(1);
    expect(message.match(/"callId":/g)).toHaveLength(1);
    expect(message).toContain('hostile-serialization:nested:1');
    expect(message).toContain('[unavailable:');
  });

  it('bounds large outputs in the completed-effect ledger', async () => {
    let message = '';
    try {
      await executeCodeMode(`
        await tools.write({ id: "large" });
        await tools.fail({});
      `, {
        dispatcher: {
          dispatch: async (name: string) => {
            if (name === 'fail') throw new Error('failed after write');
            return { payload: 'x'.repeat(500_000) };
          },
        },
        toolNames: ['write', 'fail'],
        parentCallId: 'bounded-ledger',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('Completed nested calls before failure');
    expect(message).toContain('[truncated]');
    expect(message.length).toBeLessThan(2_000);
  });

  it('serializes a successful nested result once for the guest and effect ledger', async () => {
    let serializations = 0;
    let message = '';
    try {
      await executeCodeMode(`
        const value = await tools.stateful({});
        if (JSON.stringify(value) !== '{"version":1}') throw new Error('guest saw a different value');
        await tools.fail({});
      `, {
        dispatcher: {
          dispatch: async (name: string) => {
            if (name === 'fail') throw new Error('failure after stateful result');
            return {
              toJSON() {
                serializations++;
                return { version: serializations };
              },
            };
          },
        },
        toolNames: ['stateful', 'fail'],
        parentCallId: 'stateful-serialization',
      });
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(serializations).toBe(1);
    expect(message).toContain('failure after stateful result');
    expect(message).toContain('\\"version\\":1');
    expect(message).not.toContain('guest saw a different value');
  });

  it('shares guest heap and nested-call limits across sibling code_exec calls', async () => {
    let releaseFirst: (() => void) | undefined;
    let markNestedStarted: (() => void) | undefined;
    const started = new Promise<void>(resolve => { releaseFirst = resolve; });
    const nestedStarted = new Promise<void>(resolve => { markNestedStarted = resolve; });
    const dispatcher = new ToolDispatcher({
      wait: {
        description: 'Wait', inputSchema: z.object({}),
        execute: async () => { markNestedStarted!(); await started; return { done: true }; },
      },
    });
    dispatcher.register('code_exec', createCodeExecTool({ dispatcher, toolNames: dispatcher.names() }));
    const first = dispatcher.dispatch('code_exec', { code: 'return tools.wait({});' }, { toolCallId: 'first' });
    // The first guest has retained its heap while its nested effect waits.
    await nestedStarted;
    await expect(dispatcher.dispatch('code_exec', { code: 'return 2;' }, { toolCallId: 'second' }))
      .rejects.toThrow(/run-scoped guest-memory limit/i);
    releaseFirst!();
    await expect(first).resolves.toEqual({ done: true });
  });

  it('charges completed nested calls to the run-wide limit', async () => {
    const dispatcher = new ToolDispatcher({
      echo: { description: 'Echo', inputSchema: z.object({ value: z.number() }), execute: async (input: unknown) => input },
    });
    dispatcher.register('code_exec', createCodeExecTool({
      dispatcher,
      toolNames: dispatcher.names(),
      limits: { nestedCalls: 1 },
    }));
    await expect(dispatcher.dispatch('code_exec', { code: 'return tools.echo({ value: 1 });' }, { toolCallId: 'one' }))
      .resolves.toEqual({ value: 1 });
    await expect(dispatcher.dispatch('code_exec', { code: 'return tools.echo({ value: 2 });' }, { toolCallId: 'two' }))
      .rejects.toThrow(/nested-call limit/i);
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

  it('resolves preflight declarations once per tool instance', async () => {
    let resolved = 0;
    const counted = {
      description: 'Counted',
      get inputSchema() {
        resolved += 1;
        return z.object({ value: z.number() });
      },
      execute: async ({ value }: { value: number }) => ({ value }),
    };
    const dispatcher = new ToolDispatcher({ counted });
    dispatcher.register('code_exec', createCodeExecTool({
      dispatcher,
      toolNames: dispatcher.names(),
      toolDefinitions: { counted },
    }));
    const before = resolved;

    await dispatcher.dispatch('code_exec', { code: 'return tools.counted({ value: 1 });' }, { toolCallId: 'a' });
    const first = resolved - before;
    await dispatcher.dispatch('code_exec', { code: 'return tools.counted({ value: 2 });' }, { toolCallId: 'b' });
    const second = resolved - before - first;
    await dispatcher.dispatch('code_exec', { code: 'return tools.counted({ value: 3 });' }, { toolCallId: 'c' });
    const third = resolved - before - first - second;

    // The first call resolves the declarations; later calls only pay for
    // nested input validation, so the steady state is strictly cheaper.
    expect(first).toBeGreaterThan(second);
    expect(third).toBe(second);
  });

  it('accepts an intent label without leaking it into the program', async () => {
    const dispatcher = new ToolDispatcher({
      add: {
        description: 'Add one',
        inputSchema: z.object({ value: z.number() }),
        execute: async ({ value }: { value: number }) => ({ value: value + 1 }),
      },
    });
    const tool = injectIntentParam('code_exec', createCodeExecTool({
      dispatcher,
      toolNames: dispatcher.names(),
    }));
    dispatcher.register('code_exec', tool);
    const schema = (tool.inputSchema as z.ZodObject<z.ZodRawShape>).shape;
    expect(Object.keys(schema)[0]).toBe('intent');
    const input = { intent: 'Adding one to a number', code: 'return tools.add({ value: 1 });' };
    expect(extractToolIntent(input)).toBe('Adding one to a number');
    await expect(dispatcher.dispatch('code_exec', input, { toolCallId: 'labelled' }))
      .resolves.toEqual({ value: 2 });
  });

  it('is exposed by default and documents the resolved nested catalog', () => {
    const storeList = trustedOutputTool({
      inputSchema: z.object({ status: z.string().optional() }),
      outputSchema: z.object({ success: z.literal(true), items: z.array(z.object({ id: z.string() })) }),
      execute: async () => ({ success: true as const, items: [] }),
    });
    const tool = createCodeExecTool({
      dispatcher: { dispatch: async () => null },
      toolNames: ['store_list', 'await_human'],
      toolDefinitions: { store_list: storeList },
    });
    expect(tool.description).toContain('Available nested tools: store_list');
    expect(tool.description).not.toContain('Available nested tools: await_human');
    expect(tool.description).toContain('items: Array<{ id: string }>');
    expect(tool.description).toContain('For `-> ?` outputs, do not guess fields');
    expect(tool.description).toContain('URL, Intl, locale-aware formatting, and host timezone services are unavailable');
    expect(tool.description).toContain('Dynamic code construction through eval or Function constructors is unavailable');
    expect(tool.description).toContain('When the user asks for a shell artifact, commands or scripts may contain the calculations the artifact itself needs');
  });

  it('keeps untrusted provider output schemas unknown', () => {
    const providerTool = {
      inputSchema: z.object({ query: z.string() }),
      outputSchema: z.object({ invented: z.string() }),
      execute: async () => ({ invented: 'provider result' }),
    };
    const tool = createCodeExecTool({
      dispatcher: { dispatch: async () => null },
      toolNames: ['provider_search'],
      toolDefinitions: { provider_search: providerTool },
    });

    expect(tool.description).toContain('provider_search { query: string } -> ?');
    expect(tool.description).not.toContain('invented: string');
  });

  it('rejects a wrong trusted output path before any nested tool starts', async () => {
    const execute = mock(async () => ({
      success: true as const,
      item: { data: { performance: 7 } },
    }));
    const storeGet = trustedOutputTool({
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.union([
        z.object({
          success: z.literal(true),
          item: z.object({ data: z.record(z.unknown()) }),
        }),
        z.object({ success: z.literal(false), error: z.string() }),
      ]),
      execute,
    });
    const dispatcher = new ToolDispatcher({ store_get: storeGet });

    await expect(executeCodeMode(`
      const ver = await tools.store_get({ id: "version-1" });
      if (!ver.success) throw new Error(ver.error);
      return ver.data.performance;
    `, {
      dispatcher,
      toolNames: ['store_get'],
      toolDefinitions: { store_get: storeGet },
      parentCallId: 'typed-store-get',
    })).rejects.toThrow(/TypeScript preflight.*Property 'data' does not exist/i);
    expect(execute).not.toHaveBeenCalled();
  });

  it('emits Code Mode overloads ahead of the full signature', async () => {
    const countOutput = z.object({ success: z.literal(true), total: z.number() });
    const rowsOutput = z.object({ success: z.literal(true), items: z.array(z.object({ id: z.string() })) });
    const listTool = trustedOutputTool({
      inputSchema: z.object({ countOnly: z.boolean().optional() }),
      outputSchema: z.union([countOutput, rowsOutput]),
      execute: async () => ({ success: true as const, items: [] }),
    }, {
      overloads: [
        { inputSchema: z.object({ countOnly: z.literal(true) }), outputSchema: countOutput },
        { inputSchema: z.object({ countOnly: z.literal(false).optional() }), outputSchema: rowsOutput },
      ],
    });
    const contracts = await buildCodeModeToolContracts({ list: listTool }, ['list']);
    expect(contracts[0].overloads).toHaveLength(2);
    const declarations = codeModeDeclarations(contracts);
    const lines = declarations.split('\n').filter(line => line.includes('"list"('));
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain('countOnly: true');
    expect(lines[0]).toContain('total: number');
    expect(lines[1]).toContain('items: Array<');
    expect(lines[2]).toContain('total: number');
    expect(lines[2]).toContain('items: Array<');
  });

  it('lets guest code read store_list rows without guarding the countOnly variant', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentuse-code-mode-store-'));
    try {
      const store = new Store(dir, 'overload-store', 'overload-agent');
      await store.create({ type: 'task', title: 'one', status: 'ready', data: { posted_at: '2026-01-01T00:00:00Z' } });
      const storeTools = createStoreTools(store);
      const storeList = injectIntentParam('store_list', storeTools.store_list);
      const dispatcher = new ToolDispatcher({ store_list: storeList });
      const program = `
        const r = await tools.store_list({ intent: 'Load rows', type: 'task', limit: 10, fields: ['posted_at'] });
        if (!r.success) throw new Error(r.error);
        const ids = [];
        for (const it of r.items) ids.push(it.id + ':' + String(it.data?.posted_at));
        const c = await tools.store_list({ countOnly: true });
        if (!c.success) throw new Error(c.error);
        return { ids, total: c.total, byStatus: c.byStatus };
      `;
      const result = await executeCodeMode(program, {
        dispatcher,
        toolNames: ['store_list'],
        toolDefinitions: { store_list: storeList },
        parentCallId: 'store-list-overload',
      }) as { ids: string[]; total: number; byStatus: Record<string, number> };
      expect(result.ids).toHaveLength(1);
      expect(result.ids[0]).toEndWith(':2026-01-01T00:00:00Z');
      expect(result.total).toBe(1);
      expect(result.byStatus).toEqual({ ready: 1 });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('allows valid composition through a trusted output contract', async () => {
    const storeGet = trustedOutputTool({
      inputSchema: z.object({ id: z.string() }),
      outputSchema: z.object({
        success: z.literal(true),
        item: z.object({ data: z.object({ performance: z.number() }) }),
      }),
      execute: async () => ({ success: true as const, item: { data: { performance: 7 } } }),
    });
    const dispatcher = new ToolDispatcher({ store_get: storeGet });

    const output = await executeCodeMode(`
      const ver = await tools.store_get({ id: "version-1" });
      return ver.item.data.performance;
    `, {
      dispatcher,
      toolNames: ['store_get'],
      toolDefinitions: { store_get: storeGet },
      parentCallId: 'typed-store-get-valid',
    });
    expect(output).toBe(7);
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

  it('validates trusted output after result hooks', async () => {
    const execute = mock(async () => ({ count: 1 }));
    const contract = trustedOutputTool({
      inputSchema: z.object({}),
      outputSchema: z.object({ count: z.number() }),
      execute,
    });
    const dispatcher = new ToolDispatcher({ contract }, {
      pluginEvents: {
        async toolResult(event) {
          return { ...event, output: { count: 'wrong' }, isError: false };
        },
      },
    });

    await expect(dispatcher.dispatch('contract', {}, {
      toolCallId: 'bad-output',
    })).rejects.toThrow(/does not match its output schema/i);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it('journals a trusted output contract failure after the effect ran', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentuse-contract-wal-'));
    try {
      const wal = new EffectWAL(dir);
      const contract = trustedOutputTool({
        inputSchema: z.object({}),
        outputSchema: z.object({ count: z.number() }),
        execute: async () => ({ count: 'drifted' as unknown as number }),
      });
      const dispatcher = new ToolDispatcher({ contract }, { effectWal: wal });

      await expect(dispatcher.dispatch('contract', {}, {
        toolCallId: 'drift',
      })).rejects.toThrow(/does not match its output schema/i);

      const events = (await readFile(wal.filePath!, 'utf8'))
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
        .filter(record => record.callId === 'drift')
        .map(record => record.event);
      expect(events).toEqual(['tool-start', 'tool-end', 'tool-contract-error']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
