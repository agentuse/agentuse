import type { LanguageModelUsage } from 'ai';
import { getModelInfo, type ModelInfo } from './utils/models-api';
import { logger } from './utils/logger';

// Constants
const DEFAULT_COMPACTION_THRESHOLD = 0.7; // 70% of context limit
const DEFAULT_KEEP_RECENT_MESSAGES = 3;   // Keep last 3 messages
const DEFAULT_CHARS_PER_TOKEN = 4;         // Conservative estimate (research shows 3-4 chars/token)

// Use any for message type to avoid complex type issues
type ModelMessage = any;

interface TrackedMessage {
  message: ModelMessage;
  estimatedTokens: number;
  actualTokens?: number;
}

export class ContextManager {
  private modelInfo: ModelInfo | null = null;
  private messages: TrackedMessage[] = [];
  private totalTokensUsed = 0;
  private compactionThreshold: number;
  private keepRecentMessages: number;
  private isCompacting = false;

  constructor(
    private modelString: string,
    private onCompact?: (messages: ModelMessage[]) => Promise<ModelMessage>
  ) {
    // Read from environment variables
    this.compactionThreshold = parseFloat(process.env.COMPACTION_THRESHOLD || String(DEFAULT_COMPACTION_THRESHOLD));
    this.keepRecentMessages = parseInt(process.env.COMPACTION_KEEP_RECENT || String(DEFAULT_KEEP_RECENT_MESSAGES));
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
          if ('toolName' in part) return `Tool: ${part.toolName}`;
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
   * Update token count with actual usage from AI SDK
   */
  updateUsage(usage: LanguageModelUsage): void {
    if (usage.totalTokens) {
      // Update our total with actual tokens
      this.totalTokensUsed = usage.totalTokens;
      
      // Update the last message's actual tokens if available
      if (this.messages.length > 0 && usage.outputTokens) {
        this.messages[this.messages.length - 1].actualTokens = usage.outputTokens;
      }
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
    if (!this.onCompact || this.messages.length <= this.keepRecentMessages) {
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
   * Check if compaction is enabled
   */
  static isEnabled(): boolean {
    return process.env.CONTEXT_COMPACTION !== 'false';
  }
}