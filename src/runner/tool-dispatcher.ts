import * as aiSdk from 'ai';
import Ajv from 'ajv';
import addFormats from 'ajv-formats';
import type { Tool, ToolExecutionOptions, ToolSet } from 'ai';
import { isSuspendSignal } from './suspend';
import { sanitizeWALInput, type EffectWAL } from './effect-wal';
import { clampToolResultForModel } from '../tools/tool-output-limits.js';
import { logger } from '../utils/logger';
import { toErrorMessage } from '../utils/error-message';
import type {
  ModelToolOutputArtifactRef,
  ToolOutputArtifactRef,
} from '../session';
import type {
  ToolCallEvent,
  ToolCallEventResult,
  ToolResultEvent,
} from '../plugin/types';
import {
  codeModeOverloads,
  hasTrustedOutputSchema,
  markToolDispatchExecution,
  readPrevalidatedTrustedOutput,
  APPROVAL_RUNTIME_INPUT_SCHEMA,
  transportInputNormalizer,
} from '../tools/tool-contract';
import type { BashPermissionController } from './approval-lease';

export type ToolOutputArtifactWriter = (
  toolName: string,
  result: unknown
) => Promise<ToolOutputArtifactRef | undefined>;

export interface ToolDispatcherPluginEvents {
  toolCall?(event: ToolCallEvent, signal?: AbortSignal): Promise<ToolCallEventResult>;
  toolResult?(event: ToolResultEvent, signal?: AbortSignal): Promise<ToolResultEvent>;
}

export interface ToolDispatchOptions {
  toolCallId: string;
  abortSignal?: AbortSignal;
  /** Identifies calls crossing the sandbox bridge so host policy can apply. */
  origin?: 'direct' | 'code-mode';
  /** Host wait whose own tool timeout should not spend guest compute time. */
  pauseCodeModeTimeout?: () => () => void;
  /** Direct calls are clamped for model context; nested Code Mode calls are not. */
  modelFacing?: boolean;
  /** Execute the canonical input prepared by toolApproval. */
  preparedDirect?: boolean;
  /** Original AI SDK execution context for direct model calls. */
  executionOptions?: ToolExecutionOptions<unknown>;
}

export interface ToolDispatcherOptions {
  effectWal?: EffectWAL;
  pluginEvents?: ToolDispatcherPluginEvents;
  abortSignal?: AbortSignal;
  writeToolOutputArtifact?: ToolOutputArtifactWriter;
  bashPermission?: BashPermissionController;
  onPluginTerminate?(): void;
}

export class ToolDispatchDeniedError extends Error {
  readonly code = 'TOOL_DISPATCH_DENIED';

  constructor(message: string) {
    super(message);
    this.name = 'ToolDispatchDeniedError';
  }
}

/** Pre-effect input failed the tool's canonical runtime schema. */
export class ToolInputValidationError extends Error {
  readonly code = 'TOOL_INPUT_VALIDATION_ERROR';

  constructor(readonly toolName: string, validationMessage: string) {
    super(`Invalid input for tool '${toolName}': ${validationMessage}`);
    this.name = 'ToolInputValidationError';
  }
}

/** A tool effect completed, but dispatch could not safely return its result. */
export class ToolDispatchPostEffectError extends Error {
  readonly code = 'TOOL_DISPATCH_POST_EFFECT_ERROR';

  constructor(
    readonly toolName: string,
    readonly toolCallId: string,
    readonly output: unknown,
    cause: unknown,
  ) {
    // Do not retain an arbitrary plugin result here. A completed effect can
    // still carry a large binary/blob result through a plugin-marked error.
    // Keep a bounded diagnostic for abort and contract failures without making
    // the error object another route for that result to reach logs or history.
    const safeCause = postEffectCause(cause);
    super(`Tool '${toolName}' completed but its result could not be processed: ${safeCause.message}`, { cause: safeCause });
    this.name = 'ToolDispatchPostEffectError';
  }
}

function recordInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { value: input };
}

function plainJsonSnapshot(value: unknown, seen = new Set<object>()): string | undefined {
  if (value === null) return 'z:null';
  if (typeof value === 'string') return `s:${JSON.stringify(value)}`;
  if (typeof value === 'boolean') return `b:${value}`;
  if (typeof value === 'number') return Number.isFinite(value)
    ? (Object.is(value, -0) ? 'n:-0' : `n:${JSON.stringify(value)}`)
    : undefined;
  if (!value || typeof value !== 'object' || seen.has(value)) return undefined;
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      if (Object.getPrototypeOf(value) !== Array.prototype || Object.getOwnPropertySymbols(value).length) return undefined;
      const d = Object.getOwnPropertyDescriptors(value); const items: string[] = [];
      const lengthDescriptor = Object.getOwnPropertyDescriptor(value, 'length');
      if (!lengthDescriptor || !('value' in lengthDescriptor) || lengthDescriptor.value !== value.length
        || lengthDescriptor.enumerable || lengthDescriptor.configurable || lengthDescriptor.writable !== true
        || Object.keys(d).length !== value.length + 1) return undefined;
      for (let i = 0; i < value.length; i++) { const x = d[String(i)]; if (!x || !('value' in x) || !x.enumerable || !x.writable || !x.configurable) return undefined; const child = plainJsonSnapshot(x.value, seen); if (child === undefined) return undefined; items.push(child); }
      return `[${items.join(',')}]`;
    }
    if (Object.getPrototypeOf(value) !== Object.prototype || Object.getOwnPropertySymbols(value).length) return undefined;
    const entries: string[] = [];
    for (const key of Object.keys(Object.getOwnPropertyDescriptors(value)).sort()) { const x = Object.getOwnPropertyDescriptor(value, key)!; if (!('value' in x) || !x.enumerable || !x.writable || !x.configurable) return undefined; const child = plainJsonSnapshot(x.value, seen); if (child === undefined) return undefined; entries.push(`${JSON.stringify(key)}:${child}`); }
    return `{${entries.join(',')}}`;
  } finally { seen.delete(value); }
}

const POST_EFFECT_DIAGNOSTIC_LIMIT = 512;

function boundedDiagnostic(value: unknown, fallback: string): string {
  const message = value instanceof Error
    ? value.message
    : typeof value === 'string'
      ? value
      : fallback;
  if (message.length <= POST_EFFECT_DIAGNOSTIC_LIMIT) return message;
  return `${message.slice(0, POST_EFFECT_DIAGNOSTIC_LIMIT)} [truncated]`;
}

function postEffectCause(cause: unknown): Error {
  const error = new Error(boundedDiagnostic(cause, 'Tool result processing failed'));
  error.name = 'ToolDispatchPostEffectCauseError';
  return error;
}

function pluginResultError(output: unknown): Error {
  // Objects can contain an unbounded binary/blob payload. Preserve a concise
  // text diagnostic when one is deliberately supplied, but never stringify
  // arbitrary plugin output into an Error message.
  return new Error(boundedDiagnostic(output, 'Plugin marked the tool result as an error'));
}

function combinedAbortSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw signal.reason ?? new Error('Tool call aborted');
}

/** Await a lazy schema while still honoring a caller that has timed out. */
async function awaitAbortable<T>(value: PromiseLike<T> | T, signal: AbortSignal | undefined): Promise<T> {
  throwIfAborted(signal);
  if (!signal) return await value;
  return await new Promise<T>((resolve, reject) => {
    const abort = () => reject(signal.reason ?? new Error('Tool call aborted'));
    signal.addEventListener('abort', abort, { once: true });
    Promise.resolve(value).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

function modelToolOutputArtifactRef(artifact: ToolOutputArtifactRef): ModelToolOutputArtifactRef {
  return {
    kind: artifact.kind,
    path: artifact.path,
    bytes: artifact.bytes,
    originalChars: artifact.originalChars,
  };
}

function attachToolOutputArtifact(value: unknown, artifact: ToolOutputArtifactRef): unknown {
  const modelArtifact = modelToolOutputArtifactRef(artifact);
  if (typeof value === 'string') {
    return `${value}\n\n[Full tool output saved to session artifact: ${modelArtifact.path} (${modelArtifact.bytes} bytes).]`;
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    const objectValue = value as Record<string, unknown>;
    const metadata = objectValue.metadata && typeof objectValue.metadata === 'object' && !Array.isArray(objectValue.metadata)
      ? objectValue.metadata as Record<string, unknown>
      : {};
    return {
      ...objectValue,
      metadata: { ...metadata, fullOutputArtifact: modelArtifact },
    };
  }
  return { value, metadata: { fullOutputArtifact: modelArtifact } };
}

/** Keep provider-facing JSON Schema while deferring normalization to the dispatcher. */
function rawInputTransportSchema(
  inputSchema: Tool['inputSchema'],
  normalizeInput?: (input: unknown) => unknown,
): Tool['inputSchema'] {
  const original = aiSdk.asSchema(inputSchema);
  // JSON Schema describes the provider-facing input shape without running a
  // Zod/Standard transform. Ajv therefore preserves AI SDK repair behavior
  // while the dispatcher owns the one canonical normalization after plugins.
  const jsonSchema = original.jsonSchema;
  let validator: Promise<(value: unknown) => boolean> | undefined;
  return aiSdk.jsonSchema(jsonSchema, {
    validate: async value => {
      const transportInput = normalizeInput ? normalizeInput(value) : value;
      validator ??= Promise.resolve(jsonSchema).then((schema) => {
        // Ajv 8 intentionally ships without format validators. Keep the
        // provider-facing contract structural, but retain standard JSON Schema
        // formats so the SDK can repair malformed URI/UUID/etc. arguments.
        // `strict: false` leaves provider-specific custom formats non-fatal.
        const ajv = new Ajv({ allErrors: true, strict: false, logger: false });
        addFormats(ajv);
        return ajv.compile(schema as object) as (value: unknown) => boolean;
      });
      const validate = await validator;
      if (validate(transportInput)) return { success: true as const, value: transportInput };
      return {
        success: false as const,
        error: new Error(ajvErrorMessage((validate as any).errors)),
      };
    },
  }) as Tool['inputSchema'];
}

function ajvErrorMessage(errors: Array<{ instancePath?: string; dataPath?: string; message?: string }> | null | undefined): string {
  if (!errors || errors.length === 0) return 'input does not match the tool schema';
  return errors.map(error => `${error.instancePath || error.dataPath || '/'} ${error.message ?? 'is invalid'}`).join('; ');
}

/**
 * One host-owned execution path for direct model tool calls and nested Code
 * Mode calls. Approval/gate ordering remains in streamText.toolApproval, but
 * both callers share validation, plugin preflight, WAL, execution, result
 * hooks, cancellation, and presentation policy through this dispatcher.
 */
export class ToolDispatcher {
  private readonly tools = new Map<string, Tool>();
  private readonly preparedDirectCalls = new Map<string, Array<{ toolName: string; input: unknown }>>();

  constructor(tools: ToolSet, private readonly options: ToolDispatcherOptions = {}) {
    for (const [name, tool] of Object.entries(tools)) this.tools.set(name, tool as Tool);
  }

  register(name: string, tool: Tool): void {
    if (this.tools.has(name)) throw new Error(`Tool '${name}' is already registered`);
    this.tools.set(name, tool);
  }

  names(): string[] {
    return [...this.tools.keys()];
  }

  /** Tools with an AI SDK approval requirement must stay on the direct path. */
  codeModeToolNames(): string[] {
    return Object.keys(this.codeModeTools());
  }

  /** Effective executable definitions used to build Code Mode contracts. */
  codeModeTools(): Record<string, Tool> {
    return Object.fromEntries([...this.tools.entries()]
      .filter(([, tool]) => typeof tool.execute === 'function' && !tool.needsApproval)
    );
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  private async runPreflight(options: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    abortSignal?: AbortSignal;
  }): Promise<{ decision: ToolCallEventResult; input: unknown }> {
    const primitive = !options.input || typeof options.input !== 'object' || Array.isArray(options.input);
    const input = recordInput(options.input);
    const signal = combinedAbortSignal(this.options.abortSignal, options.abortSignal);
    const decision = await awaitAbortable(this.options.pluginEvents?.toolCall?.({
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      input,
    }, signal), signal);
    if (decision?.terminate) this.options.onPluginTerminate?.();
    return { decision: decision ?? {}, input: primitive ? input.value : options.input };
  }

  /** Run plugin capability/policy checks before execution. */
  async preflight(options: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    abortSignal?: AbortSignal;
  }): Promise<ToolCallEventResult> {
    return (await this.runPreflight(options)).decision;
  }

  /** Run plugin policy and expose the effective raw input before schema
   * normalization. Approval history signs this value, including primitive and
   * array edits transported through the plugin event's `{ value }` wrapper. */
  async preflightWithInput(options: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    abortSignal?: AbortSignal;
  }): Promise<{ decision: ToolCallEventResult; input: unknown }> {
    return this.runPreflight(options);
  }

  private async normalizeInput(toolName: string, input: unknown, signal: AbortSignal | undefined): Promise<unknown> {
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`Unknown or unavailable tool '${toolName}'`);
    // Resumed model transport uses the historical snapshot schema, but the
    // dispatcher must normalize with the current runtime schema. Otherwise a
    // fresh call after an approved resume silently loses current transforms.
    const schema = aiSdk.asSchema((tool as any)[APPROVAL_RUNTIME_INPUT_SCHEMA] ?? tool.inputSchema);
    if (!schema.validate) return input;
    const validation = await awaitAbortable(schema.validate(input), signal);
    if (!validation.success) {
      throw new ToolInputValidationError(toolName, validation.error.message);
    }
    return validation.value;
  }

  /** Preflight raw direct input and store its single canonical normalization. */
  async prepareDirectCall(options: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    abortSignal?: AbortSignal;
  }): Promise<{ normalizedInput: unknown; effectiveRawInput: unknown }> {
    const signal = combinedAbortSignal(this.options.abortSignal, options.abortSignal);
    throwIfAborted(signal);
    const preflight = await this.runPreflight({ ...options, ...(signal && { abortSignal: signal }) });
    const decision = preflight.decision;
    if (decision.block) {
      throw new ToolDispatchDeniedError(decision.reason ?? `Tool '${options.toolName}' was blocked by a plugin`);
    }
    throwIfAborted(signal);
    const normalizedInput = await this.normalizeInput(options.toolName, preflight.input, signal);
    const pending = this.preparedDirectCalls.get(options.toolCallId) ?? [];
    pending.push({ toolName: options.toolName, input: normalizedInput });
    this.preparedDirectCalls.set(options.toolCallId, pending);
    return { normalizedInput, effectiveRawInput: preflight.input };
  }

  private consumePreparedDirectCall(toolName: string, toolCallId: string): { found: boolean; input: unknown } {
    const pending = this.preparedDirectCalls.get(toolCallId);
    const prepared = pending?.[0];
    if (!prepared) return { found: false, input: undefined };
    if (prepared.toolName !== toolName) {
      throw new Error(`Prepared tool call '${toolCallId}' belongs to '${prepared.toolName}', not '${toolName}'`);
    }
    pending.shift();
    if (!pending.length) this.preparedDirectCalls.delete(toolCallId);
    return { found: true, input: prepared.input };
  }

  /** Forget the latest prepared direct call that approval decided not to execute. */
  discardPreparedDirectCall(toolCallId: string): void {
    const pending = this.preparedDirectCalls.get(toolCallId);
    pending?.pop();
    if (!pending?.length) this.preparedDirectCalls.delete(toolCallId);
  }

  /** Apply approval-time edits (such as an attached gate command) to execution. */
  replaceLatestPreparedDirectCall(toolName: string, toolCallId: string, input: unknown): void {
    const pending = this.preparedDirectCalls.get(toolCallId);
    const prepared = pending?.at(-1);
    if (!prepared || prepared.toolName !== toolName) return;
    prepared.input = input;
  }

  /** Restore a trusted, host-persisted canonical input for an approved resume. */
  seedPreparedDirectCall(toolName: string, toolCallId: string, input: unknown): void {
    const tool = this.tools.get(toolName);
    if (!tool || typeof tool.execute !== 'function') {
      throw new Error(`Cannot restore prepared input for unavailable executable tool '${toolName}'`);
    }
    const pending = this.preparedDirectCalls.get(toolCallId) ?? [];
    pending.push({ toolName, input });
    this.preparedDirectCalls.set(toolCallId, pending);
  }

  /** Validate and execute a named tool for a nested runtime caller. */
  async dispatch(toolName: string, input: unknown, options: ToolDispatchOptions): Promise<unknown> {
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`Unknown or unavailable tool '${toolName}'`);
    if (typeof tool.execute !== 'function') throw new Error(`Tool '${toolName}' is not executable`);

    const signal = combinedAbortSignal(this.options.abortSignal, options.abortSignal);
    throwIfAborted(signal);

    // Direct calls consume the approval callback's canonical input before any
    // lazy output contract can fail. Resume and unit paths that have no record
    // validate the supplied input once as a safe fallback.
    let validatedInput: unknown;
    if (options.preparedDirect) {
      const prepared = this.consumePreparedDirectCall(toolName, options.toolCallId);
      validatedInput = !prepared.found
        ? await this.normalizeInput(toolName, input, signal)
        : prepared.input;
    } else {
      const preflight = await this.runPreflight({
        toolName,
        toolCallId: options.toolCallId,
        input,
        ...(signal && { abortSignal: signal }),
      });
      if (preflight.decision.block) {
        throw new ToolDispatchDeniedError(preflight.decision.reason ?? `Tool '${toolName}' was blocked by a plugin`);
      }
      throwIfAborted(signal);
      validatedInput = await this.normalizeInput(toolName, preflight.input, signal);
    }

    if (this.options.bashPermission) {
      const decision = this.options.bashPermission.authorizeDispatch({
        toolName,
        toolCallId: options.toolCallId,
        origin: options.origin,
        input: validatedInput,
      });
      if (decision.block) {
        this.options.effectWal?.append({
          event: 'bash-permission-denied',
          callId: options.toolCallId,
          tool: toolName,
          input: sanitizeWALInput(validatedInput),
          ...(decision.reason && { reason: decision.reason }),
        });
        throw new ToolDispatchDeniedError(
          decision.reason ?? `Tool '${toolName}' is not permitted through Code Mode`
        );
      }
    }

    const outputContract = hasTrustedOutputSchema(tool)
      ? aiSdk.asSchema(tool.outputSchema)
      : undefined;
    if (outputContract) {
      try {
        // Force lazy schema conversion before plugin preflight or tool execution.
        // A malformed contract must never be discovered after a successful effect.
        await awaitAbortable(outputContract.jsonSchema, signal);
      } catch (error) {
        if (signal?.aborted) throw signal.reason ?? error;
        throw new Error(`Invalid output schema for tool '${toolName}': ${toErrorMessage(error)}`);
      }
      if (!outputContract.validate) {
        throw new Error(`Trusted output schema for tool '${toolName}' has no runtime validator`);
      }
    }

    // Select and validate the executable overload contract before the effect.
    // Declaration-only overloads may be printed for TypeScript, but they can
    // never choose a runtime result schema after a side effect has completed.
    let selectedOverload: ReturnType<typeof codeModeOverloads>[number] | undefined;
    let selectedOverloadContract: ReturnType<typeof aiSdk.asSchema> | undefined;
    if (outputContract) {
      for (const overload of codeModeOverloads(tool)) {
        const overloadInput = aiSdk.asSchema(overload.inputSchema);
        if (!overloadInput.validate) continue;
        const inputValidation = await awaitAbortable(overloadInput.validate(validatedInput), signal);
        if (!inputValidation.success) continue;
        selectedOverload = overload;
        selectedOverloadContract = aiSdk.asSchema(overload.outputSchema);
        try {
          await awaitAbortable(selectedOverloadContract.jsonSchema, signal);
        } catch (error) {
          if (signal?.aborted) throw signal.reason ?? error;
          throw new Error(`Invalid Code Mode overload output schema for tool '${toolName}': ${toErrorMessage(error)}`);
        }
        if (!selectedOverloadContract.validate) {
          throw new Error(`Code Mode overload for tool '${toolName}' has no runtime validator`);
        }
        break;
      }
    }

    // Keep this immediately adjacent to the effect boundary. This also covers
    // direct calls whose preflight was performed by streamText.toolApproval.
    throwIfAborted(signal);

    const startedAt = Date.now();
    this.options.effectWal?.append({
      event: 'tool-start',
      callId: options.toolCallId,
      tool: toolName,
      input: sanitizeWALInput(validatedInput),
    });

    let output: unknown;
    let rawOutput: unknown;
    let isError = false;
    let prevalidatedOutput = false;
    let prevalidatedValue: unknown;
    let effectCompleted = false;
    try {
      const executionOptions = markToolDispatchExecution({
        ...options.executionOptions,
        toolCallId: options.toolCallId,
        ...(signal && { abortSignal: signal }),
      });
      const releaseCodeModeTimeout = toolName === 'tools__bash'
        ? options.pauseCodeModeTimeout?.()
        : undefined;
      try {
        output = await (tool.execute as (...args: any[]) => unknown)(validatedInput, executionOptions);
      } finally {
        releaseCodeModeTimeout?.();
      }
      const prevalidated = readPrevalidatedTrustedOutput(output);
      if (prevalidated && prevalidated.schema === tool.outputSchema) {
        rawOutput = prevalidated.raw;
        // Result hooks observe the raw tool result. They may transform it, and
        // cached normalization is valid only if they leave that result alone.
        output = rawOutput;
        prevalidatedValue = prevalidated.value;
        prevalidatedOutput = true;
      } else {
        rawOutput = output;
      }
      effectCompleted = true;
      this.options.effectWal?.append({
        event: 'tool-end',
        callId: options.toolCallId,
        tool: toolName,
        ok: true,
        durationMs: Date.now() - startedAt,
      });
    } catch (error) {
      if (isSuspendSignal(error)) {
        this.options.effectWal?.append({
          event: 'tool-suspend',
          callId: options.toolCallId,
          tool: toolName,
          durationMs: Date.now() - startedAt,
        });
        throw error;
      }
      this.options.effectWal?.append({
        event: 'tool-error',
        callId: options.toolCallId,
        tool: toolName,
        error: toErrorMessage(error),
        durationMs: Date.now() - startedAt,
      });
      output = error;
      isError = true;
    }

    try {
    if (this.options.pluginEvents?.toolResult) {
      const previousOutput = output;
      const previousIsError = isError;
      const hookSnapshot = plainJsonSnapshot(output);
      const next = await awaitAbortable(this.options.pluginEvents.toolResult({
        toolCallId: options.toolCallId,
        toolName,
        input: recordInput(validatedInput),
        output,
        isError,
      }, signal), signal);
      output = next.output;
      isError = next.isError;
      // A result hook can replace the output, so its contract is always owned
      // by the dispatcher even when the execute wrapper validated its own one.
      // Hooks receive a mutable object. Descriptor-only and non-enumerable
      // edits are observable to arbitrary schemas but are not faithfully
      // represented by structuredClone/deep equality, so any hook invalidates
      // cached trusted normalization. A no-op hook still preserves externally
      // identical normalized output through ordinary validation.
      prevalidatedOutput = prevalidatedOutput
        && hookSnapshot !== undefined
        && next.output === previousOutput
        && next.isError === previousIsError
        && plainJsonSnapshot(next.output) === hookSnapshot;
      rawOutput = next.output;
    }
    if (isError) throw pluginResultError(output);

    if (outputContract?.validate) {
      // The full trusted schema remains the source of truth. When an overload
      // applies, validate both schemas against the raw result, then return only
      // the full-schema normalization so neither transform consumes the other.
      const fullValidation = prevalidatedOutput
        ? { success: true as const, value: prevalidatedValue }
        : await awaitAbortable(outputContract.validate(rawOutput), signal);
      if (!fullValidation.success) {
        // The effect already ran and `tool-end` truthfully says so. Record the
        // contract failure as its own event so audit and replay can tell "the
        // tool executed" apart from "the caller received a valid result".
        this.options.effectWal?.append({
          event: 'tool-contract-error',
          callId: options.toolCallId,
          tool: toolName,
          error: fullValidation.error.message,
        });
        throw new Error(
          `Tool '${toolName}' returned a value that does not match its output schema: ${fullValidation.error.message}`
        );
      }
      if (selectedOverload) {
        const overloadValidation = await awaitAbortable(selectedOverloadContract!.validate!(rawOutput), signal);
        if (!overloadValidation.success) {
          this.options.effectWal?.append({
            event: 'tool-contract-error',
            callId: options.toolCallId,
            tool: toolName,
            error: overloadValidation.error.message,
          });
          throw new Error(
            `Tool '${toolName}' returned a value that does not match the output selected by its input: ${overloadValidation.error.message}`
          );
        }
      }
      output = fullValidation.value;
    }
    } catch (error) {
      if (!effectCompleted) throw error;
      throw new ToolDispatchPostEffectError(
        toolName,
        options.toolCallId,
        '[tool output omitted after post-effect failure]',
        error,
      );
    }

    if (!options.modelFacing) return output;
    const clamped = clampToolResultForModel(output);
    if (!clamped.truncated) return clamped.value;

    logger.debug(`[ToolOutput] Truncated model-facing result for ${toolName}`);
    if (this.options.writeToolOutputArtifact) {
      try {
        const artifact = await this.options.writeToolOutputArtifact(toolName, output);
        if (artifact) return attachToolOutputArtifact(clamped.value, artifact);
      } catch (error) {
        logger.debug(`[ToolOutput] Failed to persist full result for ${toolName}: ${toErrorMessage(error)}`);
      }
    }
    return clamped.value;
  }

  /** ToolSet handed to streamText. It transports raw input into toolApproval. */
  modelTools(): ToolSet {
    return Object.fromEntries([...this.tools.entries()].map(([name, tool]) => [name, {
      ...tool,
      // Non-executable tools never reach dispatcher preparation, so retain
      // their original schema and AI SDK validation/repair behavior verbatim.
      inputSchema: typeof tool.execute === 'function'
        ? rawInputTransportSchema(tool.inputSchema, transportInputNormalizer(tool))
        : tool.inputSchema,
      execute: typeof tool.execute !== 'function'
        ? tool.execute
        : (input: unknown, callOptions?: ToolExecutionOptions<unknown>) =>
            this.dispatch(name, input, {
              toolCallId: callOptions?.toolCallId ?? 'unknown',
              ...(callOptions?.abortSignal && { abortSignal: callOptions.abortSignal }),
              ...(callOptions && { executionOptions: callOptions }),
              origin: 'direct',
              modelFacing: true,
              preparedDirect: true,
            }),
    }])) as ToolSet;
  }
}
