import * as aiSdk from 'ai';
import type { Tool, ToolSet } from 'ai';
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
  /** The AI SDK already validates direct model calls before toolApproval. */
  validated?: boolean;
  /** Direct calls are clamped for model context; nested Code Mode calls are not. */
  modelFacing?: boolean;
  /** Direct calls run preflight through streamText.toolApproval. */
  preflighted?: boolean;
}

export interface ToolDispatcherOptions {
  effectWal?: EffectWAL;
  pluginEvents?: ToolDispatcherPluginEvents;
  abortSignal?: AbortSignal;
  writeToolOutputArtifact?: ToolOutputArtifactWriter;
  onPluginTerminate?(): void;
}

export class ToolDispatchDeniedError extends Error {
  readonly code = 'TOOL_DISPATCH_DENIED';

  constructor(message: string) {
    super(message);
    this.name = 'ToolDispatchDeniedError';
  }
}

function recordInput(input: unknown): Record<string, unknown> {
  return input && typeof input === 'object' && !Array.isArray(input)
    ? input as Record<string, unknown>
    : { value: input };
}

function pluginResultError(output: unknown): Error {
  if (output instanceof Error) return output;
  if (typeof output === 'string') return new Error(output);
  try {
    return new Error(JSON.stringify(output));
  } catch {
    return new Error(String(output));
  }
}

function combinedAbortSignal(...signals: Array<AbortSignal | undefined>): AbortSignal | undefined {
  const present = signals.filter((signal): signal is AbortSignal => signal !== undefined);
  if (present.length === 0) return undefined;
  if (present.length === 1) return present[0];
  return AbortSignal.any(present);
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

/**
 * One host-owned execution path for direct model tool calls and nested Code
 * Mode calls. Approval/gate ordering remains in streamText.toolApproval, but
 * both callers share validation, plugin preflight, WAL, execution, result
 * hooks, cancellation, and presentation policy through this dispatcher.
 */
export class ToolDispatcher {
  private readonly tools = new Map<string, Tool>();

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
    return [...this.tools.entries()]
      .filter(([, tool]) => typeof tool.execute === 'function' && !tool.needsApproval)
      .map(([name]) => name);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  /** Run plugin capability/policy checks before execution. */
  async preflight(options: {
    toolName: string;
    toolCallId: string;
    input: unknown;
    abortSignal?: AbortSignal;
  }): Promise<ToolCallEventResult> {
    const input = recordInput(options.input);
    const decision = await this.options.pluginEvents?.toolCall?.({
      toolCallId: options.toolCallId,
      toolName: options.toolName,
      input,
    }, combinedAbortSignal(this.options.abortSignal, options.abortSignal));
    if (decision?.terminate) this.options.onPluginTerminate?.();
    return decision ?? {};
  }

  /** Validate and execute a named tool for a nested runtime caller. */
  async dispatch(toolName: string, input: unknown, options: ToolDispatchOptions): Promise<unknown> {
    const tool = this.tools.get(toolName);
    if (!tool) throw new Error(`Unknown or unavailable tool '${toolName}'`);
    if (typeof tool.execute !== 'function') throw new Error(`Tool '${toolName}' is not executable`);

    let validatedInput = input;
    if (!options.validated) {
      const schema = aiSdk.asSchema(tool.inputSchema);
      if (schema.validate) {
        const validation = await schema.validate(input);
        if (!validation.success) {
          throw new Error(`Invalid input for tool '${toolName}': ${validation.error.message}`);
        }
        validatedInput = validation.value;
      }
    }

    const signal = combinedAbortSignal(this.options.abortSignal, options.abortSignal);
    if (signal?.aborted) throw signal.reason ?? new Error('Tool call aborted');

    if (!options.preflighted) {
      const decision = await this.preflight({
        toolName,
        toolCallId: options.toolCallId,
        input: validatedInput,
        ...(signal && { abortSignal: signal }),
      });
      if (decision.block) {
        throw new ToolDispatchDeniedError(
          decision.reason ?? `Tool '${toolName}' was blocked by a plugin`
        );
      }
    }

    const startedAt = Date.now();
    this.options.effectWal?.append({
      event: 'tool-start',
      callId: options.toolCallId,
      tool: toolName,
      input: sanitizeWALInput(validatedInput),
    });

    let output: unknown;
    let isError = false;
    try {
      output = await (tool.execute as (...args: any[]) => unknown)(validatedInput, {
        toolCallId: options.toolCallId,
        ...(signal && { abortSignal: signal }),
      });
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

    if (this.options.pluginEvents?.toolResult) {
      const next = await this.options.pluginEvents.toolResult({
        toolCallId: options.toolCallId,
        toolName,
        input: recordInput(validatedInput),
        output,
        isError,
      }, signal);
      output = next.output;
      isError = next.isError;
    }
    if (isError) throw pluginResultError(output);

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

  /** ToolSet handed to streamText. Input validation and preflight already ran. */
  modelTools(): ToolSet {
    return Object.fromEntries([...this.tools.entries()].map(([name, tool]) => [name, {
      ...tool,
      execute: typeof tool.execute !== 'function'
        ? tool.execute
        : (input: unknown, callOptions?: { toolCallId?: string; abortSignal?: AbortSignal }) =>
            this.dispatch(name, input, {
              toolCallId: callOptions?.toolCallId ?? 'unknown',
              ...(callOptions?.abortSignal && { abortSignal: callOptions.abortSignal }),
              validated: true,
              modelFacing: true,
              preflighted: true,
            }),
    }])) as ToolSet;
  }
}
