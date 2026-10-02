import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PluginHost, PluginManager } from '../src/plugin';
import type { AgentCompleteEvent, PluginEventContext } from '../src/plugin/types';
import { resetProviderPluginCache } from '../src/plugin/provider-runtime';
import { ExecutionBudget } from '../src/runner/execution-budget';
import { runAgent } from '../src/runner/run';

const identity = { name: 'hanging-observer', source: 'test', scope: 'local' as const };
const never = () => new Promise<never>(() => {});
const startEvent = { agent: { name: 'a', model: 'demo:test' } };
const completeEvent: AgentCompleteEvent = {
  agent: { name: 'a', model: 'demo:test' },
  result: { text: 'original', duration: 1, toolCalls: 0, hasTextOutput: true },
  isSubAgent: false,
  consoleOutput: '',
};

let root: string;
let oldDataDir: string | undefined;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-plugin-cancel-'));
  oldDataDir = process.env.AGENTUSE_DATA_DIR;
  process.env.AGENTUSE_DATA_DIR = root;
  resetProviderPluginCache();
});

afterEach(async () => {
  resetProviderPluginCache();
  if (oldDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = oldDataDir;
  await fs.rm(root, { recursive: true, force: true });
});

describe('lifecycle plugin cancellation', () => {
  it('releases emit when the signal aborts and starts no later handler', async () => {
    const host = new PluginHost();
    const started: string[] = [];
    await host.activate(identity, (api: any) => {
      api.on('agent:start', async () => { started.push('first'); await never(); });
      api.on('agent:start', () => { started.push('second'); });
    });
    const controller = new AbortController();
    const pending = host.emit('agent:start', startEvent as any, controller.signal);
    await new Promise((resolve) => setTimeout(resolve, 5));
    const reason = new Error('deadline');
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(started).toEqual(['first']);
  });

  it('starts no handler once the signal has already aborted', async () => {
    const host = new PluginHost();
    let called = false;
    await host.activate(identity, (api: any) => { api.on('agent:start', () => { called = true; }); });
    const controller = new AbortController();
    controller.abort(new Error('already cancelled'));
    await expect(host.emit('agent:start', startEvent as any, controller.signal)).rejects.toThrow('already cancelled');
    await Promise.resolve();
    expect(called).toBe(false);
  });

  it('releases agent:complete dispatch when the signal aborts', async () => {
    const host = new PluginHost();
    await host.activate(identity, (api: any) => { api.on('agent:complete', never); });
    const controller = new AbortController();
    const pending = host.dispatchAgentComplete(completeEvent, controller.signal);
    const reason = new Error('deadline');
    setTimeout(() => controller.abort(reason), 5);
    await expect(pending).rejects.toBe(reason);
  });

  it('releases the legacy agent:complete loop when the signal aborts', async () => {
    const manager = new PluginManager();
    (manager as any).plugins.push({ path: 'legacy.js', handlers: { 'agent:complete': never } });
    const controller = new AbortController();
    const pending = manager.emitAgentComplete(completeEvent, controller.signal);
    const reason = new Error('deadline');
    setTimeout(() => controller.abort(reason), 20);
    await expect(pending).rejects.toBe(reason);
  });

  it('observes a handler that rejects after it was abandoned', async () => {
    const host = new PluginHost();
    let rejectLate!: (error: Error) => void;
    await host.activate(identity, (api: any) => {
      api.on('agent:start', () => new Promise<void>((_, reject) => { rejectLate = reject; }));
    });
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const controller = new AbortController();
      const pending = host.emit('agent:start', startEvent as any, controller.signal);
      await new Promise((resolve) => setTimeout(resolve, 5));
      controller.abort(new Error('deadline'));
      await expect(pending).rejects.toThrow('deadline');
      rejectLate(new Error('late failure'));
      await new Promise((resolve) => setTimeout(resolve, 10));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('lets a run deadline unwind a hung agent:start hook, run cleanup, and still report agent:error', async () => {
    const host = new PluginHost();
    const budget = new ExecutionBudget(25);
    let errorSignal: AbortSignal | undefined;
    let errorReported = false;
    await host.activate(identity, (api: any) => {
      api.on('agent:start', never);
      api.on('agent:error', (_event: unknown, context: PluginEventContext) => {
        errorReported = true;
        errorSignal = context.signal;
      });
    });
    let cleaned = false;
    const prepared = {
      tools: {}, systemMessages: [], userMessage: 'Fixture', maxSteps: 1,
      subAgentNames: new Set(), runOutcome: {},
      cleanup: async () => { cleaned = true; },
      releaseStoreLock: async () => {},
    };
    const run = runAgent(
      { name: 'cancel-fixture', instructions: 'Fixture', config: { model: 'demo:test' } } as any,
      [], false, budget.signal, Date.now(), false, undefined, undefined,
      undefined, undefined, undefined, prepared as any, true,
      { emit: host.emit.bind(host) } as any, false,
    );
    const settled = await Promise.race([
      run.then(() => 'resolved', () => 'rejected'),
      new Promise((resolve) => setTimeout(() => resolve('hung'), 1_000)),
    ]);
    await budget.finish();
    expect(settled).toBe('rejected');
    expect(cleaned).toBe(true);
    expect(errorReported).toBe(true);
    expect(errorSignal?.aborted).toBe(false);
  });
});
