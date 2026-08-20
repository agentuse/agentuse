import type { LanguageModelUsage } from 'ai';
import type { CompactionReason } from './session/types';
import { getModelInfo, type ModelInfo } from './utils/models-api';
import { redactMediaData, estimateInlineMediaTokens } from './tools/media';
import { logger } from './utils/logger';

// Constants
const DEFAULT_COMPACTION_THRESHOLD = 0.7; // 70% of context limit
const DEFAULT_KEEP_RECENT_MESSAGES = 3;   // Keep last 3 messages
const DEFAULT_CHARS_PER_TOKEN = 4;         // Conservative estimate (research shows 3-4 chars/token)
// Approval-gate compaction is window-relative by default (the shouldCompact() 70%
// path). The absolute floor below is opt-in via APPROVAL_COMPACTION_MIN_TOKENS;
// 0 = off. A non-zero default fired on near-empty large windows (64k ≈ 7% of a
// 922k window), folding ~90% of the context at a pause for no window-pressure
// reason. Set APPROVAL_COMPACTION_MIN_TOKENS to opt back into resend-cost mode.
const DEFAULT_BOUNDARY_COMPACTION_MIN_TOKENS = 0;

// Use any for message type to avoid complex type issues
type ModelMessage = any;

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

function positiveIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function ratioEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseFloat(raw);
  return Number.isFinite(parsed) && parsed > 0 && parsed < 1 ? parsed : fallback;
}

interface TrackedMessage {
  message: ModelMessage;
  estimatedTokens: number;
  actualTokens?: number;
}

/**
 * Per-message-object memo of the token estimate.
 *
 * `setMessages` re-estimates the entire transcript on every call and runs ~3x
 * per LLM step, while estimating one message deep-clones + stringifies each of
 * its parts. The AI SDK hands back the same message object references across
 * steps, so memoizing on identity turns a per-run quadratic into "estimate each
 * message once". Weak so compacted-away messages stay collectable, and shared
 * across instances because the estimate depends on nothing instance-local.
 *
 * Messages are treated as immutable here, but a caller swapping a message's
 * `content` would otherwise leave a stale count, so identity of the content
 * value (and its part count) is re-checked on every hit.
 */
const messageTokenCache = new WeakMap<object, { content: unknown; parts: number; tokens: number }>();

export interface ContextUsageStats {
  activeTokens: number;
  contextLimit?: number;
  usagePercentage: number;
  compacted: boolean;
  compactions: number;
  updatedAt: number;
}

export class ContextManager {
  private modelInfo: ModelInfo | null = null;
  private messages: TrackedMessage[] = [];
  private totalTokensUsed = 0;
  private compactionThreshold: number;
  private keepRecentMessages: number;
  private approvalCompactionMinTokens: number;
  private isCompacting = false;
  private compactions = 0;
  private compacted = false;
  // Tracked-message count right after the last compaction. Used to avoid
  // re-summarizing an unchanged transcript (which would summarize the summary):
  // a fresh compaction only runs once the transcript has grown past this.
  private lastCompactionSize = 0;
  // Calibration of the char/4 estimate against a real provider measurement.
  // `observedInputTokens` is the last per-step prompt size the provider
  // reported; `observedEstimateBaseline` is our raw estimate for that same set.
  // The difference captures fixed overhead the estimate misses (tool schemas,
  // wire formatting). See `activeContextTokens()`.
  private observedInputTokens: number | undefined;
  private observedEstimateBaseline = 0;

  constructor(
    private modelString: string,
    private onCompact?: (messages: ModelMessage[]) => Promise<ModelMessage>
  ) {
    // Read from environment variables
    this.compactionThreshold = ratioEnv('COMPACTION_THRESHOLD', DEFAULT_COMPACTION_THRESHOLD);
    this.keepRecentMessages = positiveIntEnv('COMPACTION_KEEP_RECENT', DEFAULT_KEEP_RECENT_MESSAGES);
    this.approvalCompactionMinTokens = nonNegativeIntEnv(
      'APPROVAL_COMPACTION_MIN_TOKENS',
      DEFAULT_BOUNDARY_COMPACTION_MIN_TOKENS
    );
  }

  /**
   * Initialize the context manager with model info
   */
  async initialize(): Promise<void> {
    this.modelInfo = await getModelInfo(this.modelString);
    logger.debug(`Context manager initialized for ${this.modelString}: limit=${this.modelInfo.contextLimit}, threshold=${this.compactionThreshold}`);
  }

  /**
   * Estimate tokens from text using character count
   */
  private estimateTokens(text: string): number {
    return Math.ceil(text.length / DEFAULT_CHARS_PER_TOKEN);
  }

  /**
   * Convert message to string for token estimation
   */
  private messageToString(message: ModelMessage): string {
    if (typeof message.content === 'string') {
      return message.content;
    }
    
    if (Array.isArray(message.content)) {
      return message.content
        .map((part: any) => {
          if (part && typeof part === 'object' && 'text' in part) return part.text;
          // Redact inline media base64 first so a tool-result image is not
          // stringified as ~megabytes of characters (see estimateTokens caller).
          return JSON.stringify(redactMediaData(part));
        })
        .join(' ');
    }

    return JSON.stringify(redactMediaData(message.content));
  }

  /**
   * Estimated token cost of one message, memoized on the message object.
   */
  private estimateMessageTokens(message: ModelMessage): number {
    // messageToString redacts inline media base64 to a short placeholder, so add
    // the media's real (approximate) token weight back rather than counting it as
    // ~zero. Base64 length is a ~1000x overestimate of an image's token cost.
    const compute = () => this.estimateTokens(this.messageToString(message)) + estimateInlineMediaTokens(message);

    if (!message || typeof message !== 'object') return compute();

    const content = message.content;
    const parts = Array.isArray(content) ? content.length : -1;
    const cached = messageTokenCache.get(message);
    if (cached && cached.content === content && cached.parts === parts) return cached.tokens;

    const tokens = compute();
    messageTokenCache.set(message, { content, parts, tokens });
    return tokens;
  }

  /**
   * Add a message and track its tokens
   */
  addMessage(message: ModelMessage): void {
    const estimatedTokens = this.estimateMessageTokens(message);

    this.messages.push({
      message,
      estimatedTokens
    });

    this.totalTokensUsed += estimatedTokens;
  }

  /**
   * Record provider usage details without replacing active-context accounting.
   *
   * AI SDK `usage`/`totalUsage` is billing/provider usage for a generation
   * step or whole run. It is not the same thing as the model-facing active
   * transcript we use for compaction decisions, because it may be incremental,
   * cumulative, cached, or provider-specific. Keep `totalTokensUsed` tied to
   * tracked messages so active context does not collapse to the most recent
   * provider step total.
   */
  updateUsage(usage: LanguageModelUsage, kind: 'cumulative' | 'step' = 'step'): void {
    if (this.messages.length > 0 && usage.outputTokens) {
      this.messages[this.messages.length - 1].actualTokens = usage.outputTokens;
    }

    // Calibrate from per-step usage only. A step's `inputTokens` is the real
    // size of the prompt that was just sent (the active context at that step);
    // cumulative `totalUsage.inputTokens` sums every step and would double-count
    // the carried prefix, so it is not a measure of active context.
    if (kind === 'step' && usage.inputTokens && usage.inputTokens > 0) {
      this.observedInputTokens = usage.inputTokens;
      this.observedEstimateBaseline = this.totalTokensUsed;
    }
  }

  /**
   * Best estimate of the active-context size in tokens.
   *
   * Starts from the char/4 estimate, then layers on the most recent real
   * provider measurement: `observedInputTokens` plus whatever the transcript has
   * grown by since (in estimate terms). This folds in fixed overhead the raw
   * estimate ignores (tool schemas, formatting) without a multiplicative blow-up.
   * When the transcript has shrunk below the measured baseline (a compaction or
   * a fresh resume), the stale measurement is dropped and the estimate is used.
   */
  private activeContextTokens(): number {
    const estimate = this.totalTokensUsed;
    if (this.observedInputTokens === undefined || estimate < this.observedEstimateBaseline) {
      return estimate;
    }
    const growthSinceObservation = estimate - this.observedEstimateBaseline;
    return Math.max(estimate, this.observedInputTokens + growthSinceObservation);
  }

  /**
   * Index where the preserved head ends (`messages.slice(0, headBoundary)`):
   * the leading run of system messages plus the first user message (the original
   * task). These are kept verbatim across compaction so the agent never loses
   * its instructions/persona or its task, and the cache prefix stays stable.
   */
  private headBoundary(): number {
    let head = 0;
    while (head < this.messages.length && this.messages[head].message?.role === 'system') {
      head++;
    }
    if (head < this.messages.length && this.messages[head].message?.role === 'user') {
      head++;
    }
    return head;
  }

  /**
   * Normalize the summarizer output into a single user message placed between
   * the preserved head and the recent tail. A user message (rather than a
   * mid-conversation system message, which some providers hoist or reject) keeps
   * the summary at the right position in history.
   */
  private asSummaryMessage(compacted: ModelMessage): ModelMessage {
    const content = typeof compacted.content === 'string'
      ? compacted.content
      : this.messageToString(compacted);
    return { role: 'user', content };
  }

  /**
   * Check if compaction is needed
   */
  shouldCompact(): boolean {
    if (!this.modelInfo || this.isCompacting) return false;

    const threshold = this.modelInfo.contextLimit * this.compactionThreshold;
    return this.activeContextTokens() >= threshold;
  }

  /**
   * Check whether a natural pause point, such as an approval gate, is worth
   * compacting even when the model window is not close to full. This targets
   * cumulative spend: a 70k-token active context may be safe for a 1M window
   * but expensive if it is resent after a human review. Runs between streams
   * (at suspension), so the compaction it triggers persists.
   */
  shouldCompactAtBoundary(): boolean {
    if (!this.modelInfo || this.isCompacting) return false;
    if (this.messages.length <= this.keepRecentMessages) return false;
    if (this.shouldCompact()) return true;
    return this.approvalCompactionMinTokens > 0 && this.activeContextTokens() >= this.approvalCompactionMinTokens;
  }

  /**
   * Token budget at which compaction should trigger (window * threshold).
   * Used by the stream loop's `stopWhen` predicate, which compares it against
   * the provider's real per-step token usage to end a segment for compaction.
   */
  compactionThresholdTokens(): number {
    if (!this.modelInfo) return Number.POSITIVE_INFINITY;
    return this.modelInfo.contextLimit * this.compactionThreshold;
  }

  /**
   * Get current usage percentage
   */
  getUsagePercentage(): number {
    if (!this.modelInfo) return 0;
    return (this.activeContextTokens() / this.modelInfo.contextLimit) * 100;
  }

  /**
   * Whether a message carries a tool result (provider `function_call_output`).
   * In AI SDK v6 these arrive as a dedicated `tool` role message, but some
   * shapes inline `tool-result` parts, so we check both.
   */
  private isToolResultMessage(message: ModelMessage): boolean {
    if (message?.role === 'tool') return true;
    if (Array.isArray(message?.content)) {
      return message.content.some((part: any) => part?.type === 'tool-result');
    }
    return false;
  }

  /**
   * Whether an assistant message issues a tool call (provider `function_call`).
   */
  private hasToolCall(message: ModelMessage): boolean {
    if (message?.role !== 'assistant' || !Array.isArray(message?.content)) return false;
    return message.content.some((part: any) => part?.type === 'tool-call');
  }

  /**
   * Pick the index where the kept tail begins (`messages.slice(index)`), never
   * severing an assistant tool-call from its tool-result. Folding the call into
   * the summary while keeping the result orphans the `function_call_output`, and
   * the OpenAI/Codex Responses API rejects the request with "No tool call found
   * for function call output with call_id ...". Walking the boundary backward
   * keeps the call alongside its result; it never drops a still-referenced
   * result. Returns < 1 when no safe boundary exists (nothing to fold in).
   */
  private safeSplitIndex(): number {
    let split = this.messages.length - this.keepRecentMessages;
    while (
      split > 0 &&
      (this.isToolResultMessage(this.messages[split].message) ||
        this.hasToolCall(this.messages[split - 1].message))
    ) {
      split--;
    }
    return split;
  }

  /**
   * Compact messages, keeping recent ones intact
   */
  async compact(reason?: CompactionReason): Promise<ModelMessage[]> {
    if (!this.onCompact || this.messages.length <= this.keepRecentMessages) {
      return this.messages.map(m => m.message);
    }

    // Already compacted and nothing new has been added since: re-running now
    // would just summarize the previous summary. Wait for the transcript to grow.
    if (this.compacted && this.messages.length <= this.lastCompactionSize) {
      return this.messages.map(m => m.message);
    }

    // Preserve a stable head verbatim: leading system messages (instructions /
    // persona) plus the original user task. These are never summarized, so the
    // agent keeps its instructions and the provider cache prefix stays stable.
    const headEnd = this.headBoundary();

    // Choose a split that does not orphan a tool-call/tool-result pair.
    let splitIndex = this.safeSplitIndex();

    // Forward-progress guarantee: if no safe split leaves a non-empty middle
    // between the head and the kept tail (e.g. the recent region is a single
    // unbreakable tool chain), summarize everything after the head rather than
    // no-opping. A silent no-op here lets a small window (e.g. 200k) overflow.
    if (splitIndex <= headEnd) {
      splitIndex = this.messages.length;
    }
    if (splitIndex <= headEnd) {
      // Nothing after the head to fold in.
      return this.messages.map(m => m.message);
    }

    const head = this.messages.slice(0, headEnd);
    const toCompact = this.messages.slice(headEnd, splitIndex);
    const toKeep = this.messages.slice(splitIndex);
    if (toCompact.length === 0) {
      return this.messages.map(m => m.message);
    }

    this.isCompacting = true;
    // Boundary (approval-gate) compaction can fire well below window pressure when
    // the absolute floor is opted into, so don't claim "approaching limit" there.
    const pct = this.getUsagePercentage().toFixed(0);
    logger.info(
      reason === 'approval'
        ? `Compacting agent context at approval gate (${pct}% of window in use)...`
        : `Context approaching limit (${pct}% used). Compacting agent context...`
    );

    try {
      const compactedMessage = await this.onCompact(toCompact.map(m => m.message));
      const summaryMessage = this.asSummaryMessage(compactedMessage);
      const summaryTokens = this.estimateTokens(this.messageToString(summaryMessage));

      // [ system… , original task ] + [ summary ] + [ recent tail ]
      this.messages = [
        ...head,
        { message: summaryMessage, estimatedTokens: summaryTokens },
        ...toKeep,
      ];

      this.totalTokensUsed = this.messages.reduce((sum, m) => sum + m.estimatedTokens, 0);
      // The provider measurement was taken against the pre-compaction transcript
      // and no longer applies; fall back to the estimate until the next sample.
      this.observedInputTokens = undefined;
      this.observedEstimateBaseline = 0;
      this.lastCompactionSize = this.messages.length;
      this.compactions++;
      this.compacted = true;

      logger.info('Context compacted successfully. Continuing...');

      return this.messages.map(m => m.message);
    } finally {
      this.isCompacting = false;
    }
  }

  /**
   * Get all messages
   */
  getMessages(): ModelMessage[] {
    return this.messages.map(m => m.message);
  }

  /**
   * Replace the tracked active context with messages supplied by the AI SDK for
   * the next model step. This keeps compaction decisions aligned with the real
   * model-facing transcript, including tool-call/tool-result ordering.
   */
  setMessages(messages: ModelMessage[]): void {
    this.messages = [];
    this.totalTokensUsed = 0;
    for (const message of messages) {
      this.addMessage(message);
    }
  }

  hasCompacted(): boolean {
    return this.compacted;
  }

  getStats(): ContextUsageStats {
    return {
      activeTokens: this.activeContextTokens(),
      ...(this.modelInfo?.contextLimit !== undefined && { contextLimit: this.modelInfo.contextLimit }),
      usagePercentage: this.getUsagePercentage(),
      compacted: this.compacted,
      compactions: this.compactions,
      updatedAt: Date.now(),
    };
  }

  /**
   * Check if compaction is enabled
   */
  static isEnabled(): boolean {
    return process.env.CONTEXT_COMPACTION !== 'false';
  }
}
