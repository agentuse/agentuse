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
  codeModeVirtualDeclaration,
  type CodeModeToolContract,
} from './code-mode-contracts';
import { typecheckCodeMode, type CodeModeSourceLocation } from './code-mode-typecheck';
import { mapCodeModeStack } from './code-mode-source-map';
import {
  describeCodeModeResultFromSerialized,
  type CodeModeResultMetadata,
  type CodeModeResultReference,
} from '../session/code-mode-results';
import type {
  CodeModeGrepOptions,
  CodeModeGrepResult,
  CodeModeJqOptions,
  CodeModeJqResult,
} from '../session/code-mode-result-query';

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
  resultReadBytes: 4_000_000,
  resultReads: 32,
  outputChars: 1_000_000,
  consoleOutputChars: 4_096,
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
  resultReadBytes: number;
  resultReads: number;
  outputChars: number;
  consoleOutputChars: number;
  timeoutMs: number;
  memoryBytes: number;
  maxStackBytes: number;
  nestedCalls: number;
  concurrency: number;
}

export type CodeModeErrorCode =
  | 'invalid_input'
  | 'aborted'
  | 'timeout'
  | 'output_limit_exceeded'
  | 'result_access'
  | 'tool_execution'
  | 'runtime_error'
  | 'runtime_unavailable'
  | 'internal_error';

export type CodeModeOutputEntry =
  | { type: 'text'; text: string }
  | { type: 'json'; value: unknown };

export interface CodeModeTelemetry {
  catalogSize: number;
  nestedCalls: number;
  durationMs: number;
  valueBytes: number;
  outputBytes: number;
  outputEntries: number;
  resultReads: number;
  resultReadBytes: number;
  resultGreps: number;
  resultJqQueries: number;
  resultQueryBytes: number;
}

export interface CodeModeCompletedResult {
  status: 'completed';
  value: unknown;
  output?: CodeModeOutputEntry[];
  reusableResults?: CodeModeResultReference[];
  telemetry: CodeModeTelemetry;
}

export interface CodeModeFailedResult {
  status: 'failed';
  error: { code: CodeModeErrorCode; message: string };
  output?: CodeModeOutputEntry[];
  reusableResults?: CodeModeResultReference[];
  telemetry: CodeModeTelemetry;
}

export class CodeModeExecutionError extends Error {
  readonly code: CodeModeErrorCode;

  constructor(readonly result: CodeModeFailedResult, options: { cause?: unknown } = {}) {
    const trace = result.output?.length
      ? `\nOutput before failure: ${JSON.stringify(result.output)}`
      : '';
    super(`Code Mode ${result.error.code}: ${result.error.message}${trace}`, options);
    this.name = 'CodeModeExecutionError';
    this.code = result.error.code;
  }
}

export interface NestedToolTrace {
  parentCallId: string;
  callId: string;
  toolName: string;
  input: unknown;
  output?: unknown;
  error?: string;
  reusableResult?: CodeModeResultMetadata;
  startedAt: number;
  endedAt: number;
}

export interface CodeModeResultAccess {
  read(resultId: string): Promise<unknown>;
  list(limit?: number): Promise<CodeModeResultReference[]>;
  grep?(resultId: string, options: CodeModeGrepOptions): Promise<CodeModeGrepResult>;
  jq?(
    resultId: string,
    expression: string,
    options?: CodeModeJqOptions,
    signal?: AbortSignal
  ): Promise<CodeModeJqResult>;
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
  /** Deferred tool contracts used by preflight and the guest discovery API. */
  loadContracts?: () => Promise<CodeModeToolContract[]>;
  /** Low-level test escape hatch. The model-facing code_exec tool never disables preflight. */
  typecheck?: boolean;
  parentCallId: string;
  abortSignal?: AbortSignal;
  limits?: Partial<CodeModeLimits>;
  /** Shared by sibling code_exec calls created for one agent run. */
  runBudget?: CodeModeRunBudget;
  onNestedToolStart?(trace: Omit<NestedToolTrace, 'output' | 'error' | 'endedAt'>): void | Promise<void>;
  onNestedToolFinish?(trace: NestedToolTrace): CodeModeResultReference | void | Promise<CodeModeResultReference | void>;
  resultAccess?: CodeModeResultAccess;
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
  private runtimeWaiters: Array<{
    requestedMemoryBytes: number;
    resolve: (release: () => void) => void;
    reject: (error: Error) => void;
    signal?: AbortSignal;
    onAbort?: () => void;
  }> = [];

  constructor(private readonly limits: CodeModeLimits) {}

  acquireRuntime(requestedMemoryBytes: number, signal?: AbortSignal): Promise<() => void> {
    if (requestedMemoryBytes > this.limits.memoryBytes) {
      return Promise.reject(new Error('Code Mode requested more than its run-scoped guest-memory limit'));
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));

    return new Promise<() => void>((resolve, reject) => {
      const waiter: (typeof this.runtimeWaiters)[number] = {
        requestedMemoryBytes,
        resolve,
        reject,
        ...(signal && { signal }),
      };
      waiter.onAbort = () => {
        const index = this.runtimeWaiters.indexOf(waiter);
        if (index < 0) return;
        this.runtimeWaiters.splice(index, 1);
        signal?.removeEventListener('abort', waiter.onAbort!);
        reject(signal ? abortError(signal) : new Error('Code Mode execution aborted'));
        this.drainRuntimeWaiters();
      };
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
      this.runtimeWaiters.push(waiter);
      this.drainRuntimeWaiters();
    });
  }

  private drainRuntimeWaiters(): void {
    while (this.runtimeWaiters.length > 0) {
      const waiter = this.runtimeWaiters[0]!;
      if (waiter.signal?.aborted) {
        this.runtimeWaiters.shift();
        waiter.signal.removeEventListener('abort', waiter.onAbort!);
        waiter.reject(abortError(waiter.signal));
        continue;
      }
      if (
        this.activeRuntimes >= this.limits.concurrency
        || this.reservedMemoryBytes + waiter.requestedMemoryBytes > this.limits.memoryBytes
      ) {
        return;
      }

      this.runtimeWaiters.shift();
      waiter.signal?.removeEventListener('abort', waiter.onAbort!);
      this.activeRuntimes++;
      this.reservedMemoryBytes += waiter.requestedMemoryBytes;
      let released = false;
      waiter.resolve(() => {
        if (released) return;
        released = true;
        this.activeRuntimes--;
        this.reservedMemoryBytes -= waiter.requestedMemoryBytes;
        this.drainRuntimeWaiters();
      });
    }
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
  result?: CodeModeResultReference;
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
  const ledger = completed.map(call => ({
    callId: call.callId,
    toolName: call.toolName,
    input: call.input,
    output: call.output,
    ...(call.result && { resultId: call.result.resultId }),
  }));
  return new Error(`${message}\nCompleted nested calls before failure (do not repeat these effects): ${jsonStringify(ledger, 'Completed nested calls')}`);
}

const RESULT_MANIFEST_LIMIT = 20;

function reusableResults(completed: readonly CompletedNestedCall[]): CodeModeResultReference[] {
  return completed
    .flatMap(call => call.result ? [call.result] : [])
    .sort((left, right) => right.completedAt - left.completedAt || right.resultId.localeCompare(left.resultId))
    .slice(0, RESULT_MANIFEST_LIMIT);
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

interface CompiledCodeModeProgram {
  code: string;
  sourceMap: string;
}

class CodeModeGuestError extends Error {
  constructor(message: string, readonly code: 'tool_execution' | 'result_access' | 'runtime_error') {
    super(message);
    this.name = 'CodeModeGuestError';
  }
}

const compiledCodeCache = new Map<string, CompiledCodeModeProgram>();
const MAX_COMPILED_CACHE_ENTRIES = 128;

function instrumentCodeModeSource(
  source: string,
  locations: readonly CodeModeSourceLocation[],
  locationVariable: string,
): string {
  const edits = locations.flatMap(location => [
    { position: location.start, text: `(${locationVariable} = "${location.line}:${location.column}", (` },
    { position: location.end, text: '))' },
  ]).sort((left, right) => right.position - left.position || right.text.length - left.text.length);
  let instrumented = source;
  for (const edit of edits) {
    instrumented = instrumented.slice(0, edit.position) + edit.text + instrumented.slice(edit.position);
  }
  return instrumented;
}

async function compileTypeScript(
  source: string,
  locations: readonly CodeModeSourceLocation[],
): Promise<CompiledCodeModeProgram> {
  let locationVariable = '__agentuseLocation';
  while (source.includes(locationVariable)) locationVariable += '_';
  const instrumented = instrumentCodeModeSource(source, locations, locationVariable);
  const key = createHash('sha256').update(instrumented).digest('hex');
  const cached = compiledCodeCache.get(key);
  if (cached) {
    compiledCodeCache.delete(key);
    compiledCodeCache.set(key, cached);
    return cached;
  }

  // QuickJS native async errors report the enclosing function rather than the
  // throwing expression. Preflight therefore instruments expression roots and
  // the wrapper carries that submitted-source location into the error.
  const wrapped = `(async function () { let ${locationVariable} = "1:1"; try {\n${instrumented}\n} catch (__agentuseError) {\n` +
    `  if (__agentuseError && (typeof __agentuseError === "object" || typeof __agentuseError === "function")) {\n` +
    `    const __agentuseMessage = String(__agentuseError.message || __agentuseError);\n` +
    `    throw new Error("__AGENTUSE_ERROR_ENVELOPE__" + JSON.stringify({ message: __agentuseMessage, location: ${locationVariable}, stack: String(__agentuseError.stack || "") }));\n` +
    `  }\n  throw __agentuseError;\n} })()`;
  const compiled = await transform(wrapped, {
    loader: 'ts',
    target: 'es2022',
    // Keep native async frames so runtime failures map back to the submitted
    // TypeScript line. Nested tool promises still use TrackedPromise below,
    // which owns unhandled nested-call detection independently.
    format: 'esm',
    sourcemap: 'external',
    sourcefile: 'agentuse-code-mode:wrapped.ts',
    legalComments: 'none',
  });
  const program = { code: compiled.code, sourceMap: compiled.map };
  compiledCodeCache.set(key, program);
  if (compiledCodeCache.size > MAX_COMPILED_CACHE_ENTRIES) {
    const oldest = compiledCodeCache.keys().next();
    if (!oldest.done) compiledCodeCache.delete(oldest.value);
  }
  return program;
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

function throwGuestError(
  context: QuickJSContext,
  errorHandle: QuickJSHandle,
  sourceMap?: string,
): never {
  const dumped = context.dump(errorHandle);
  const rawMessage = safeErrorMessage(dumped);
  const envelopeMarker = '__AGENTUSE_ERROR_ENVELOPE__';
  let message = rawMessage;
  let parsedSourceLocation: string | undefined;
  let stack: string | undefined;
  if (rawMessage.startsWith(envelopeMarker)) {
    try {
      const envelope = JSON.parse(rawMessage.slice(envelopeMarker.length)) as {
        message?: unknown;
        location?: unknown;
        stack?: unknown;
      };
      if (typeof envelope.message === 'string') message = envelope.message;
      if (typeof envelope.location === 'string') parsedSourceLocation = envelope.location;
      if (typeof envelope.stack === 'string') stack = envelope.stack;
    } catch {
      // Preserve the raw QuickJS diagnostic if the envelope is malformed.
    }
  }
  const sourceLocation = parsedSourceLocation && /^\d+:\d+$/.test(parsedSourceLocation)
    ? parsedSourceLocation
    : undefined;
  stack ??= dumped && typeof dumped === 'object' && typeof (dumped as { stack?: unknown }).stack === 'string'
    ? (dumped as { stack: string }).stack
    : undefined;
  const mappedStack = stack && sourceMap ? mapCodeModeStack(stack, sourceMap) : stack;
  const locationFrame = sourceLocation ? `at <anonymous> (agentuse-code-mode:user.ts:${sourceLocation})` : undefined;
  const trace = locationFrame ?? mappedStack?.trim();
  const toolErrorMarker = '__AGENTUSE_TOOL_ERROR__';
  const resultErrorMarker = '__AGENTUSE_RESULT_ERROR__';
  const isToolError = message.startsWith(toolErrorMarker);
  const isResultError = message.startsWith(resultErrorMarker);
  const cleanMessage = isToolError
    ? message.slice(toolErrorMarker.length)
    : isResultError
      ? message.slice(resultErrorMarker.length)
      : message;
  throw new CodeModeGuestError(
    `Code Mode failed: ${cleanMessage}${trace ? `\n${trace}` : ''}`,
    isToolError ? 'tool_execution' : isResultError ? 'result_access' : 'runtime_error',
  );
}

function classifyCodeModeError(error: unknown, signal: AbortSignal): CodeModeErrorCode {
  if (error instanceof CodeModeExecutionError) return error.code;
  if (error instanceof CodeModeGuestError) return error.code;
  const message = safeErrorMessage(error).toLowerCase();
  if (message.includes('timed out')) return 'timeout';
  if (message.includes('output exceeds') || message.includes('size limit')) return 'output_limit_exceeded';
  if (message.includes('typescript preflight') || message.includes('source exceeds') || message.includes('dynamic code')) return 'invalid_input';
  if (message.includes('nested tool') || message.includes("result from '") || error instanceof ToolDispatchPostEffectError) return 'tool_execution';
  if (message.startsWith('code mode failed:')) return 'runtime_error';
  if (signal.aborted && !safeErrorMessage(signal.reason).includes('execution finished')) return 'aborted';
  if (message.includes('quickjs') || message.includes('guest heap')) return 'runtime_unavailable';
  return 'internal_error';
}

function serializedSize(value: unknown, label: string): { chars: number; bytes: number } {
  const serialized = jsonStringify(value, label);
  return { chars: serialized.length, bytes: Buffer.byteLength(serialized, 'utf8') };
}

function fitCodeModeOutput(
  value: unknown,
  output: readonly CodeModeOutputEntry[],
  limit: number,
  valuePresent = true,
): { output?: CodeModeOutputEntry[]; valueBytes: number; outputBytes: number } {
  const valueSize = valuePresent ? serializedSize(value, 'Code Mode output') : { chars: 0, bytes: 0 };
  if (valueSize.chars > limit) {
    throw new Error(`Code Mode output exceeds ${limit.toLocaleString('en-US')} characters`);
  }
  let remaining = Math.max(0, limit - valueSize.chars - 256);
  let outputBytes = 0;
  const kept: CodeModeOutputEntry[] = [];
  let omittedEntries = 0;
  let omittedBytes = 0;
  for (const entry of output) {
    const size = serializedSize(entry, 'Code Mode emitted output');
    if (size.chars <= remaining) {
      kept.push(entry);
      remaining -= size.chars;
      outputBytes += size.bytes;
    } else {
      omittedEntries++;
      omittedBytes += size.bytes;
    }
  }
  if (omittedEntries > 0) {
    while (true) {
      const marker: CodeModeOutputEntry = {
        type: 'text',
        text: `[output truncated: ${omittedEntries} entries, ${omittedBytes} bytes omitted]`,
      };
      const markerSize = serializedSize(marker, 'Code Mode truncation marker');
      if (markerSize.chars <= remaining) {
        kept.push(marker);
        outputBytes += markerSize.bytes;
        break;
      }
      const removed = kept.pop();
      if (!removed) break;
      const removedSize = serializedSize(removed, 'Code Mode emitted output');
      remaining += removedSize.chars;
      outputBytes -= removedSize.bytes;
      omittedEntries++;
      omittedBytes += removedSize.bytes;
    }
  }
  return { ...(kept.length > 0 && { output: kept }), valueBytes: valueSize.bytes, outputBytes };
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

/** Execute model-authored TypeScript and retain its structured diagnostics. */
export async function executeCodeModeDetailed(
  source: string,
  options: CodeModeOptions,
): Promise<CodeModeCompletedResult> {
  const executionStartedAt = Date.now();
  const limits: CodeModeLimits = { ...DEFAULT_CODE_MODE_LIMITS, ...options.limits };
  const catalogSize = codeModeEligibleToolNames(options.toolNames).length;
  let callCount = 0;
  let resultReadCount = 0;
  let resultReadBytes = 0;
  let resultGrepCount = 0;
  let resultJqCount = 0;
  let resultQueryBytes = 0;
  let capturedOutput: CodeModeOutputEntry[] = [];
  const completedCalls: CompletedNestedCall[] = [];
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
  const asExecutionError = (error: unknown): CodeModeExecutionError => {
    if (error instanceof CodeModeExecutionError) return error;
    const cause = partialEffectsError(error, completedCalls);
    const fitted = fitCodeModeOutput(undefined, capturedOutput, limits.outputChars, false);
    const reusable = reusableResults(completedCalls);
    return new CodeModeExecutionError({
      status: 'failed',
      error: { code: classifyCodeModeError(error, signal), message: cause.message },
      ...(fitted.output && { output: fitted.output }),
      ...(reusable.length > 0 && { reusableResults: reusable }),
      telemetry: {
        catalogSize,
        nestedCalls: callCount,
        durationMs: Date.now() - executionStartedAt,
        valueBytes: 0,
        outputBytes: fitted.outputBytes,
        outputEntries: fitted.output?.length ?? 0,
        resultReads: resultReadCount,
        resultReadBytes,
        resultGreps: resultGrepCount,
        resultJqQueries: resultJqCount,
        resultQueryBytes,
      },
    }, { cause });
  };

  let runtime: ReturnType<Awaited<ReturnType<typeof getQuickJS>>['newRuntime']>;
  let context: QuickJSContext;
  let releaseRuntime: (() => void) | undefined;
  const runBudget = options.runBudget ?? new CodeModeRunBudget(limits);
  try {
    if (source.length > limits.sourceChars) {
      throw new Error(`Code Mode source exceeds ${limits.sourceChars.toLocaleString('en-US')} characters`);
    }
    // Reserve before any host-side preflight so sibling code_exec calls cannot
    // multiply TypeScript/compiler work while waiting for a guest heap.
    releaseRuntime = await runBudget.acquireRuntime(limits.memoryBytes, signal);
    const eligible = codeModeEligibleToolNames(options.toolNames);
    const eligibleSet = new Set(eligible);
    const catalogContracts = await raceWithAbort(
      options.loadContracts?.()
        ?? buildCodeModeToolContracts(options.toolDefinitions ?? {}, eligible),
      signal,
    );
    throwIfAborted();
    let sourceLocations: CodeModeSourceLocation[] = [];
    if (options.typecheck !== false) {
      const declarations: string = options.declarations
        ?? await raceWithAbort(
          options.loadDeclarations?.() ?? Promise.resolve(codeModeDeclarations(catalogContracts)),
          signal
        );
      throwIfAborted();
      sourceLocations = (await typecheckCodeMode(source, declarations, limits.memoryBytes, signal)).locations;
      throwIfAborted();
    }
    const compiled = await raceWithAbort(compileTypeScript(source, sourceLocations), signal);
    throwIfAborted();
    const quickJS = await raceWithAbort(getQuickJS(), signal);
    throwIfAborted();
    runtime = quickJS.newRuntime();
    runtime.setMemoryLimit(limits.memoryBytes);
    runtime.setMaxStackSize(limits.maxStackBytes);
    runtime.setInterruptHandler(() => signal.aborted || Date.now() >= deadline);
    context = runtime.newContext();
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
        | { kind: 'binary'; completed: CompletedNestedCall }
        | { kind: 'serialized'; serialized: string; completed: CompletedNestedCall }
        | { kind: 'unavailable'; error: unknown } => {
        const inspection = inspectBinaryMedia(output);
        if (inspection.binary) {
          markEffectRecorded();
          const completed: CompletedNestedCall = {
            callId,
            toolName,
            input: ledgerPreview(inputJson),
            output: '[binary media omitted]',
          };
          completedCalls.push(completed);
          return { kind: 'binary', completed };
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
        const completed: CompletedNestedCall = {
          callId,
          toolName,
          input: ledgerPreview(inputJson),
          output: serialized === undefined
            ? `[unavailable: ${safeErrorMessage(serializationError)}]`
            : ledgerPreview(serialized),
        };
        completedCalls.push(completed);
        return serialized === undefined
          ? { kind: 'unavailable', error: serializationError }
          : { kind: 'serialized', serialized, completed };
      };
      const notifyFinish = async (trace: NestedToolTrace): Promise<CodeModeResultReference | undefined> => {
        if (!options.onNestedToolFinish) return undefined;
        if (signal.aborted) throw abortError(signal);
        finishAttempted = true;
        return (await raceWithAbort(Promise.resolve(options.onNestedToolFinish(trace)), signal)) ?? undefined;
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
        const endedAt = Date.now();
        const resultBytes = Buffer.byteLength(serialized, 'utf8');
        const reusableResult = describeCodeModeResultFromSerialized({
          serializedInput: inputJson,
          serializedOutput: serialized,
          output,
          readable: serialized.length <= limits.resultCharsPerCall && resultBytes <= limits.resultReadBytes,
        });
        const resultReference = await notifyFinish({
          parentCallId: options.parentCallId,
          callId,
          toolName,
          input,
          output,
          ...(reusableResult && { reusableResult }),
          startedAt,
          endedAt,
        });
        if (resultReference) completion.completed.result = resultReference;
        if (serialized.length > limits.resultCharsPerCall) {
          throw new Error(`Result from '${toolName}' exceeds the per-call Code Mode size limit`);
        }
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

  const resultBridge = context.newFunction('__agentuseResult', (operationHandle, argumentHandle) => {
    const deferred = context.newPromise();
    pendingDeferreds.add(deferred);
    const operationName = context.getString(operationHandle);
    const argument = context.getString(argumentHandle);
    const operation = (async () => {
      try {
        let value: unknown;
        const isDataAccess = operationName === 'read' || operationName === 'grep' || operationName === 'jq';
        if (isDataAccess && resultReadCount + resultGrepCount + resultJqCount >= limits.resultReads) {
          throw new Error(`RESULT_TOO_LARGE: Code Mode permits at most ${limits.resultReads} result operations per program`);
        }
        if (operationName === 'list') {
          value = options.resultAccess ? await options.resultAccess.list(50) : [];
        } else if (operationName === 'read') {
          if (!options.resultAccess) {
            throw new Error('RESULTS_UNAVAILABLE: this Code Mode invocation has no durable session');
          }
          value = await options.resultAccess.read(argument);
        } else if (operationName === 'grep') {
          if (!options.resultAccess?.grep) {
            throw new Error('RESULTS_UNAVAILABLE: text result search is unavailable for this Code Mode invocation');
          }
          const request = JSON.parse(argument) as { resultId?: unknown; options?: unknown };
          if (typeof request.resultId !== 'string') throw new Error('RESULT_GREP_INPUT: resultId must be a string');
          value = await options.resultAccess.grep(request.resultId, request.options as CodeModeGrepOptions);
        } else if (operationName === 'jq') {
          if (!options.resultAccess?.jq) {
            throw new Error('RESULTS_UNAVAILABLE: JSON result querying is unavailable for this Code Mode invocation');
          }
          const request = JSON.parse(argument) as { resultId?: unknown; expression?: unknown; options?: unknown };
          if (typeof request.resultId !== 'string') throw new Error('RESULT_JQ_INPUT: resultId must be a string');
          if (typeof request.expression !== 'string') throw new Error('RESULT_JQ_INPUT: expression must be a string');
          value = await options.resultAccess.jq(
            request.resultId,
            request.expression,
            request.options as CodeModeJqOptions,
            signal
          );
        } else {
          throw new Error(`RESULT_OPERATION_INVALID: unsupported results operation ${operationName}`);
        }

        const serialized = jsonStringify(value, 'Stored Code Mode result');
        if (isDataAccess) {
          const bytes = Buffer.byteLength(serialized, 'utf8');
          if (
            serialized.length > limits.resultCharsPerCall
            || resultReadBytes + resultQueryBytes + bytes > limits.resultReadBytes
          ) {
            throw new Error('RESULT_TOO_LARGE: stored result operation exceeds the Code Mode read budget');
          }
          if (operationName === 'read') {
            resultReadCount++;
            resultReadBytes += bytes;
          } else if (operationName === 'grep') {
            resultGrepCount++;
            resultQueryBytes += bytes;
          } else {
            resultJqCount++;
            resultQueryBytes += bytes;
          }
        }
        settlePromise(deferred, { value: serialized });
      } catch (error) {
        settlePromise(deferred, { error: safeErrorMessage(error) });
      } finally {
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
    context.setProp(context.global, '__agentuseResult', resultBridge);
    context.setProp(context.global, '__agentuseRecordUnhandled', recordUnhandled);
    context.setProp(context.global, '__agentuseMarkUnhandledObserved', markUnhandledObserved);
    const catalogDefinitions = catalogContracts.map(contract => ({
      name: contract.name,
      description: contract.description ?? '',
      input: contract.input,
      ...(contract.outputKnown && { output: contract.output }),
      declaration: codeModeVirtualDeclaration(contract),
    }));
    const preludeResult = context.evalCode(`
      (() => {
        const call = globalThis.__agentuseCall;
        const resultCall = globalThis.__agentuseResult;
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
        const catalogDefinitions = ${JSON.stringify(catalogDefinitions)};
        const output = [];
        let consoleUnits = 0;
        let consoleClosed = false;
        const consoleLimit = ${limits.consoleOutputChars};
        const inspect = (value, depth = 0, seen = new Set()) => {
          if (value === null || typeof value === 'number' || typeof value === 'boolean') return String(value);
          if (typeof value === 'string') return value.length <= 512 ? value : value.slice(0, 512) + '…';
          if (typeof value === 'undefined') return 'undefined';
          if (typeof value === 'function') return '[Function]';
          if (typeof value !== 'object') return String(value);
          if (seen.has(value)) return '[Circular]';
          if (depth >= 3) return Array.isArray(value) ? '[Array(' + value.length + ')]' : '[Object]';
          seen.add(value);
          try {
            if (value instanceof Error) return value.name + ': ' + value.message;
            const descriptors = Object.getOwnPropertyDescriptors(value);
            const keys = Object.keys(descriptors).slice(0, 50);
            const parts = keys.map((key) => {
              const descriptor = descriptors[key];
              return descriptor && 'value' in descriptor
                ? JSON.stringify(key) + ':' + inspect(descriptor.value, depth + 1, seen)
                : JSON.stringify(key) + ':[Accessor]';
            });
            const omitted = Object.keys(descriptors).length - keys.length;
            const body = parts.join(',') + (omitted > 0 ? ',… ' + omitted + ' more' : '');
            return Array.isArray(value) ? '[' + body + ']' : '{' + body + '}';
          } catch {
            return '[Uninspectable]';
          } finally {
            seen.delete(value);
          }
        };
        const emitText = (value) => { output.push({ type: 'text', text: inspect(value) }); };
        const emitJson = (value) => {
          const serialized = JSON.stringify(value);
          if (serialized === undefined) throw new TypeError('json() value must be JSON-serializable');
          output.push({ type: 'json', value: JSON.parse(serialized) });
        };
        const consoleWrite = (level, values) => {
          if (consoleClosed) return;
          let message = values.map((value) => inspect(value)).join(' ');
          if (level) message = '[' + level + '] ' + message;
          if (message.length > consoleLimit) message = message.slice(0, consoleLimit) + '…';
          if (consoleUnits + message.length > consoleLimit) {
            output.push({ type: 'text', text: '[console output truncated]' });
            consoleClosed = true;
            return;
          }
          consoleUnits += message.length;
          emitText(message);
        };
        Object.defineProperty(globalThis, 'text', { value: emitText, writable: false, configurable: false });
        Object.defineProperty(globalThis, 'json', { value: emitJson, writable: false, configurable: false });
        Object.defineProperty(globalThis, 'console', {
          value: Object.freeze({
            log: (...values) => consoleWrite('', values),
            info: (...values) => consoleWrite('info', values),
            warn: (...values) => consoleWrite('warn', values),
            error: (...values) => consoleWrite('error', values),
            debug: (...values) => consoleWrite('debug', values),
          }),
          writable: false,
          configurable: false,
        });
        Object.defineProperty(globalThis, '__agentuseTakeOutput', {
          value: () => output.slice(),
          writable: false,
          configurable: false,
        });
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
        const catalogDefinitionByName = new Map(catalogDefinitions.map((definition) => [definition.name, definition]));
        const entries = names.map((name) => {
          const definition = catalogDefinitionByName.get(name) || {
            name,
            description: '',
            input: 'unknown',
            declaration: '/** AgentUse tool: ' + name + ' */\\ndeclare const tool: (input?: unknown) => Promise<unknown>;',
          };
          const invoke = (input = {}) => new TrackedPromise((resolve, reject) => {
            call(name, JSON.stringify(input)).then((envelope) => {
              try {
                const payload = JSON.parse(envelope);
                if (!payload.ok) { reject(new Error('__AGENTUSE_TOOL_ERROR__' + payload.error)); return; }
                resolve(JSON.parse(payload.value));
              } catch (error) { reject(error); }
            }, reject);
          });
          const metadata = Object.freeze({
            name,
            description: definition.description,
            input: definition.input,
            ...(definition.output !== undefined ? { output: definition.output } : {}),
          });
          Object.defineProperties(invoke, {
            name: { value: name, writable: false, configurable: false },
            description: { value: definition.description, writable: false, configurable: false },
            input: { value: definition.input, writable: false, configurable: false },
            output: { value: definition.output, writable: false, configurable: false },
            describe: {
              value: () => TrackedPromise.resolve(Object.freeze({ ...metadata, declaration: definition.declaration })),
              writable: false,
              configurable: false,
            },
            toJSON: { value: () => metadata, writable: false, configurable: false },
          });
          Object.freeze(invoke);
          return [name, invoke];
        });
        const handles = Object.freeze(entries.map(([, handle]) => handle));
        Object.defineProperty(globalThis, 'tools', {
          value: Object.freeze(Object.fromEntries(entries)),
          writable: false,
          configurable: false,
          enumerable: true,
        });
        Object.defineProperty(globalThis, 'catalog', {
          value: Object.freeze({
            search: (query, options = {}) => {
              if (typeof query !== 'string') return TrackedPromise.reject(new TypeError('catalog.search query must be a string'));
              const requestedLimit = options && options.limit !== undefined ? options.limit : 10;
              if (!Number.isInteger(requestedLimit) || requestedLimit < 1 || requestedLimit > 50) {
                return TrackedPromise.reject(new RangeError('catalog.search limit must be an integer from 1 to 50'));
              }
              const terms = query.trim().toLowerCase().split(/\\s+/).filter(Boolean);
              const matches = handles.filter((handle) => {
                const haystack = (handle.name + ' ' + handle.description).toLowerCase();
                return terms.every((term) => haystack.includes(term));
              }).slice(0, requestedLimit);
              return TrackedPromise.resolve(Object.freeze(matches));
            },
            all: () => handles,
          }),
          writable: false,
          configurable: false,
          enumerable: true,
        });
        const virtualDeclarations = new Map(catalogDefinitions.map((definition) => [
          'tools/' + definition.name + '.d.ts',
          definition.declaration,
        ]));
        Object.defineProperty(globalThis, 'API', {
          value: Object.freeze({
            list: (scope) => {
              if (scope !== 'tools') throw new Error('API.list supports only "tools"');
              return Array.from(virtualDeclarations.keys());
            },
            read: (path) => virtualDeclarations.get(path),
          }),
          writable: false,
          configurable: false,
          enumerable: true,
        });
        const invokeResult = (operation, argument = '') => new TrackedPromise((resolve, reject) => {
          resultCall(operation, argument).then((envelope) => {
            try {
              const payload = JSON.parse(envelope);
              if (!payload.ok) { reject(new Error('__AGENTUSE_RESULT_ERROR__' + payload.error)); return; }
              resolve(JSON.parse(payload.value));
            } catch (error) { reject(error); }
          }, reject);
        });
        Object.defineProperty(globalThis, 'results', {
          value: Object.freeze({
            read: (resultId) => {
              if (typeof resultId !== 'string' || resultId.length === 0) {
                return TrackedPromise.reject(new TypeError('results.read resultId must be a non-empty string'));
              }
              return invokeResult('read', resultId);
            },
            list: () => invokeResult('list'),
            grep: (resultId, options) => {
              if (typeof resultId !== 'string' || resultId.length === 0) {
                return TrackedPromise.reject(new TypeError('results.grep resultId must be a non-empty string'));
              }
              if (!options || typeof options !== 'object') {
                return TrackedPromise.reject(new TypeError('results.grep options must be an object'));
              }
              return invokeResult('grep', JSON.stringify({ resultId, options }));
            },
            jq: (resultId, expression, options = {}) => {
              if (typeof resultId !== 'string' || resultId.length === 0) {
                return TrackedPromise.reject(new TypeError('results.jq resultId must be a non-empty string'));
              }
              if (typeof expression !== 'string' || expression.length === 0) {
                return TrackedPromise.reject(new TypeError('results.jq expression must be a non-empty string'));
              }
              if (!options || typeof options !== 'object') {
                return TrackedPromise.reject(new TypeError('results.jq options must be an object'));
              }
              return invokeResult('jq', JSON.stringify({ resultId, expression, options }));
            },
          }),
          writable: false,
          configurable: false,
          enumerable: true,
        });
        delete globalThis.__agentuseCall;
        delete globalThis.__agentuseResult;
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

    const takeGuestOutput = (): CodeModeOutputEntry[] => {
      const taken = context.evalCode('globalThis.__agentuseTakeOutput()', 'agentuse-code-mode-output.js');
      if (taken.error) {
        taken.error.dispose();
        return [];
      }
      try {
        const value = context.dump(taken.value);
        return Array.isArray(value) ? value as CodeModeOutputEntry[] : [];
      } catch {
        return [];
      } finally {
        taken.value.dispose();
      }
    };

    const evaluation = context.evalCode(compiled.code, 'agentuse-code-mode:generated.js');
    if (evaluation.error) {
      capturedOutput = takeGuestOutput();
      try { throwGuestError(context, evaluation.error, compiled.sourceMap); }
      finally { evaluation.error.dispose(); }
    }
    promiseHandle = evaluation.value;
    settling = context.resolvePromise(promiseHandle);
    const initialJobs = runtime.executePendingJobs();
    let initialGuestJobFailure: string | undefined;
    if (initialJobs.error) {
      if (signal.aborted || Date.now() >= deadline) {
        promiseHandle.dispose();
        promiseHandle = undefined;
        initialJobs.error.dispose();
        throwIfAborted();
      }
      // QuickJS reports a rejected async job here before resolvePromise hands
      // us the program's final rejection. Keep it as a fallback; the settled
      // error includes the inner user frame retained by our wrapper.
      const dumped = context.dump(initialJobs.error);
      initialGuestJobFailure = safeErrorMessage(dumped);
      initialJobs.error.dispose();
    }
    const settled = await raceWithAbort(settling, signal);
    settling = undefined;
    promiseHandle?.dispose();
    promiseHandle = undefined;
    if (signal.aborted || Date.now() >= deadline) {
      if (settled.error) settled.error.dispose();
      else settled.value.dispose();
      throwIfAborted();
    }
    if (settled.error) {
      capturedOutput = takeGuestOutput();
      try { throwGuestError(context, settled.error, compiled.sourceMap); }
      finally { settled.error.dispose(); }
    }
    if (initialGuestJobFailure) {
      throw new Error(`Code Mode failed: ${initialGuestJobFailure}`);
    }
    const result = context.dump(settled.value);
    settled.value.dispose();
    await drainGuestOperations();
    throwIfAborted();
    if (unhandledNestedFailures.size > 0) {
      throw new Error(`Code Mode has unhandled nested tool failures: ${[...unhandledNestedFailures.values()].join('; ')}`);
    }
    capturedOutput = takeGuestOutput();
    const fitted = fitCodeModeOutput(result, capturedOutput, limits.outputChars);
    const reusable = reusableResults(completedCalls);
    return {
      status: 'completed',
      value: result,
      ...(fitted.output && { output: fitted.output }),
      ...(reusable.length > 0 && { reusableResults: reusable }),
      telemetry: {
        catalogSize,
        nestedCalls: callCount,
        durationMs: Date.now() - executionStartedAt,
        valueBytes: fitted.valueBytes,
        outputBytes: fitted.outputBytes,
        outputEntries: fitted.output?.length ?? 0,
        resultReads: resultReadCount,
        resultReadBytes,
        resultGreps: resultGrepCount,
        resultJqQueries: resultJqCount,
        resultQueryBytes,
      },
    };
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
    resultBridge.dispose();
    recordUnhandled.dispose();
    markUnhandledObserved.dispose();
    context.dispose();
    runtime.dispose();
  }
  } catch (error) {
    throw asExecutionError(error);
  }
  } catch (error) {
    throw asExecutionError(error);
  } finally {
    clearTimeout(timer);
    releaseRuntime?.();
  }
}

/** Backward-compatible low-level API used by tests and internal callers. */
export async function executeCodeMode(source: string, options: CodeModeOptions): Promise<unknown> {
  return (await executeCodeModeDetailed(source, options)).value;
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
  resultAccess?: CodeModeResultAccess;
}): Tool {
  const eligible = codeModeEligibleToolNames(options.toolNames);
  const promptContracts = buildCodeModeToolContractsSync(options.toolDefinitions ?? {}, eligible);
  const quickIndex = codeModeQuickIndex(promptContracts);
  const catalogSummary = `${eligible.length} ${eligible.length === 1 ? 'tool' : 'tools'}`;
  const runLimits: CodeModeLimits = { ...DEFAULT_CODE_MODE_LIMITS, ...options.limits };
  const runBudget = new CodeModeRunBudget(runLimits);
  // The catalog is fixed for the life of this tool, so resolve lazy schemas once
  // and share the contracts across preflight and guest discovery.
  let contractsPromise: Promise<CodeModeToolContract[]> | undefined;
  const loadContracts = (): Promise<CodeModeToolContract[]> => {
    contractsPromise ??= buildCodeModeToolContracts(options.toolDefinitions ?? {}, eligible)
      .catch(error => {
        contractsPromise = undefined;
        throw error;
      });
    return contractsPromise;
  };
  return {
    description:
      'Run isolated TypeScript for arithmetic, timestamps and duration math, percentages, basic string operations, deterministic loops, filtering, branching, batching, joins, and parallel tool calls. Call tools exposed under tools.<name> here, including when the program needs only one JSON tool call; most are deliberately hidden as top-level tools. Use it with zero tool calls for deterministic computation too; ' +
      'never do that math in prose, in your head, or in bash. When the user asks for a shell artifact, commands or scripts may contain the calculations the artifact itself needs; bash is forbidden only as private scratch space for working out an answer. Date, Math, JSON, and standard string methods are available and the clock is real. URL, Intl, locale-aware formatting, and host timezone services are unavailable. ' +
      'The program has no filesystem, network, environment, process, package, or import access. Dynamic code construction through eval or Function constructors is unavailable. ' +
      'Call permitted tools as await tools.<name>({ ... }) using the same input object as a direct tool call. A transport-sensitive tool may also remain separately visible for binary or provider-native result delivery. Await or return every async operation; detached async work is rejected during preflight. ' +
      'When a needed tool is absent from the quick index, use await catalog.search(query), call handle.describe(), or inspect API.list("tools") and API.read("tools/<name>.d.ts") in a first code_exec. Catalog handles are callable and use the same dispatch policy as tools.<name>. ' +
      'Completed JSON-serializable nested tool calls are recorded as same-session immutable results. The response lists recent reusableResults; use await results.list() to inspect each result kind and capabilities. Use await results.read(resultId) for bounded payloads, await results.grep(resultId, { pattern, limit, contextLines }) for literal text search, or await results.jq(resultId, expression, { limit }) for real jq queries over JSON, including oversized results. Reuse an earlier result only when its freshness is still valid. ' +
      'Return one JSON-serializable result. You may also emit multiple ordered, bounded progress entries with text(value), json(value), or console.log/info/warn/error/debug. ' +
      'Code is strictly type-checked before any nested tool starts. For `-> ?` outputs, do not guess fields: return one element and its keys, observe, then narrow with runtime checks in a later code_exec before dependent logic. ' +
      `Nested tool catalog: ${catalogSummary}.\n\n${quickIndex}`,
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
      try {
        return await executeCodeModeDetailed(code, {
          dispatcher: options.dispatcher,
          toolNames: eligible,
          ...(options.toolDefinitions && { toolDefinitions: options.toolDefinitions }),
          loadContracts,
          parentCallId: callOptions?.toolCallId ?? CODE_EXEC_TOOL,
          runBudget,
          limits: runLimits,
          ...(abortSignal && { abortSignal }),
          ...(options.onNestedToolStart && { onNestedToolStart: options.onNestedToolStart }),
          ...(options.onNestedToolFinish && { onNestedToolFinish: options.onNestedToolFinish }),
          ...(options.resultAccess && { resultAccess: options.resultAccess }),
        });
      } catch (error) {
        // The model-facing tool contract is always a structured result. Keep
        // executeCodeModeDetailed throwing for internal callers that need a
        // causal Error and the completed-effect ledger on its cause.
        if (error instanceof CodeModeExecutionError) return error.result;
        throw error;
      }
    },
  };
}
