import { createHash } from 'crypto';
import { transform } from 'esbuild';
import { getQuickJS, type QuickJSContext, type QuickJSHandle } from 'quickjs-emscripten';
import { z } from 'zod';
import type { Tool } from 'ai';
import { ToolDispatchPostEffectError, type ToolDispatcher } from './tool-dispatcher';
import { toErrorMessage } from '../utils/error-message';
import {
  buildCodeModeToolContracts,
  buildCodeModeToolContractsSync,
  codeModeDeclarations,
  codeModeQuickIndex,
} from './code-mode-contracts';
import { typecheckCodeMode } from './code-mode-typecheck';

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
  /** Effective tool definitions used to generate run-scoped TypeScript declarations. */
  toolDefinitions?: Record<string, Tool>;
  /** Precomputed declarations when the enclosing code_exec tool owns the catalog. */
  declarations?: string;
  /** Deferred catalog loading, kept inside the code_exec deadline. */
  loadDeclarations?: () => Promise<string>;
  /** Low-level test escape hatch. The model-facing code_exec tool never disables preflight. */
  typecheck?: boolean;
  parentCallId: string;
  abortSignal?: AbortSignal;
  limits?: Partial<CodeModeLimits>;
  /** Shared by sibling code_exec calls created for one agent run. */
  runBudget?: CodeModeRunBudget;
  onNestedToolStart?(trace: Omit<NestedToolTrace, 'output' | 'error' | 'endedAt'>): void | Promise<void>;
  onNestedToolFinish?(trace: NestedToolTrace): void | Promise<void>;
}

/**
 * The code_exec tool is reusable during one model run.  Keep its expensive
 * guest heaps and its effect budget run-scoped, rather than granting each
 * sibling invocation a fresh copy of every limit.
 */
export class CodeModeRunBudget {
  private nestedCallCount = 0;
  private activeNestedCalls = 0;
  private activeRuntimes = 0;
  private reservedMemoryBytes = 0;

  constructor(private readonly limits: CodeModeLimits) {}

  acquireRuntime(requestedMemoryBytes: number): () => void {
    if (this.activeRuntimes >= this.limits.concurrency) {
      throw new Error(`Code Mode exceeded its ${this.limits.concurrency}-program concurrency limit`);
    }
    if (this.reservedMemoryBytes + requestedMemoryBytes > this.limits.memoryBytes) {
      throw new Error('Code Mode exceeded its run-scoped guest-memory limit');
    }
    this.activeRuntimes++;
    this.reservedMemoryBytes += requestedMemoryBytes;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeRuntimes--;
      this.reservedMemoryBytes -= requestedMemoryBytes;
    };
  }

  acquireNestedCall(): () => void {
    this.nestedCallCount++;
    if (this.nestedCallCount > this.limits.nestedCalls) {
      this.nestedCallCount--;
      throw new Error(`Code Mode exceeded its ${this.limits.nestedCalls} nested-call limit`);
    }
    if (this.activeNestedCalls >= this.limits.concurrency) {
      this.nestedCallCount--;
      throw new Error(`Code Mode exceeded its ${this.limits.concurrency}-call concurrency limit`);
    }
    this.activeNestedCalls++;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeNestedCalls--;
    };
  }
}

interface CompletedNestedCall {
  callId: string;
  toolName: string;
  input: string;
  output: string;
}

const COMPLETED_LEDGER_VALUE_CHARS = 256;

function ledgerPreview(serialized: string): string {
  return serialized.length <= COMPLETED_LEDGER_VALUE_CHARS
    ? serialized
    : `${serialized.slice(0, COMPLETED_LEDGER_VALUE_CHARS)}… [truncated]`;
}

/** Error values may themselves be hostile proxies. This formatter never throws. */
function safeErrorMessage(error: unknown): string {
  try {
    return toErrorMessage(error);
  } catch {
    return 'Unformattable thrown value';
  }
}

function partialEffectsError(error: unknown, completed: readonly CompletedNestedCall[]): Error {
  const message = safeErrorMessage(error);
  if (completed.length === 0) {
    try {
      if (error instanceof Error) return error;
    } catch {
      // Fall through to the safe wrapper for a hostile proxy.
    }
    return new Error(message);
  }
  // This message is returned to the model as the code_exec failure. Keep the
  // ledger JSON-only so it can be used to decide whether a retry is safe.
  return new Error(`${message}\nCompleted nested calls before failure (do not repeat these effects): ${jsonStringify(completed, 'Completed nested calls')}`);
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

  const wrapped = `(async function () {\n${source}\n})()`;
  const compiled = await transform(wrapped, {
    loader: 'ts',
    target: 'es2022',
    // Lower only async functions to esbuild's Promise-based generator helper.
    // This keeps every guest async continuation on the instrumented Promise
    // below without rejecting ES2022 syntax such as BigInt literals. QuickJS
    // does not expose its host rejection tracker through this binding.
    supported: { 'async-await': false },
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
    throw new Error(`${label} is not JSON-serializable: ${safeErrorMessage(error)}`);
  }
  if (serialized === undefined) {
    throw new Error(`${label} is not JSON-serializable`);
  }
  return serialized;
}

/** Binary tool outputs cannot cross the guest's JSON-only bridge. */
function containsBinaryMediaUnsafe(value: unknown, seen = new Set<object>()): boolean {
  if (!value || typeof value !== 'object') return false;
  if (seen.has(value as object)) return false;
  seen.add(value as object);
  if (Array.isArray(value)) return value.some(item => containsBinaryMediaUnsafe(item, seen));
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
  return Object.values(objectValue).some(item => containsBinaryMediaUnsafe(item, seen));
}

type BinaryInspection =
  | { binary: true }
  | { binary: false }
  | { binary: false; error: unknown };

/** Treat hostile getters and proxies as an unavailable completed result. */
function inspectBinaryMedia(value: unknown): BinaryInspection {
  try {
    return containsBinaryMediaUnsafe(value) ? { binary: true } : { binary: false };
  } catch (error) {
    return { binary: false, error };
  }
}

function throwGuestError(context: QuickJSContext, errorHandle: QuickJSHandle): never {
  const dumped = context.dump(errorHandle);
  const message = safeErrorMessage(dumped);
  throw new Error(`Code Mode failed: ${message}`);
}

function abortError(signal: AbortSignal): Error {
  try {
    const reason: unknown = signal.reason;
    if (reason instanceof Error) return reason;
    if (typeof reason === 'string') return new Error(reason);
    return new Error(reason === undefined ? 'Code Mode execution aborted' : safeErrorMessage(reason));
  } catch {
    return new Error('Code Mode execution aborted');
  }
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

  // Start the deadline before declaration loading and typechecking. These are
  // host-side work, but they are still part of a code_exec invocation.
  const timeoutController = new AbortController();
  const signal = options.abortSignal
    ? AbortSignal.any([options.abortSignal, timeoutController.signal])
    : timeoutController.signal;
  const deadline = Date.now() + limits.timeoutMs;
  const timer = setTimeout(() => {
    timeoutController.abort(new Error(`Code Mode timed out after ${limits.timeoutMs}ms`));
  }, limits.timeoutMs);
  timer.unref?.();
  const throwIfAborted = (): void => {
    if (signal.aborted || Date.now() >= deadline) {
      if (!signal.aborted) timeoutController.abort(new Error(`Code Mode timed out after ${limits.timeoutMs}ms`));
      throw abortError(signal);
    }
  };

  let runtime: ReturnType<Awaited<ReturnType<typeof getQuickJS>>['newRuntime']>;
  let context: QuickJSContext;
  let releaseRuntime: (() => void) | undefined;
  const runBudget = options.runBudget ?? new CodeModeRunBudget(limits);
  try {
    // Reserve before any host-side preflight so sibling code_exec calls cannot
    // multiply TypeScript/compiler work while waiting for a guest heap.
    releaseRuntime = runBudget.acquireRuntime(limits.memoryBytes);
    const eligible = codeModeEligibleToolNames(options.toolNames);
    const eligibleSet = new Set(eligible);
    if (options.typecheck !== false) {
      const declarations: string = options.declarations
        ?? await raceWithAbort(
          options.loadDeclarations?.() ?? buildCodeModeToolContracts(options.toolDefinitions ?? {}, eligible).then(codeModeDeclarations),
          signal
        );
      throwIfAborted();
      await typecheckCodeMode(source, declarations, limits.memoryBytes, signal);
      throwIfAborted();
    }
    const compiled = await raceWithAbort(compileTypeScript(source), signal);
    throwIfAborted();
    const quickJS = await raceWithAbort(getQuickJS(), signal);
    throwIfAborted();
    runtime = quickJS.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.maxStackBytes);
    runtime.setInterruptHandler(() => signal.aborted || Date.now() >= deadline);
    context = runtime.newContext();
  let callCount = 0;
  let disposed = false;
  let promiseHandle: QuickJSHandle | undefined;
  let settling: ReturnType<QuickJSContext['resolvePromise']> | undefined;
  const inFlight = new Set<Promise<void>>();
  const dispatcherSettlements = new Set<Promise<void>>();
  const pendingDispatches = new Map<string, {
    callId: string;
    toolName: string;
    inputJson: string;
    effectRecorded: boolean;
  }>();
  const pendingDeferreds = new Set<ReturnType<QuickJSContext['newPromise']>>();
  const completedCalls: CompletedNestedCall[] = [];
  const unhandledNestedFailures = new Map<number, string>();
  let nextUnhandledFailureId = 0;

  const settlePromise = (
    deferred: ReturnType<QuickJSContext['newPromise']>,
    outcome: { value: string } | { error: string }
  ): void => {
    if (disposed) return;
    // Resolve every bridge operation. The guest prelude turns an unsuccessful
    // envelope into a tracked rejection, which lets it distinguish an await or
    // catch from a promise that was simply abandoned.
    const handle = context.newString(jsonStringify(
      'value' in outcome
        ? { ok: true, value: outcome.value }
        : { ok: false, error: outcome.error },
      'Nested tool envelope'
    ));
    try {
      deferred.resolve(handle);
    } finally {
      handle.dispose();
    }
    const jobs = runtime.executePendingJobs();
    if (jobs.error) {
      const dumped = context.dump(jobs.error);
      unhandledNestedFailures.set(++nextUnhandledFailureId,
        dumped && typeof dumped === 'object' && typeof (dumped as { message?: unknown }).message === 'string'
          ? (dumped as { message: string }).message
          : typeof dumped === 'string' ? dumped : jsonStringify(dumped, 'Unhandled guest rejection')
      );
      jobs.error.dispose();
    }
  };

  const recordUnhandled = context.newFunction('__agentuseRecordUnhandled', errorHandle => {
    const id = ++nextUnhandledFailureId;
    unhandledNestedFailures.set(id, context.getString(errorHandle));
    return context.newNumber(id);
  });
  const markUnhandledObserved = context.newFunction('__agentuseMarkUnhandledObserved', idHandle => {
    unhandledNestedFailures.delete(context.getNumber(idHandle));
    return context.undefined;
  });

  const bridge = context.newFunction('__agentuseCall', (nameHandle, inputHandle) => {
    const deferred = context.newPromise();
    pendingDeferreds.add(deferred);
    const toolName = context.getString(nameHandle);
    const inputJson = context.getString(inputHandle);

    const operation = (async () => {
      const startedAt = Date.now();
      const callId = `${options.parentCallId}:nested:${++callCount}`;
      let input: unknown;
      let releaseNestedCall: (() => void) | undefined;
      const dispatchDescriptor: {
        callId: string;
        toolName: string;
        inputJson: string;
        effectRecorded: boolean;
      } = { callId, toolName, inputJson, effectRecorded: false };
      let dispatchStarted = false;
      let finishAttempted = false;
      const markEffectRecorded = (): void => {
        dispatchDescriptor.effectRecorded = true;
      };
      const recordPostEffectFailure = (error: unknown): void => {
        if (dispatchDescriptor.effectRecorded) return;
        let postEffectError: ToolDispatchPostEffectError;
        try {
          if (!(error instanceof ToolDispatchPostEffectError)) return;
          postEffectError = error;
        } catch {
          return;
        }
        markEffectRecorded();
        completedCalls.push({
          callId,
          toolName,
          input: ledgerPreview(inputJson),
          output: ledgerPreview(
            `[result unavailable after completed effect: ${safeErrorMessage(postEffectError.cause)}]`
          ),
        });
      };
      const recordSuccessfulOutput = (output: unknown):
        | { kind: 'binary' }
        | { kind: 'serialized'; serialized: string }
        | { kind: 'unavailable'; error: unknown } => {
        const inspection = inspectBinaryMedia(output);
        if (inspection.binary) {
          markEffectRecorded();
          completedCalls.push({
            callId,
            toolName,
            input: ledgerPreview(inputJson),
            output: '[binary media omitted]',
          });
          return { kind: 'binary' };
        }
        if ('error' in inspection) {
          const inspectionError = new Error(
            `Result from '${toolName}' could not be inspected for binary media: ${safeErrorMessage(inspection.error)}`
          );
          markEffectRecorded();
          completedCalls.push({
            callId,
            toolName,
            input: ledgerPreview(inputJson),
            output: ledgerPreview(`[unavailable: ${inspectionError.message}]`),
          });
          return { kind: 'unavailable', error: inspectionError };
        }
        let serialized: string | undefined;
        let serializationError: unknown;
        try {
          serialized = jsonStringify(output, `Result from '${toolName}'`);
        } catch (error) {
          serializationError = error;
        }
        markEffectRecorded();
        completedCalls.push({
          callId,
          toolName,
          input: ledgerPreview(inputJson),
          output: serialized === undefined
            ? `[unavailable: ${safeErrorMessage(serializationError)}]`
            : ledgerPreview(serialized),
        });
        return serialized === undefined
          ? { kind: 'unavailable', error: serializationError }
          : { kind: 'serialized', serialized };
      };
      const notifyFinish = async (trace: NestedToolTrace): Promise<void> => {
        if (!options.onNestedToolFinish) return;
        if (signal.aborted) throw abortError(signal);
        finishAttempted = true;
        await raceWithAbort(Promise.resolve(options.onNestedToolFinish(trace)), signal);
      };
      try {
        if (!eligibleSet.has(toolName)) throw new Error(`Tool '${toolName}' is unavailable in Code Mode`);
        if (inputJson.length > limits.inputCharsPerCall) {
          throw new Error(`Input for '${toolName}' exceeds the per-call size limit`);
        }
        input = JSON.parse(inputJson);
        releaseNestedCall = runBudget.acquireNestedCall();
        if (options.onNestedToolStart) {
          if (signal.aborted) throw abortError(signal);
          await raceWithAbort(Promise.resolve(options.onNestedToolStart({
            parentCallId: options.parentCallId,
            callId,
            toolName,
            input,
            startedAt,
          })), signal);
        }
        const dispatchPromise = options.dispatcher.dispatch(toolName, input, {
          toolCallId: callId,
          abortSignal: signal,
          modelFacing: false,
        });
        dispatchStarted = true;
        pendingDispatches.set(callId, dispatchDescriptor);
        // Keep observing the dispatcher after the outer abort race completes.
        // It may report a completed effect after Code Mode itself has already
        // crossed the abort boundary.
        const dispatcherSettlement = dispatchPromise.then(
          output => {
            pendingDispatches.delete(callId);
            releaseNestedCall?.();
            releaseNestedCall = undefined;
            if (signal.aborted && !dispatchDescriptor.effectRecorded) recordSuccessfulOutput(output);
          },
          error => {
            pendingDispatches.delete(callId);
            releaseNestedCall?.();
            releaseNestedCall = undefined;
            recordPostEffectFailure(error);
          }
        );
        dispatcherSettlements.add(dispatcherSettlement);
        void dispatcherSettlement.finally(() => dispatcherSettlements.delete(dispatcherSettlement));
        const output = await raceWithAbort(dispatchPromise, signal);
        // The effect may already be committed even if its response cannot
        // cross the JSON bridge. Record the result once for both the ledger
        // and guest response.
        const completion = recordSuccessfulOutput(output);
        if (completion.kind === 'binary') {
          throw new Error(`Tool '${toolName}' returned binary media and must be called directly`);
        }
        if (completion.kind === 'unavailable') throw completion.error;
        const { serialized } = completion;
        if (serialized.length > limits.resultCharsPerCall) {
          throw new Error(`Result from '${toolName}' exceeds the per-call Code Mode size limit`);
        }
        await notifyFinish({
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
        recordPostEffectFailure(error);
        const message = safeErrorMessage(error);
        if (!finishAttempted) {
          try {
            await notifyFinish({
              parentCallId: options.parentCallId,
              callId,
              toolName,
              input,
              error: message,
              startedAt,
              endedAt: Date.now(),
            });
          } catch {
            // The original dispatch/hook error remains the guest-visible cause.
          }
        }
        settlePromise(deferred, { error: message });
      } finally {
        if (!dispatchStarted) releaseNestedCall?.();
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

  const drainGuestOperations = async (): Promise<void> => {
    while (true) {
      throwIfAborted();
      const operations = [...inFlight];
      if (operations.length > 0) {
        await raceWithAbort(Promise.allSettled(operations).then(() => undefined), signal);
        throwIfAborted();
        continue;
      }

      const jobs = runtime.executePendingJobs();
      if (jobs.error) {
        try { throwGuestError(context, jobs.error); }
        finally { jobs.error.dispose(); }
      }
      throwIfAborted();
      if (inFlight.size === 0 && !runtime.hasPendingJob()) return;
    }
  };

  try {
  try {
    context.setProp(context.global, '__agentuseCall', bridge);
    context.setProp(context.global, '__agentuseRecordUnhandled', recordUnhandled);
    context.setProp(context.global, '__agentuseMarkUnhandledObserved', markUnhandledObserved);
    const preludeResult = context.evalCode(`
      (() => {
        const call = globalThis.__agentuseCall;
        const recordUnhandled = globalThis.__agentuseRecordUnhandled;
        const markUnhandledObserved = globalThis.__agentuseMarkUnhandledObserved;
        const names = ${JSON.stringify(eligible)};
        const FunctionConstructor = globalThis.Function;
        const dynamicConstructorPrototypes = [
          FunctionConstructor.prototype,
          Object.getPrototypeOf(async function () {}),
          Object.getPrototypeOf(function* () {}),
          Object.getPrototypeOf(async function* () {}),
        ];
        const NativePromise = globalThis.Promise;
        const promiseStates = new WeakMap();
        const speciesConstructor = (promise) => {
          const constructor = promise.constructor;
          if (constructor === undefined) return TrackedPromise;
          if ((typeof constructor !== 'object' || constructor === null) && typeof constructor !== 'function') {
            throw new TypeError('Promise constructor is not an object');
          }
          const species = constructor[Symbol.species];
          if (species === undefined || species === null) return TrackedPromise;
          if (typeof species !== 'function') throw new TypeError('Promise species is not a constructor');
          return species;
        };
        const promiseResolve = (Constructor, value) => {
          if (value instanceof TrackedPromise && value.constructor === Constructor) return value;
          return new Constructor((resolve) => resolve(value));
        };
        const markHandled = (promise) => {
          const state = promiseStates.get(promise);
          state.handled = true;
          if (state.rejectionId !== undefined) {
            markUnhandledObserved(state.rejectionId);
            state.rejectionId = undefined;
          }
        };
        class TrackedPromise {
          constructor(executor) {
            if (typeof executor !== 'function') throw new TypeError('Promise resolver is not a function');
            let nativeResolve;
            let nativeReject;
            const native = new NativePromise((resolve, reject) => {
              nativeResolve = resolve;
              nativeReject = reject;
            });
            const state = { handled: false, rejectionId: undefined, settled: false, native };
            promiseStates.set(this, state);
            const settleRejected = (error) => {
              if (!state.handled && state.rejectionId === undefined) {
                state.rejectionId = recordUnhandled(error && error.message ? error.message : String(error));
              }
              nativeReject(error);
            };
            const reject = (error) => {
              if (state.settled) return;
              state.settled = true;
              settleRejected(error);
            };
            const resolve = (value) => {
              if (state.settled) return;
              state.settled = true;
              if (value === this) {
                settleRejected(new TypeError('Chaining cycle detected for promise'));
                return;
              }
              NativePromise.resolve(value).then(nativeResolve, settleRejected);
            };
            try { executor(resolve, reject); } catch (error) { reject(error); }
            // A derived constructor still needs to initialize its own fields
            // after super() returns.
            if (new.target === TrackedPromise) Object.freeze(this);
          }

          then(onFulfilled, onRejected) {
            markHandled(this);
            const native = promiseStates.get(this).native;
            const Constructor = speciesConstructor(this);
            return new Constructor((resolve, reject) => {
              NativePromise.prototype.then.call(
                native,
                typeof onFulfilled === 'function'
                  ? (value) => { try { resolve(onFulfilled(value)); } catch (error) { reject(error); } }
                  : resolve,
                typeof onRejected === 'function'
                  ? (error) => { try { resolve(onRejected(error)); } catch (nextError) { reject(nextError); } }
                  : reject,
              );
            });
          }

          catch(onRejected) { return this.then(undefined, onRejected); }

          finally(onFinally) {
            const runFinally = () => typeof onFinally === 'function' ? onFinally() : undefined;
            const Constructor = speciesConstructor(this);
            return this.then(
              (value) => promiseResolve(Constructor, runFinally()).then(() => value),
              (error) => promiseResolve(Constructor, runFinally()).then(() => { throw error; }),
            );
          }

          static resolve(value) {
            return value instanceof TrackedPromise && value.constructor === this
              ? value
              : new this((resolve) => resolve(value));
          }

          static reject(error) { return new this((_resolve, reject) => reject(error)); }

          static all(values) {
            return NativePromise.all.call(this, values);
          }

          static allSettled(values) {
            return NativePromise.allSettled.call(this, values);
          }

          static race(values) {
            return NativePromise.race.call(this, values);
          }

          static any(values) {
            return NativePromise.any.call(this, values);
          }

          static get [Symbol.species]() { return this; }

          get [Symbol.toStringTag]() { return 'Promise'; }
        }
        Object.freeze(TrackedPromise.prototype);
        Object.freeze(TrackedPromise);
        Object.defineProperty(globalThis, 'Promise', {
          value: TrackedPromise,
          writable: false,
          configurable: false,
        });
        const entries = names.map((name) => [name, (input = {}) =>
          new TrackedPromise((resolve, reject) => {
            call(name, JSON.stringify(input)).then((envelope) => {
              try {
                const payload = JSON.parse(envelope);
                if (!payload.ok) { reject(new Error(payload.error)); return; }
                resolve(JSON.parse(payload.value));
              } catch (error) { reject(error); }
            }, reject);
          })
        ]);
        Object.defineProperty(globalThis, 'tools', {
          value: Object.freeze(Object.fromEntries(entries)),
          writable: false,
          configurable: false,
          enumerable: true,
        });
        delete globalThis.__agentuseCall;
        delete globalThis.__agentuseRecordUnhandled;
        delete globalThis.__agentuseMarkUnhandledObserved;
        function dynamicCodeUnavailable() {
          throw new Error('Dynamic code construction is unavailable in Code Mode');
        }
        for (const prototype of dynamicConstructorPrototypes) {
          Object.defineProperty(prototype, 'constructor', {
            value: dynamicCodeUnavailable,
            writable: false,
            configurable: false,
          });
        }
        Object.defineProperty(globalThis, 'Function', {
          value: dynamicCodeUnavailable,
          writable: false,
          configurable: false,
        });
        Object.defineProperty(globalThis, 'eval', {
          value: dynamicCodeUnavailable,
          writable: false,
          configurable: false,
        });
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
    settling = context.resolvePromise(promiseHandle);
    const initialJobs = runtime.executePendingJobs();
    if (initialJobs.error) {
      promiseHandle.dispose();
      promiseHandle = undefined;
      if (signal.aborted || Date.now() >= deadline) {
        initialJobs.error.dispose();
        throwIfAborted();
      }
      try { throwGuestError(context, initialJobs.error); }
      finally { initialJobs.error.dispose(); }
    }
    const settled = await raceWithAbort(settling, signal);
    settling = undefined;
    promiseHandle.dispose();
    promiseHandle = undefined;
    if (signal.aborted || Date.now() >= deadline) {
      if (settled.error) settled.error.dispose();
      else settled.value.dispose();
      throwIfAborted();
    }
    if (settled.error) {
      try { throwGuestError(context, settled.error); }
      finally { settled.error.dispose(); }
    }
    const result = context.dump(settled.value);
    settled.value.dispose();
    await drainGuestOperations();
    throwIfAborted();
    if (unhandledNestedFailures.size > 0) {
      throw new Error(`Code Mode has unhandled nested tool failures: ${[...unhandledNestedFailures.values()].join('; ')}`);
    }
    const serialized = jsonStringify(result, 'Code Mode output');
    if (serialized.length > limits.outputChars) {
      throw new Error(`Code Mode output exceeds ${limits.outputChars.toLocaleString('en-US')} characters`);
    }
    return result;
  } finally {
    if (!signal.aborted) timeoutController.abort(new Error('Code Mode execution finished'));
    // Reject unresolved bridge promises before disposing the guest. This lets
    // the original resolvePromise call produce its final handle even when the
    // caller's abort race has already returned.
    if (signal.aborted && settling && pendingDeferreds.size > 0) {
      const message = safeErrorMessage(abortError(signal));
      for (const deferred of pendingDeferreds) settlePromise(deferred, { error: message });
    }
    // Host tools should observe abort, but a third-party tool may ignore it.
    // Give cooperative calls and post-effect error reporting a short drain
    // window without allowing an uncooperative tool to pin the whole run.
    const cleanupOperations = [...inFlight, ...dispatcherSettlements];
    let dispatcherCleanupExpired = pendingDispatches.size > 0 && cleanupOperations.length === 0;
    if (cleanupOperations.length > 0) {
      let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        dispatcherCleanupExpired = !(await Promise.race([
          Promise.allSettled(cleanupOperations).then(() => true),
          new Promise<boolean>(resolve => { cleanupTimer = setTimeout(() => resolve(false), 100); }),
        ]));
      } finally {
        if (cleanupTimer) clearTimeout(cleanupTimer);
      }
    }
    if (dispatcherCleanupExpired) {
      for (const descriptor of pendingDispatches.values()) {
        if (descriptor.effectRecorded) continue;
        descriptor.effectRecorded = true;
        completedCalls.push({
          callId: descriptor.callId,
          toolName: descriptor.toolName,
          input: ledgerPreview(descriptor.inputJson),
          output: '[completion unknown, verify before retry]',
        });
      }
    }
    if (settling) {
      const pendingSettlement = settling;
      let settlementTimer: ReturnType<typeof setTimeout> | undefined;
      let cleanupWindowExpired = false;
      try {
        const cleanupResult = await Promise.race([
          pendingSettlement.then(result => {
            if (cleanupWindowExpired) {
              if (result.error) result.error.dispose();
              else result.value.dispose();
              return { settled: false as const };
            }
            return { settled: true as const, result };
          }),
          new Promise<{ settled: false }>(resolve => {
            settlementTimer = setTimeout(() => resolve({ settled: false }), 100);
          }),
        ]);
        if (cleanupResult.settled) {
          settling = undefined;
          if (cleanupResult.result.error) cleanupResult.result.error.dispose();
          else cleanupResult.result.value.dispose();
        } else {
          cleanupWindowExpired = true;
        }
      } finally {
        if (settlementTimer) clearTimeout(settlementTimer);
      }
    }
    disposed = true;
    for (const deferred of pendingDeferreds) deferred.dispose();
    pendingDeferreds.clear();
    promiseHandle?.dispose();
    bridge.dispose();
    recordUnhandled.dispose();
    markUnhandledObserved.dispose();
    context.dispose();
    runtime.dispose();
  }
  } catch (error) {
    throw partialEffectsError(error, completedCalls);
  }
  } finally {
    clearTimeout(timer);
    releaseRuntime?.();
  }
}

export function createCodeExecTool(options: {
  dispatcher: Pick<ToolDispatcher, 'dispatch'>;
  toolNames: string[];
  toolDefinitions?: Record<string, Tool>;
  abortSignal?: AbortSignal;
  /** Run-wide limits shared by every sibling code_exec call from this tool. */
  limits?: Partial<CodeModeLimits>;
  onNestedToolStart?: CodeModeOptions['onNestedToolStart'];
  onNestedToolFinish?: CodeModeOptions['onNestedToolFinish'];
}): Tool {
  const eligible = codeModeEligibleToolNames(options.toolNames);
  const promptContracts = buildCodeModeToolContractsSync(options.toolDefinitions ?? {}, eligible);
  const quickIndex = codeModeQuickIndex(promptContracts);
  const runLimits: CodeModeLimits = { ...DEFAULT_CODE_MODE_LIMITS, ...options.limits };
  const runBudget = new CodeModeRunBudget(runLimits);
  // The catalog is fixed for the life of this tool, so the preflight declarations
  // are resolved once and shared by every code_exec call in the run.
  let declarationsPromise: Promise<string> | undefined;
  const loadDeclarations = (): Promise<string> => {
    declarationsPromise ??= buildCodeModeToolContracts(options.toolDefinitions ?? {}, eligible)
      .then(codeModeDeclarations)
      .catch(error => {
        declarationsPromise = undefined;
        throw error;
      });
    return declarationsPromise;
  };
  return {
    description:
      'Run isolated TypeScript for arithmetic, timestamps and duration math, percentages, basic string operations, deterministic loops, filtering, branching, batching, joins, and parallel tool calls. Use it even when the program needs zero or one tool call; ' +
      'never do that math in prose, in your head, or in bash. When the user asks for a shell artifact, commands or scripts may contain the calculations the artifact itself needs; bash is forbidden only as private scratch space for working out an answer. Date, Math, JSON, and standard string methods are available and the clock is real. URL, Intl, locale-aware formatting, and host timezone services are unavailable. ' +
      'The program has no filesystem, network, environment, process, package, console, or import access. Dynamic code construction through eval or Function constructors is unavailable. ' +
      'Call permitted tools as await tools.<name>({ ... }) using the same input object as a direct tool call, then return one JSON-serializable result. ' +
      'Code is strictly type-checked before any nested tool starts. For `-> ?` outputs, do not guess fields: return one element and its keys, observe, then narrow with runtime checks in a later code_exec before dependent logic. ' +
      `Available nested tools: ${eligible.length > 0 ? eligible.join(', ') : '(none)'}.\n\n${quickIndex}`,
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
        ...(options.toolDefinitions && { toolDefinitions: options.toolDefinitions }),
        loadDeclarations,
        parentCallId: callOptions?.toolCallId ?? CODE_EXEC_TOOL,
        runBudget,
        limits: runLimits,
        ...(abortSignal && { abortSignal }),
        ...(options.onNestedToolStart && { onNestedToolStart: options.onNestedToolStart }),
        ...(options.onNestedToolFinish && { onNestedToolFinish: options.onNestedToolFinish }),
      });
    },
  };
}
