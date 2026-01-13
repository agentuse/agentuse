/**
 * Doom Loop Detector
 *
 * Detects when an agent is stuck in a loop calling the same tool
 * with identical arguments repeatedly.
 */

export interface ToolCall {
  name: string;
  args: unknown;
}

export interface DoomLoopConfig {
  /** Maximum identical consecutive calls before triggering (default: 3) */
  threshold?: number;
  /** Action to take when loop detected: 'error' throws, 'warn' logs warning */
  action?: 'error' | 'warn';
}

export class DoomLoopDetector {
  private readonly threshold: number;
  private readonly action: 'error' | 'warn';
  private readonly history: ToolCall[] = [];
  private readonly maxHistorySize = 10;

  constructor(config: DoomLoopConfig = {}) {
    this.threshold = config.threshold ?? 3;
    this.action = config.action ?? 'error';
  }

  /**
   * Recursively sort object keys for consistent comparison
   * Handles nested objects and arrays
   */
  private sortDeep(obj: unknown): unknown {
    if (Array.isArray(obj)) {
      return obj.map(item => this.sortDeep(item));
    }
    if (obj !== null && typeof obj === 'object') {
      const sorted: Record<string, unknown> = {};
      for (const key of Object.keys(obj as Record<string, unknown>).sort()) {
        sorted[key] = this.sortDeep((obj as Record<string, unknown>)[key]);
      }
      return sorted;
    }
    return obj;
  }

  /**
   * Normalize arguments for comparison
   * Handles undefined, null, and deep object ordering
   */
  private normalizeArgs(args: unknown): string {
    if (args === undefined || args === null) {
      return 'null';
    }
    try {
      // Deep sort object keys for consistent comparison
      return JSON.stringify(this.sortDeep(args));
    } catch {
      return String(args);
    }
  }

  /**
   * Check if two tool calls are identical
   */
  private areIdentical(a: ToolCall, b: ToolCall): boolean {
    if (a.name !== b.name) return false;
    return this.normalizeArgs(a.args) === this.normalizeArgs(b.args);
  }

  /**
   * Count consecutive identical calls at the end of history
   */
  private countConsecutiveIdentical(): number {
    if (this.history.length < 2) return this.history.length;

    const latest = this.history[this.history.length - 1];
    let count = 1;

    for (let i = this.history.length - 2; i >= 0; i--) {
      if (this.areIdentical(this.history[i], latest)) {
        count++;
      } else {
        break;
      }
    }

    return count;
  }

  /**
   * Record a tool call and check for doom loop
   *
   * @param toolName Name of the tool being called
   * @param args Arguments passed to the tool
   * @returns Object with isLoop flag and count of consecutive identical calls
   * @throws Error if loop detected and action is 'error'
   */
  check(toolName: string, args: unknown): { isLoop: boolean; count: number } {
    const call: ToolCall = { name: toolName, args };

    // Add to history
    this.history.push(call);

    // Keep history bounded
    if (this.history.length > this.maxHistorySize) {
      this.history.shift();
    }

    // Check for consecutive identical calls
    const count = this.countConsecutiveIdentical();
    const isLoop = count >= this.threshold;

    if (isLoop) {
      const message = `Doom loop detected: ${toolName} called ${count} times with identical arguments`;

      if (this.action === 'error') {
        throw new DoomLoopError(message, toolName, args, count);
      } else {
        console.warn(`[DoomLoopDetector] ${message}`);
      }
    }

    return { isLoop, count };
  }

  /**
   * Reset the history (e.g., when starting a new task)
   */
  reset(): void {
    this.history.length = 0;
  }

  /**
   * Get the current history (for debugging)
   */
  getHistory(): readonly ToolCall[] {
    return this.history;
  }
}

/**
 * Error thrown when a doom loop is detected
 */
export class DoomLoopError extends Error {
  readonly toolName: string;
  readonly args: unknown;
  readonly count: number;

  constructor(message: string, toolName: string, args: unknown, count: number) {
    super(message);
    this.name = 'DoomLoopError';
    this.toolName = toolName;
    this.args = args;
    this.count = count;
  }
}
