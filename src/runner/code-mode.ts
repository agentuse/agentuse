import { createHash } from 'crypto';
import { transform } from 'esbuild';
import { getQuickJS, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten';
import { z } from 'zod';
import type { Tool } from 'ai';
import type { ToolDispatcher } from './tool-dispatcher';
import { toErrorMessage } from '../utils/error-message';

export const CODE_EXEC_TOOL = 'code_exec';
export const CODE_MODE_ENV = 'AGENTUSE_CODE_MODE';

/**
 * Code Mode is default-on. This runtime-only kill switch exists for controlled
 * evaluation and emergency rollback; it is deliberately not agent config.
 */
export function isCodeModeEnabled(): boolean {
  return process.env[CODE_MODE_ENV] !== '0';
}

export const DEFAULT_CODE_MODE_LIMITS = {
  sourceChars: 50_000,
  inputCharsPerCall: 256_000,
  resultCharsPerCall: 1_000_000,
  outputChars: 1_000_000,
  timeoutMs: 15_000,
  memoryBytes: 32 * 1024 * 1024,
  maxStackBytes: 512 * 1024,
  nestedCalls: 128,
  concurrency: 8,
} as const;

export interface CodeModeLimits {
  sourceChars: number;
  inputCharsPerCall: number;
  resultCharsPerCall: number;
  outputChars: number;
  timeoutMs: number;
  memoryBytes: number;
  maxStackBytes: number;
  nestedCalls: number;
  concurrency: number;
}

export interface NestedToolTrace {
  parentCallId: string;
  callId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: string;
  startedAt: number;
  endedAt: number;
}

export interface CodeModeOptions {
  dispatcher: Pick<ToolDispatcher, 'dispatch'>;
  toolNames: string[];
  parentCallId: string;
  abortSignal?: AbortSignal;
  limits?: Partial<CodeModeLimits>;
  onNestedToolStart?(trace: Omit<NestedToolTrace, 'output' | 'error' | 'endedAt'>): void | Promise<void>;
  onNestedToolFinish?(trace: NestedToolTrace): void | Promise<void>;
}

const DIRECT_ONLY_TOOL_NAMES = new Set([
  CODE_EXEC_TOOL,
  'await_human',
  'tools__bash',
  'report_complete',
  'report_incomplete',
  'submit_agent_source',
  'submit_project_suggestions',
  'submit_agent_revision',
  'submit_changes',
]);

/** Tools that cannot yet safely suspend or cross the JSON guest boundary. */
export function codeModeEligibleToolNames(names: Iterable<string>): string[] {
  return [...names]
    .filter(name => !DIRECT_ONLY_TOOL_NAMES.has(name))
    .filter(name => !name.startsWith('subagent__'))
    .sort();
}

const compiledCodeCache = new Map<string, string>();
const MAX_COMPILED_CACHE_ENTRIES = 128;

async function compileTypeScript(source: string): Promise<string> {
  const key = createHash('sha256').update(source).digest('hex');
  const cached = compiledCodeCache.get(key);
  if (cached) {
    compiledCodeCache.delete(key);
    compiledCodeCache.set(key, cached);
    return cached;
  }

  const wrapped = `(async () => {\n${source}\n})()`;
  const compiled = await transform(wrapped, {
    loader: 'ts',
    target: 'es2022',
    format: 'esm',
    sourcemap: false,
    legalComments: 'none',
  });
  compiledCodeCache.set(key, compiled.code);
  if (compiledCodeCache.size > MAX_COMPILED_CACHE_ENTRIES) {
    const oldest = compiledCodeCache.keys().next();
    if (!oldest.done) compiledCodeCache.delete(oldest.value);
  }
  return compiled.code;
}

function jsonStringify(value: unknown, label: string): string {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(value);
  } catch (error) {
    throw new Error(`${label} is not JSON-serializable: ${toErrorMessage(error)}`);
  }
  if (serialized === undefined) {
    throw new Error(`${label} is not JSON-serializable`);
  }
  return serialized;
}

/** Binary tool outputs cannot cross the guest's JSON-only bridge. */
function containsBinaryMedia(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some(item => containsBinaryMedia(item, seen));
  const objectValue = value as Record<string, unknown>;
  if (
    typeof objectValue.data === 'string' &&
    typeof objectValue.type === 'string' &&
    ['image', 'audio', 'image-data', 'file-data', 'media'].includes(objectValue.type)
  ) return true;
  if (
    objectValue._media && typeof objectValue._media === 'object' &&
    typeof (objectValue._media as Record<string, unknown>).data === 'string'
  ) return true;
  return Object.values(objectValue).some(item => containsBinaryMedia(item, seen));
}

function throwGuestError(context: QuickJSContext, errorHandle: QuickJSHandle): never {
  const dumped = context.dump(errorHandle);
  const message = dumped && typeof dumped === 'object' && typeof (dumped as { message?: unknown }).message === 'string'
    ? (dumped as { message: string }).message
    : typeof dumped === 'string'
      ? dumped
      : jsonStringify(dumped, 'Guest error');
  throw new Error(`Code Mode failed: ${message}`);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error(typeof signal.reason === 'string' ? signal.reason : 'Code Mode execution aborted');
}

function raceWithAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  if (signal.aborted) return Promise.reject(abortError(signal));
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(abortError(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', onAbort));
  });
}

/** Execute model-authored TypeScript in a fresh QuickJS heap. */
export async function executeCodeMode(source: string, options: CodeModeOptions): Promise<unknown> {
  const limits: CodeModeLimits = { ...DEFAULT_CODE_MODE_LIMITS, ...options.limits };
  if (source.length > limits.sourceChars) {
    throw new Error(`Code Mode source exceeds ${limits.sourceChars.toLocaleString('en-US')} characters`);
  }

  const eligible = codeModeEligibleToolNames(options.toolNames);
  const eligibleSet = new Set(eligible);
  const compiled = await compileTypeScript(source);
  const quickJS = await getQuickJS();
  const runtime = quickJS.newRuntime();
  runtime.setMemoryLimit(limits.memoryBytes);
  runtime.setMaxStackSize(limits.maxStackBytes);

  const timeoutController = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const deadline = Date.now() + limits.timeoutMs;
  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`Code Mode timed out after ${limits.timeoutMs}ms`));
  }, limits.timeoutMs);
  timer.unref?.();
  runtime.setInterruptHandler(() => signal.aborted || Date.now() >= deadline);

  const context = runtime.newContext();
  let callCount = 0;
  let activeCalls = 0;
  let disposed = false;
  let promiseHandle: QuickJSHandle | undefined;
  const inFlight = new Set<Promise<void>>();
  const pendingDeferreds = new Set<ReturnType<QuickJSContext['newPromise']>>();

  const settlePromise = (
    deferred: ReturnType<QuickJSContext['newPromise']>,
    outcome: { value: string } | { error: string }
  ): void => {
    if (disposed) return;
    const handle = context.newString('value' in outcome ? outcome.value : outcome.error);
    try {
      if ('value' in outcome) deferred.resolve(handle);
      else deferred.reject(handle);
    } finally {
      handle.dispose();
    }
    const jobs = runtime.executePendingJobs();
    if (jobs.error) jobs.error.dispose();
  };

  const bridge = context.newFunction('__agentuseCall', (nameHandle, inputHandle) => {
    const deferred = context.newPromise();
    pendingDeferreds.add(deferred);
    const toolName = context.getString(nameHandle);
    const inputJson = context.getString(inputHandle);

    const operation = (async () => {
      const startedAt = Date.now();
      const callId = `${options.parentCallId}:nested:${++callCount}`;
      let input: unknown;
      let slotAcquired = false;
      try {
        if (!eligibleSet.has(toolName)) throw new Error(`Tool '${toolName}' is unavailable in Code Mode`);
        if (callCount > limits.nestedCalls) {
          throw new Error(`Code Mode exceeded its ${limits.nestedCalls} nested-call limit`);
        }
        if (activeCalls >= limits.concurrency) {
          throw new Error(`Code Mode exceeded its ${limits.concurrency}-call concurrency limit`);
        }
        if (inputJson.length > limits.inputCharsPerCall) {
          throw new Error(`Input for '${toolName}' exceeds the per-call size limit`);
        }
        input = JSON.parse(inputJson);
        activeCalls++;
        slotAcquired = true;
        await options.onNestedToolStart?.({
          parentCallId: options.parentCallId,
          callId,
          toolName,
          input,
          startedAt,
        });
        const output = await raceWithAbort(options.dispatcher.dispatch(toolName, input, {
          toolCallId: callId,
          abortSignal: signal,
          modelFacing: false,
        }), signal);
        if (containsBinaryMedia(output)) {
          throw new Error(`Tool '${toolName}' returned binary media and must be called directly`);
        }
        const serialized = jsonStringify(output, `Result from '${toolName}'`);
        if (serialized.length > limits.resultCharsPerCall) {
          throw new Error(`Result from '${toolName}' exceeds the per-call Code Mode size limit`);
        }
        await options.onNestedToolFinish?.({
          parentCallId: options.parentCallId,
          callId,
          toolName,
          input,
          output,
          startedAt,
          endedAt: Date.now(),
        });
        settlePromise(deferred, { value: serialized });
      } catch (error) {
        const message = toErrorMessage(error);
        await options.onNestedToolFinish?.({
          parentCallId: options.parentCallId,
          callId,
          toolName,
          input,
          error: message,
          startedAt,
          endedAt: Date.now(),
        });
        settlePromise(deferred, { error: message });
      } finally {
        if (slotAcquired) activeCalls--;
        if (!disposed) {
          pendingDeferreds.delete(deferred);
          deferred.dispose();
        }
      }
    })();
    inFlight.add(operation);
    void operation.finally(() => inFlight.delete(operation));
    return deferred.handle;
  });

  try {
    context.setProp(context.global, '__agentuseCall', bridge);
    const preludeResult = context.evalCode(`
      (() => {
        const call = globalThis.__agentuseCall;
        const names = ${JSON.stringify(eligible)};
        const entries = names.map((name) => [name, (input = {}) =>
          call(name, JSON.stringify(input)).then((result) => JSON.parse(result))
        ]);
        Object.defineProperty(globalThis, 'tools', {
          value: Object.freeze(Object.fromEntries(entries)),
          writable: false,
          configurable: false,
          enumerable: true,
        });
        delete globalThis.__agentuseCall;
      })();
    `, 'agentuse-code-mode-prelude.js');
    if (preludeResult.error) {
      try { throwGuestError(context, preludeResult.error); }
      finally { preludeResult.error.dispose(); }
    }
    preludeResult.value.dispose();

    const evaluation = context.evalCode(compiled, 'agentuse-code-mode.js');
    if (evaluation.error) {
      try { throwGuestError(context, evaluation.error); }
      finally { evaluation.error.dispose(); }
    }
    promiseHandle = evaluation.value;
    const settling = context.resolvePromise(promiseHandle);
    const initialJobs = runtime.executePendingJobs();
    if (initialJobs.error) {
      promiseHandle.dispose();
      promiseHandle = undefined;
      try { throwGuestError(context, initialJobs.error); }
      finally { initialJobs.error.dispose(); }
    }
    const settled = await raceWithAbort(settling, signal);
    promiseHandle.dispose();
    promiseHandle = undefined;
    if (settled.error) {
      try { throwGuestError(context, settled.error); }
      finally { settled.error.dispose(); }
    }
    const result = context.dump(settled.value);
    settled.value.dispose();
    await Promise.allSettled([...inFlight]);
    const drained = runtime.executePendingJobs();
    if (drained.error) drained.error.dispose();
    const serialized = jsonStringify(result, 'Code Mode output');
    if (serialized.length > limits.outputChars) {
      throw new Error(`Code Mode output exceeds ${limits.outputChars.toLocaleString('en-US')} characters`);
    }
    return result;
  } finally {
    clearTimeout(timer);
    if (!signal.aborted) timeoutController.abort(new Error('Code Mode execution finished'));
    // Host tools should observe abort, but a third-party tool may ignore it.
    // Give cooperative calls a short drain window, then release the guest heap
    // without allowing an uncooperative nested call to pin the whole run.
    if (inFlight.size > 0) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          Promise.allSettled([...inFlight]),
          new Promise<void>(resolve => { cleanupTimer = setTimeout(resolve, 100); }),
        ]);
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
      }
    }
    disposed = true;
    for (const deferred of pendingDeferreds) deferred.dispose();
    pendingDeferreds.clear();
    promiseHandle?.dispose();
    bridge.dispose();
    context.dispose();
    runtime.dispose();
  }
}

export function createCodeExecTool(options: {
  dispatcher: Pick<ToolDispatcher, 'dispatch'>;
  toolNames: string[];
  abortSignal?: AbortSignal;
  onNestedToolStart?: CodeModeOptions['onNestedToolStart'];
  onNestedToolFinish?: CodeModeOptions['onNestedToolFinish'];
}): Tool {
  const eligible = codeModeEligibleToolNames(options.toolNames);
  return {
    description:
      'Run isolated TypeScript for deterministic loops, filtering, branching, batching, joins, and parallel tool calls. ' +
      'The program has no filesystem, network, environment, process, package, or import access. ' +
      'Call permitted tools as await tools.<name>({ ... }) using the same input object as a direct tool call, then return one JSON-serializable result. ' +
      `Available nested tools: ${eligible.length > 0 ? eligible.join(', ') : '(none)'}.`,
    inputSchema: z.object({
      code: z.string().min(1).max(DEFAULT_CODE_MODE_LIMITS.sourceChars)
        .describe('TypeScript function body. Top-level await and return are supported. No imports.'),
    }),
    execute: async (
      { code }: { code: string },
      callOptions?: { toolCallId?: string; abortSignal?: AbortSignal }
    ) => {
      const abortSignal = options.abortSignal && callOptions?.abortSignal
        ? AbortSignal.any([options.abortSignal, callOptions.abortSignal])
        : options.abortSignal ?? callOptions?.abortSignal;
      return executeCodeMode(code, {
        dispatcher: options.dispatcher,
        toolNames: eligible,
        parentCallId: callOptions?.toolCallId ?? CODE_EXEC_TOOL,
        ...(abortSignal && { abortSignal }),
        ...(options.onNestedToolStart && { onNestedToolStart: options.onNestedToolStart }),
        ...(options.onNestedToolFinish && { onNestedToolFinish: options.onNestedToolFinish }),
      });
    },
  };
}
