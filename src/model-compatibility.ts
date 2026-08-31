import { getOpenCodeGoProtocol, OPENCODE_GO_PROVIDER_ID } from './providers/opencode-go';

/** AgentUse's stable reasoning vocabulary. Concrete models may support only a subset. */
export const REASONING_LEVELS = [
  'none',
  'minimal',
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const;

export type ReasoningLevel = (typeof REASONING_LEVELS)[number];
export type SDKReasoningLevel = Exclude<ReasoningLevel, 'max'>;

export interface ModelRouteCompatibility {
  /** False means each request must contain the complete conversation history. */
  supportsStore: boolean;
  /** Compatible Anthropic routes may replay unsigned thinking with an empty signature. */
  allowEmptyThinkingSignature?: boolean;
}

export interface ResolvedReasoningCompatibility {
  /** AI SDK's provider-agnostic option after model-level normalization. */
  reasoning?: SDKReasoningLevel;
  /** Native options for capabilities the AI SDK common enum cannot express. */
  providerOptions?: Record<string, Record<string, unknown>>;
}

export interface OpenAICompatibleCapabilities {
  supportsDeveloperRole?: boolean | undefined;
  supportsReasoningEffort?: boolean | undefined;
  supportsStore?: boolean | undefined;
  maxTokensField?: 'max_tokens' | 'max_completion_tokens' | undefined;
}

interface ModelIdentity {
  provider: string;
  model: string;
}

function parseModelIdentity(modelString: string): ModelIdentity {
  const separator = modelString.indexOf(':');
  if (separator === -1) return { provider: 'openai', model: modelString };
  return {
    provider: modelString.slice(0, separator),
    // Built-in model ids occupy the next segment. A third segment is an
    // AgentUse credential suffix rather than part of the model id.
    model: modelString.slice(separator + 1).split(':')[0],
  };
}

function isGPT56(model: string): boolean {
  return /^gpt-5\.6(?:-|$)/.test(model.split('/').at(-1) ?? model);
}

function isModernAdaptiveClaude(model: string): boolean {
  const normalized = model.toLowerCase().replaceAll('.', '-');
  if (!normalized.startsWith('claude-')) return false;
  return (
    /claude-(?:opus|sonnet)-4-(?:6|7|8)(?:-|$)/.test(normalized) ||
    /claude-(?:opus|sonnet|fable|mythos)-5(?:-|$)/.test(normalized)
  );
}

/**
 * Route-level request-shape capabilities. They intentionally remain separate
 * from base-model capabilities because one model can be exposed through
 * different protocols and retention policies by different providers.
 */
export function resolveModelRouteCompatibility(modelString: string): ModelRouteCompatibility {
  const { provider, model } = parseModelIdentity(modelString);
  if (
    provider === OPENCODE_GO_PROVIDER_ID &&
    getOpenCodeGoProtocol(model) === 'openai-responses'
  ) {
    // OpenCode Go Responses routes (notably Grok under ZDR) cannot depend on
    // provider-side response retention between tool turns.
    return { supportsStore: false };
  }
  if (provider === OPENCODE_GO_PROVIDER_ID && getOpenCodeGoProtocol(model) === 'anthropic') {
    return { supportsStore: true, allowEmptyThinkingSignature: true };
  }
  return { supportsStore: true };
}

/** Normalize confirmed model compatibility cases before sending a request. */
export function resolveReasoningCompatibility(
  modelString: string,
  requested: ReasoningLevel | undefined
): ResolvedReasoningCompatibility {
  if (!requested) return {};
  const { provider, model } = parseModelIdentity(modelString);

  // OpenRouter's unified API expects its own reasoning object rather than the
  // OpenAI-compatible reasoning_effort field. Keep this route-specific so the
  // same base model can still use its native provider's request shape.
  if (provider === 'openrouter') {
    if (requested === 'none') {
      return { providerOptions: { openrouter: { reasoning: { enabled: false } } } };
    }
    const effort = isGPT56(model) && requested === 'minimal' ? 'low' : requested;
    return { providerOptions: { openrouter: { reasoning: { effort } } } };
  }

  // GPT-5.6 removed `minimal`; low is the closest supported tier. The native
  // max tier is not yet represented by AI SDK 7's common reasoning enum.
  if (isGPT56(model)) {
    if (requested === 'minimal') return { reasoning: 'low' };
    if (requested === 'max') {
      return { providerOptions: { openai: { reasoningEffort: 'max' } } };
    }
    return { reasoning: requested };
  }

  // AI SDK handles minimal -> low and xhigh availability for adaptive Claude.
  // Its common enum stops at xhigh, so max needs native Anthropic options.
  if (provider === 'anthropic' && isModernAdaptiveClaude(model) && requested === 'max') {
    return {
      providerOptions: {
        anthropic: {
          thinking: { type: 'adaptive' },
          effort: 'max',
        },
      },
    };
  }

  // Unknown/legacy transports have no confirmed max wire value. Clamp to the
  // previous strongest AgentUse tier instead of sending an invalid parameter
  // or silently degrading to a provider's medium default.
  if (requested === 'max') return { reasoning: 'xhigh' };
  return { reasoning: requested };
}

/**
 * Preserve thinking blocks when replaying history to Anthropic-compatible
 * gateways that accept unsigned thinking. Native Anthropic is deliberately
 * excluded: it requires the original cryptographic signature.
 */
export function prepareThinkingReplay<T>(modelString: string, messages: T[]): T[] {
  if (!resolveModelRouteCompatibility(modelString).allowEmptyThinkingSignature) return messages;

  return messages.map((message: any) => {
    if (message?.role !== 'assistant' || !Array.isArray(message.content)) return message;
    let changed = false;
    const content = message.content.map((part: any) => {
      if (part?.type !== 'reasoning' || part.providerOptions?.anthropic?.signature != null) {
        return part;
      }
      changed = true;
      return {
        ...part,
        providerOptions: {
          ...(part.providerOptions ?? {}),
          anthropic: {
            ...(part.providerOptions?.anthropic ?? {}),
            signature: '',
          },
        },
      };
    });
    return changed ? { ...message, content } : message;
  });
}

/** Apply only explicitly configured deviations from the OpenAI-compatible baseline. */
export function transformOpenAICompatibleRequest(
  body: Record<string, unknown>,
  compatibility: OpenAICompatibleCapabilities
): Record<string, unknown> {
  const transformed = { ...body };
  if (compatibility.supportsReasoningEffort === false) delete transformed.reasoning_effort;
  if (compatibility.supportsStore === false) delete transformed.store;
  if (
    compatibility.maxTokensField === 'max_completion_tokens' &&
    transformed.max_tokens !== undefined
  ) {
    transformed.max_completion_tokens = transformed.max_tokens;
    delete transformed.max_tokens;
  }
  if (compatibility.supportsDeveloperRole === false && Array.isArray(transformed.messages)) {
    transformed.messages = transformed.messages.map((message: any) =>
      message?.role === 'developer' ? { ...message, role: 'system' } : message
    );
  }
  return transformed;
}
