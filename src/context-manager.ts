import type { LanguageModelUsage } from 'ai';
import { getModelInfo, type ModelInfo } from './utils/models-api';
import { logger } from './utils/logger';

// Constants
const DEFAULT_COMPACTION_THRESHOLD = 0.7; // 70% of context limit
const DEFAULT_KEEP_RECENT_MESSAGES = 3;   // Keep last 3 messages
const DEFAULT_CHARS_PER_TOKEN = 4;         // Conservative estimate (research shows 3-4 chars/token)
const DEFAULT_BOUNDARY_COMPACTION_MIN_TOKENS = 64_000;
const DEFAULT_STEP_COMPACTION_MIN_TOKENS = 64_000;

// Use any for message type to avoid complex type issues
type ModelMessage = any;
type CompactionBoundary = 'approval' | 'step';

function nonNegativeIntEnv(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

interface TrackedMessage {
  message: ModelMessage;
  estimatedTokens: number;
  actualTokens?: number;
}

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
  private stepCompactionMinTokens: number;
  private isCompacting = false;
  private compactions = 0;
  private compacted = false;

  constructor(
    private modelString: string,
    private onCompact?: (messages: ModelMessage[]) => Promise<ModelMessage>
  ) {
    // Read from environment variables
    this.compactionThreshold = parseFloat(process.env.COMPACTION_THRESHOLD || String(DEFAULT_COMPACTION_THRESHOLD));
    this.keepRecentMessages = parseInt(process.env.COMPACTION_KEEP_RECENT || String(DEFAULT_KEEP_RECENT_MESSAGES));
    this.approvalCompactionMinTokens = nonNegativeIntEnv(
      'APPROVAL_COMPACTION_MIN_TOKENS',
      DEFAULT_BOUNDARY_COMPACTION_MIN_TOKENS
    );
    this.stepCompactionMinTokens = nonNegativeIntEnv(
      'STEP_COMPACTION_MIN_TOKENS',
      DEFAULT_STEP_COMPACTION_MIN_TOKENS
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
          if ('text' in part) return part.text;
          return JSON.stringify(part);
        })
        .join(' ');
    }
    
    return JSON.stringify(message.content);
  }

  /**
   * Add a message and track its tokens
   */
  addMessage(message: ModelMessage): void {
    const text = this.messageToString(message);
    const estimatedTokens = this.estimateTokens(text);
    
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
  updateUsage(usage: LanguageModelUsage, _kind: 'cumulative' | 'step' = 'step'): void {
    if (this.messages.length > 0 && usage.outputTokens) {
      this.messages[this.messages.length - 1].actualTokens = usage.outputTokens;
    }
  }

  /**
   * Check if compaction is needed
   */
  shouldCompact(): boolean {
    if (!this.modelInfo || this.isCompacting) return false;
    
    const threshold = this.modelInfo.contextLimit * this.compactionThreshold;
    return this.totalTokensUsed >= threshold;
  }

  /**
   * Check whether a natural pause point, such as an approval gate, is worth
   * compacting even when the model window is not close to full. This targets
   * cumulative spend: a 70k-token active context may be safe for a 1M window
   * but expensive if it is resent after a human review.
   */
  shouldCompactAtBoundary(boundary: CompactionBoundary = 'approval'): boolean {
    if (!this.modelInfo || this.isCompacting) return false;
    if (this.messages.length <= this.keepRecentMessages) return false;
    if (this.shouldCompact()) return true;
    const minTokens = boundary === 'step'
      ? this.stepCompactionMinTokens
      : this.approvalCompactionMinTokens;
    return minTokens > 0 && this.totalTokensUsed >= minTokens;
  }

  /**
   * Get current usage percentage
   */
  getUsagePercentage(): number {
    if (!this.modelInfo) return 0;
    return (this.totalTokensUsed / this.modelInfo.contextLimit) * 100;
  }

  /**
   * Compact messages, keeping recent ones intact
   */
  async compact(): Promise<ModelMessage[]> {
    if (
      !this.onCompact ||
      this.messages.length <= this.keepRecentMessages ||
      (this.compacted && this.messages.length <= this.keepRecentMessages + 1)
    ) {
      return this.messages.map(m => m.message);
    }

    this.isCompacting = true;
    logger.info(`Context approaching limit (${this.getUsagePercentage().toFixed(0)}% used). Compacting agent context...`);

    try {
      // Split messages into old (to compact) and recent (to keep)
      const toCompact = this.messages.slice(0, -this.keepRecentMessages);
      const toKeep = this.messages.slice(-this.keepRecentMessages);

      // Get messages to compact
      const messagesToCompact = toCompact.map(m => m.message);
      
      // Create compacted summary message
      const compactedMessage = await this.onCompact(messagesToCompact);
      
      // Rebuild message list with compacted message + recent messages
      const compactedTokens = this.estimateTokens(this.messageToString(compactedMessage));
      
      this.messages = [
        {
          message: compactedMessage,
          estimatedTokens: compactedTokens
        },
        ...toKeep
      ];

      // Recalculate total tokens
      this.totalTokensUsed = this.messages.reduce((sum, m) => sum + m.estimatedTokens, 0);
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
      activeTokens: this.totalTokensUsed,
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
