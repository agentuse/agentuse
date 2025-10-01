import chalk from 'chalk';
import readline from 'readline';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

/**
 * Simple spinner for animating in-progress operations
 */
class Spinner {
  private frames = ['⋮', '⋰', '⋯', '⋱'];
  private currentFrame = 0;
  private interval: NodeJS.Timeout | null = null;
  private isSpinning = false;
  private writeFn?: (line: string) => void;
  private getLineFn?: () => string;
  private baseLine: string | null = null;

  start(writeFn: (line: string) => void, getLineFn: () => string) {
    if (this.isSpinning) {
      return;
    }

    this.writeFn = writeFn;
    this.getLineFn = getLineFn;

    const baseLine = this.getLineFn?.();
    if (!this.writeFn || !baseLine) {
      this.writeFn = undefined;
      this.getLineFn = undefined;
      return;
    }
    this.baseLine = baseLine;
    this.isSpinning = true;
    this.interval = setInterval(() => {
      if (!this.writeFn || !this.baseLine) {
        return;
      }

      const frame = this.frames[this.currentFrame];
      this.currentFrame = (this.currentFrame + 1) % this.frames.length;
      const animatedLine = this.baseLine.replace(/^⋮/, frame);
      this.writeFn(animatedLine);
    }, 120);
  }

  stop() {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }

    if (this.isSpinning && this.writeFn && this.baseLine) {
      this.writeFn(this.baseLine);
    }

    this.writeFn = undefined;
    this.getLineFn = undefined;
    this.baseLine = null;
    this.isSpinning = false;
    this.currentFrame = 0;
  }

  isActive(): boolean {
    return this.isSpinning;
  }
}

/**
 * Format a warning message with tool context and error details
 * In debug mode, shows full error; otherwise shows shortened version
 */
export function formatWarning(tool: string, operation: string, error: string, enableDebug: boolean = false): string {
  if (enableDebug) {
    // In debug mode, show full error with additional context
    const lines = error.split('\n');
    const mainError = lines[0].replace(/^Error:\s*/i, '').trim();
    
    let formatted = `${tool}: ${operation} failed - ${mainError}`;
    
    // Add additional lines if they exist and are meaningful
    if (lines.length > 1) {
      const additionalInfo = lines.slice(1)
        .map(line => line.trim())
        .filter(line => line.length > 0 && !line.match(/^\s*at\s+/)) // Skip stack trace lines
        .slice(0, 3) // Limit to first 3 meaningful lines
        .join(' | ');
      
      if (additionalInfo) {
        formatted += ` (${additionalInfo})`;
      }
    }
    
    return formatted;
  } else {
    // Normal mode: Take first line, remove common "Error:" prefix, trim whitespace, cap at 80 chars
    const cleanError = error
      .split('\n')[0]
      .replace(/^Error:\s*/i, '')
      .trim()
      .substring(0, 80);
    
    const reason = cleanError.length === 80 ? cleanError + '...' : cleanError;
    
    return `${tool}: ${operation} failed - ${reason}`;
  }
}

// Log channels for future use
// enum LogChannel {
//   RESPONSE = 'response',
//   ERROR = 'error',
//   WARNING = 'warning',
//   DEBUG = 'debug',
//   INFO = 'info',
//   SYSTEM = 'system',
// }

/**
 * Truncation budget for tool argument formatting
 */
const TRUNCATION_BUDGET = {
  // Never truncate these types
  neverTruncate: {
    filePath: true,
    url: true,
    id: true,
  },

  // Only truncate these
  truncate: {
    string: 100,       // Regular strings
    object: {
      maxKeys: 3,      // Show first 3 keys
      perKey: 40,      // Chars per key-value in preview
    },
    array: {
      maxItems: 3,     // Show first 3 items
      perItem: 30,     // Chars per item in preview
    }
  },

  // Important field names - never truncate
  importantFields: new Set([
    'id', 'key', 'page_id', 'parent_id', 'database_id',
    'error', 'type', 'status', 'message', 'name', 'title'
  ])
} as const;

/**
 * Detect value type based on key name and content
 */
function detectValueType(key: string, value: string): 'filePath' | 'url' | 'id' | 'default' {
  const keyLower = key.toLowerCase();

  // File path detection
  if (keyLower.includes('path') || keyLower.includes('file') || keyLower.includes('dir')) {
    return 'filePath';
  }

  // URL detection
  if (keyLower.includes('url') || keyLower.includes('uri') || keyLower.includes('link')) {
    return 'url';
  }

  // ID detection
  if (keyLower.endsWith('_id') || keyLower.endsWith('id') || key === 'key') {
    return 'id';
  }

  return 'default';
}

/**
 * Format a string value with context-aware truncation
 */
function formatStringValue(key: string, value: string): string {
  // Check if it's an important field - never truncate
  if (TRUNCATION_BUDGET.importantFields.has(key)) {
    return `"${value}"`;
  }

  const valueType = detectValueType(key, value);

  // Never truncate file paths, URLs, or IDs
  if (valueType === 'filePath' || valueType === 'url' || valueType === 'id') {
    return `"${value}"`;
  }

  // Truncate regular strings
  const limit = TRUNCATION_BUDGET.truncate.string;
  if (value.length <= limit) {
    return `"${value}"`;
  }

  return `"${value.substring(0, limit)}..."`;
}

/**
 * Format an object value showing structure preview
 */
function formatObjectValue(obj: Record<string, any>): string {
  const keys = Object.keys(obj);

  if (keys.length === 0) {
    return '{}';
  }

  const maxKeys = TRUNCATION_BUDGET.truncate.object.maxKeys;
  const keyBudget = TRUNCATION_BUDGET.truncate.object.perKey;

  const preview = keys.slice(0, maxKeys).map(key => {
    const value = obj[key];
    let valueStr: string;

    if (value === null || value === undefined) {
      valueStr = String(value);
    } else if (typeof value === 'string') {
      valueStr = value.length > keyBudget
        ? `"${value.substring(0, keyBudget)}..."`
        : `"${value}"`;
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      valueStr = String(value);
    } else if (Array.isArray(value)) {
      valueStr = `[${value.length}]`;
    } else if (typeof value === 'object') {
      // Nested objects - show key count
      const nestedKeys = Object.keys(value).length;
      valueStr = nestedKeys > 0 ? `{...${nestedKeys}}` : '{}';
    } else {
      valueStr = String(value);
    }

    return `${key}: ${valueStr}`;
  });

  const remaining = keys.length - maxKeys;

  if (remaining > 0) {
    return `{${preview.join(', ')}, ... +${remaining}}`;
  } else {
    return `{${preview.join(', ')}}`;
  }
}

/**
 * Format an array value showing preview
 */
function formatArrayValue(arr: any[]): string {
  if (arr.length === 0) {
    return '[]';
  }

  const maxItems = TRUNCATION_BUDGET.truncate.array.maxItems;
  const itemBudget = TRUNCATION_BUDGET.truncate.array.perItem;

  const preview = arr.slice(0, maxItems).map(item => {
    if (item === null || item === undefined) {
      return String(item);
    } else if (typeof item === 'string') {
      return item.length > itemBudget
        ? `"${item.substring(0, itemBudget)}..."`
        : `"${item}"`;
    } else if (typeof item === 'number' || typeof item === 'boolean') {
      return String(item);
    } else if (typeof item === 'object' && !Array.isArray(item)) {
      // For objects in arrays, show compact preview
      const keys = Object.keys(item);
      if (keys.length > 0) {
        const firstKey = keys[0];
        const firstVal = item[firstKey];
        const valStr = typeof firstVal === 'string' && firstVal.length > 15
          ? `"${firstVal.substring(0, 15)}..."`
          : JSON.stringify(firstVal);
        return `{${firstKey}: ${valStr}}`;
      }
      return '{}';
    } else if (Array.isArray(item)) {
      return `[${item.length}]`;
    } else {
      return String(item);
    }
  });

  const remaining = arr.length - maxItems;

  if (remaining > 0) {
    return `[${preview.join(', ')}, ... +${remaining} (${arr.length} total)]`;
  } else {
    return `[${preview.join(', ')}]`;
  }
}

/**
 * Format a single parameter (key-value pair)
 */
function formatParameter(key: string, value: any): string {
  let valueStr: string;

  if (value === null || value === undefined) {
    valueStr = String(value);
  } else if (typeof value === 'string') {
    valueStr = formatStringValue(key, value);
  } else if (Array.isArray(value)) {
    valueStr = formatArrayValue(value);
  } else if (typeof value === 'object') {
    valueStr = formatObjectValue(value);
  } else {
    valueStr = String(value);
  }

  return `${key}: ${valueStr}`;
}

/**
 * Format tool arguments with granular truncation
 */
function formatToolArgsGranular(args: any): string {
  if (!args || typeof args !== 'object' || Array.isArray(args)) {
    if (args) {
      // For non-object args, just stringify
      const argsStr = JSON.stringify(args);
      return argsStr.length > 100 ? `${argsStr.substring(0, 100)}...` : argsStr;
    }
    return '';
  }

  const entries = Object.entries(args);
  if (entries.length === 0) {
    return '';
  }

  const formatted = entries.map(([key, value]) => formatParameter(key, value));

  return formatted.join(', ');
}

interface LoggerOptions {
  level?: LogLevel;
  enableDebug?: boolean;
}

class Logger {
  private level: LogLevel;
  private enableDebug: boolean;
  private captureBuffer: string[] = [];
  private isCapturing: boolean = false;
  private useTUI: boolean;
  private spinner: Spinner;
  private currentToolLine = '';

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? LogLevel.INFO;
    this.enableDebug = options.enableDebug ?? (process.env.DEBUG === 'true' || process.env.DEBUG === '1');
    this.useTUI = process.stdout.isTTY && this.level <= LogLevel.INFO;
    this.spinner = new Spinner();
  }

  /**
   * Format a tool name as a colored badge
   */
  private formatToolBadge(toolName: string, isSubAgent: boolean = false): string {
    const displayName = this.getToolDisplayName(toolName);

    if (!this.useTUI) {
      return `[${displayName}]`; // Fallback for non-TTY
    }

    // Check prefix-based detection first, then fall back to isSubAgent flag
    if (toolName.startsWith('subagent__') || isSubAgent) {
      // Sub-agents: Magenta background, white text
      return chalk.bgMagenta.white.bold(` ${displayName} `);
    }

    if (toolName.startsWith('mcp__')) {
      // MCP tools: Cyan background, black text
      return chalk.bgCyan.black.bold(` ${displayName} `);
    }

    // Native tools: Blue background, white text
    return chalk.bgBlue.white.bold(` ${displayName} `);
  }

  private getToolDisplayName(toolName: string): string {
    if (toolName.startsWith('mcp__')) {
      const parts = toolName.split('__').slice(1);
      if (parts.length >= 2) {
        const [provider, ...rest] = parts;
        return `${provider}:${rest.join('__')}`;
      }
    }
    if (toolName.startsWith('subagent__')) {
      return toolName.substring(10); // Remove 'subagent__' prefix
    }
    return toolName;
  }

  /**
   * Get agent activity prefix
   */
  private getAgentPrefix(): string {
    return this.useTUI ? '⋮' : '';
  }

  configure(options: LoggerOptions) {
    if (options.level !== undefined) {
      this.level = options.level;
    }
    if (options.enableDebug !== undefined) {
      this.enableDebug = options.enableDebug;
    }
    // Update TUI setting based on new configuration
    this.useTUI = process.stdout.isTTY && this.level <= LogLevel.INFO;
  }

  startCapture() {
    this.isCapturing = true;
    this.captureBuffer = [];
  }

  stopCapture(): string {
    this.isCapturing = false;
    const output = this.captureBuffer.join('');
    this.captureBuffer = [];
    return output;
  }

  private capture(text: string) {
    if (this.isCapturing) {
      this.captureBuffer.push(text);
    }
  }

  private writeToStderr(message: string) {
    const output = message + '\n';
    this.capture(output);
    process.stderr.write(output);
  }

  response(message: string) {
    // For streaming responses, don't add newline
    this.capture(message);
    process.stdout.write(message);
  }
  
  responseComplete() {
    // Add newline after complete response
    const newline = '\n';
    this.capture(newline);
    process.stdout.write(newline);
  }

  error(message: string, error?: Error) {
    const prefix = this.getAgentPrefix();
    const badge = this.useTUI ? chalk.bgRed.white.bold(' ERROR ') : '[ERROR]';
    const errorMessage = error ? `${message}: ${error.message}` : message;
    const formattedMessage = this.useTUI
      ? `${prefix} ${badge} ${errorMessage}`
      : `${badge} ${errorMessage}`;

    this.writeToStderr(chalk.red(formattedMessage));
    if (error?.stack && this.enableDebug) {
      this.writeToStderr(chalk.gray(error.stack));
    }
  }

  warn(message: string) {
    if (this.level <= LogLevel.WARN) {
      const prefix = this.getAgentPrefix();
      const badge = this.useTUI ? chalk.bgYellow.black.bold(' WARN ') : '[WARN]';
      const formattedMessage = this.useTUI
        ? `${prefix} ${badge} ${message}`
        : `${badge} ${message}`;

      this.writeToStderr(chalk.yellow(formattedMessage));
    }
  }

  info(message: string) {
    if (this.level <= LogLevel.INFO) {
      const prefix = this.getAgentPrefix();
      const badge = this.useTUI ? chalk.bgBlue.white.bold(' INFO ') : '[INFO]';
      const formattedMessage = this.useTUI
        ? `${prefix} ${badge} ${message}`
        : `\n${badge} ${message}`;

      this.writeToStderr(chalk.blue(formattedMessage));
    }
  }

  debug(message: string) {
    if (this.enableDebug && this.level <= LogLevel.DEBUG) {
      this.writeToStderr(chalk.gray(`[DEBUG] ${message}`));
    }
  }

  /**
   * Format and log a warning with tool context
   * Automatically uses debug mode based on logger configuration
   */
  warnWithTool(tool: string, operation: string, error: string) {
    const formatted = formatWarning(tool, operation, error, this.enableDebug);
    this.warn(formatted);
  }

  /**
   * Log tool result with formatting and optional timing/status
   */
  toolResult(result: string, options?: { duration?: number; success?: boolean; tokens?: number }) {
    // Spinner is disabled, no cleanup needed
    this.spinner.stop();

    if (!this.useTUI) {
      // Fallback for non-TTY
      if (this.enableDebug) {
        this.writeToStderr(chalk.gray(`  Result: ${result}`));
      }
      return;
    }

    // Format duration if provided
    let durationStr = '';
    if (options?.duration !== undefined) {
      const ms = options.duration;
      if (ms < 100) {
        durationStr = ` ${chalk.gray('⚡')} ${chalk.gray(`${ms}ms`)}`;
      } else if (ms < 1000) {
        durationStr = ` ${chalk.gray(`${ms}ms`)}`;
      } else {
        durationStr = ` ${chalk.gray(`${(ms / 1000).toFixed(1)}s`)}`;
      }
    }

    // Format tokens if provided
    let tokensStr = '';
    if (options?.tokens !== undefined) {
      tokensStr = ` ${chalk.gray(`(${options.tokens.toLocaleString()} tokens)`)}`;
    }

    // Status icon
    const statusIcon = options?.success === false
      ? chalk.red('✗')
      : options?.success === true
        ? chalk.green('✓')
        : chalk.gray('↳');

    // Format result - truncate if too long
    const MAX_RESULT_LENGTH = 100;
    let resultStr = result;
    if (result.length > MAX_RESULT_LENGTH) {
      resultStr = result.substring(0, MAX_RESULT_LENGTH) + '...';
    }

    this.writeToStderr(`  ${statusIcon} ${resultStr}${durationStr}${tokensStr}`);
  }

  system(message: string) {
    this.writeToStderr(chalk.magenta(`[SYSTEM] ${message}`));
  }

  tool(name: string, args?: unknown, result?: unknown, isSubAgent?: boolean) {
    // Only show when tool is being called, not when returning results
    if (args !== undefined) {
      if (this.useTUI && this.spinner.isActive()) {
        this.spinner.stop();
      }

      // Format args with granular truncation
      // (Full args shown in separate [DEBUG] line below if debug mode is enabled)
      let argsDisplay = '';
      if (args) {
        const formatted = formatToolArgsGranular(args);
        if (formatted) {
          argsDisplay = ` ${chalk.gray(formatted)}`;
        }
      }

      // Format with new TUI style
      if (this.useTUI) {
        const prefix = this.getAgentPrefix();
        const badge = this.formatToolBadge(name, isSubAgent);
        this.currentToolLine = `${prefix} ${badge}${argsDisplay}`;

        // Write line without animation
        process.stderr.write(this.currentToolLine + '\n');
        this.capture(this.currentToolLine + '\n');

        const spinnerWrite = (line: string) => {
          if (!process.stderr.isTTY) {
            return;
          }
          readline.moveCursor(process.stderr, 0, -1);
          readline.cursorTo(process.stderr, 0);
          process.stderr.write(line);
          readline.clearLine(process.stderr, 1);
          readline.cursorTo(process.stderr, 0);
          readline.moveCursor(process.stderr, 0, 1);
        };

        this.spinner.start(spinnerWrite, () => this.currentToolLine);
      } else {
        // Fallback for non-TTY
        const callType = (name.startsWith('subagent__') || isSubAgent) ? 'Calling subagent:' : 'Calling tool:';
        const displayName = this.getToolDisplayName(name);
        this.info(`${callType} ${chalk.cyan(displayName)}${chalk.gray(argsDisplay)}`);
      }

      // Show full args in debug mode
      if (this.enableDebug) {
        this.writeToStderr(chalk.gray(`[DEBUG] Full parameters: ${JSON.stringify(args, null, 2)}`));
      }
    } else if (result !== undefined && this.enableDebug) {
      // Only show results in debug mode
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      const RESULT_PREVIEW_LENGTH = 500;
      if (resultStr.length > RESULT_PREVIEW_LENGTH) {
        this.writeToStderr(chalk.gray(`[DEBUG] Tool ${name} result: ${resultStr.substring(0, RESULT_PREVIEW_LENGTH)}...`));
      } else {
        this.writeToStderr(chalk.gray(`[DEBUG] Tool ${name} result: ${resultStr}`));
      }
    }
  }
}

export const logger = new Logger({
  level: process.env.LOG_LEVEL ? 
    (LogLevel[process.env.LOG_LEVEL as keyof typeof LogLevel] ?? LogLevel.INFO) : 
    LogLevel.INFO,
  enableDebug: process.env.DEBUG === 'true' || process.env.DEBUG === '1',
});