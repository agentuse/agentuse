import terminalSize from 'terminal-size';
import wrapAnsi from 'wrap-ansi';
import stringWidth from 'string-width';

export interface TerminalDimensions {
  columns: number;
  rows: number;
}

/**
 * Manages terminal dimensions and provides utilities for responsive output
 */
export class TerminalManager {
  private static instance: TerminalManager;
  private dimensions: TerminalDimensions;
  private resizeListeners: Array<(dimensions: TerminalDimensions) => void> = [];
  private resizeHandler: (() => void) | null = null;

  private constructor() {
    this.dimensions = this.detectDimensions();
    this.setupResizeListener();
  }

  static getInstance(): TerminalManager {
    if (!TerminalManager.instance) {
      TerminalManager.instance = new TerminalManager();
    }
    return TerminalManager.instance;
  }

  /**
   * Detect current terminal dimensions
   */
  private detectDimensions(): TerminalDimensions {
    try {
      const size = terminalSize();
      return {
        columns: size.columns || 80,
        rows: size.rows || 24,
      };
    } catch (error) {
      // Fallback to common defaults if detection fails
      return { columns: 80, rows: 24 };
    }
  }

  /**
   * Setup listener for terminal resize events
   */
  private setupResizeListener(): void {
    if (!process.stdout.isTTY) {
      return;
    }

    this.resizeHandler = () => {
      const newDimensions = this.detectDimensions();

      // Only trigger listeners if dimensions actually changed
      if (
        newDimensions.columns !== this.dimensions.columns ||
        newDimensions.rows !== this.dimensions.rows
      ) {
        this.dimensions = newDimensions;
        this.notifyListeners(newDimensions);
      }
    };

    process.stdout.on('resize', this.resizeHandler);
  }

  /**
   * Register a callback to be notified of terminal resize events
   */
  onResize(callback: (dimensions: TerminalDimensions) => void): void {
    this.resizeListeners.push(callback);
  }

  /**
   * Remove a resize listener
   */
  offResize(callback: (dimensions: TerminalDimensions) => void): void {
    const index = this.resizeListeners.indexOf(callback);
    if (index > -1) {
      this.resizeListeners.splice(index, 1);
    }
  }

  /**
   * Notify all listeners of dimension changes
   */
  private notifyListeners(dimensions: TerminalDimensions): void {
    for (const listener of this.resizeListeners) {
      try {
        listener(dimensions);
      } catch (error) {
        // Silently ignore listener errors to prevent cascading failures
      }
    }
  }

  /**
   * Get current terminal width
   */
  getWidth(): number {
    return this.dimensions.columns;
  }

  /**
   * Get current terminal height
   */
  getHeight(): number {
    return this.dimensions.rows;
  }

  /**
   * Get current terminal dimensions
   */
  getDimensions(): TerminalDimensions {
    return { ...this.dimensions };
  }

  /**
   * Wrap text to fit within terminal width with optional indent
   */
  wrap(text: string, options: { indent?: number; maxWidth?: number } = {}): string {
    const indent = options.indent || 0;
    const maxWidth = options.maxWidth || this.dimensions.columns;
    const effectiveWidth = Math.max(20, maxWidth - indent); // Minimum 20 chars

    const wrapped = wrapAnsi(text, effectiveWidth, { hard: true, trim: false });

    if (indent > 0) {
      const indentStr = ' '.repeat(indent);
      return wrapped
        .split('\n')
        .map(line => indentStr + line)
        .join('\n');
    }

    return wrapped;
  }

  /**
   * Truncate text to fit within a specific width, adding ellipsis if needed
   */
  truncate(text: string, maxWidth?: number, ellipsis = '...'): string {
    const width = maxWidth || this.dimensions.columns;
    const textWidth = stringWidth(text);

    if (textWidth <= width) {
      return text;
    }

    const ellipsisWidth = stringWidth(ellipsis);
    const targetWidth = width - ellipsisWidth;

    if (targetWidth <= 0) {
      return ellipsis.slice(0, width);
    }

    let result = '';
    let currentWidth = 0;

    for (const char of text) {
      const charWidth = stringWidth(char);
      if (currentWidth + charWidth > targetWidth) {
        break;
      }
      result += char;
      currentWidth += charWidth;
    }

    return result + ellipsis;
  }

  /**
   * Calculate the visual width of text (accounting for ANSI codes)
   */
  getTextWidth(text: string): number {
    return stringWidth(text);
  }

  /**
   * Check if we're in a TTY environment
   */
  isTTY(): boolean {
    return process.stdout.isTTY || false;
  }

  /**
   * Cleanup resources
   */
  destroy(): void {
    if (this.resizeHandler && process.stdout.isTTY) {
      process.stdout.off('resize', this.resizeHandler);
      this.resizeHandler = null;
    }
    this.resizeListeners = [];
  }
}

// Export singleton instance
export const terminalManager = TerminalManager.getInstance();
