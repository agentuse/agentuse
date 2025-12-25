import chalk from 'chalk';
import ora, { type Ora } from 'ora';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
}

export interface ExecutionSummary {
  success: boolean;
  durationMs: number;
  tokensUsed?: number;
  toolCallCount?: number;
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

function isEnvDebugFlagEnabled(): boolean {
  const candidates = [process.env.AGENTUSE_DEBUG, process.env.DEBUG];
  return candidates.some(value => {
    if (!value) {
      return false;
    }
    const normalized = value.toLowerCase();
    return normalized === 'true' || normalized === '1';
  });
}

function isEnvNoTTYEnabled(): boolean {
  const value = process.env.NO_TTY;
  if (!value) return false;
  const normalized = value.toLowerCase();
  return normalized === 'true' || normalized === '1' || normalized === 'yes';
}

function isNoTTYArgPresent(): boolean {
  return process.argv?.some(arg => arg === '--no-tty' || arg === '--noTTY') ?? false;
}

/**
 * Detect if running in a CI environment
 * CI environments may report isTTY incorrectly or have issues with ora spinners
 */
function isCI(): boolean {
  return Boolean(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.JENKINS_URL ||
    process.env.BUILDKITE ||
    process.env.TRAVIS ||
    process.env.TF_BUILD // Azure Pipelines
  );
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
function detectValueType(key: string, _value: string): 'filePath' | 'url' | 'id' | 'default' {
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
function formatToolArgsGranular(args: any, options?: { disableTruncation?: boolean }): string {
  if (options?.disableTruncation) {
    try {
      return typeof args === 'string' ? args : JSON.stringify(args);
    } catch {
      return String(args);
    }
  }

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
  disableTUI?: boolean;
}

class Logger {
  private level: LogLevel;
  private enableDebug: boolean;
  private disableTUI: boolean;
  private captureBuffer: string[] = [];
  private isCapturing: boolean = false;
  private useTUI: boolean;
  private spinner: Ora | null = null;
  private spinnerStoppedByOutput = false;
  private activeLlmModel: string | null = null;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? LogLevel.INFO;
    this.enableDebug = options.enableDebug ?? isEnvDebugFlagEnabled();
    const noTTYRequested = options.disableTUI ?? (isEnvNoTTYEnabled() || isNoTTYArgPresent());
    this.disableTUI = noTTYRequested;
    if (noTTYRequested) {
      this.forcePlainOutput();
    } else {
      this.refreshTUIState();
    }
  }

  private isDebugEnabled(): boolean {
    return this.enableDebug || isEnvDebugFlagEnabled();
  }

  private shouldUseTUI(): boolean {
    return !this.disableTUI && !isCI() && process.stdout.isTTY && this.level <= LogLevel.INFO && !this.isDebugEnabled();
  }

  /**
   * Recompute TUI setting and stop any active spinner if TUI is disabled
   */
  private refreshTUIState() {
    // Re-evaluate in case NO_TTY env/argv was set after construction
    if (isEnvNoTTYEnabled() || isNoTTYArgPresent()) {
      this.disableTUI = true;
    }

    const nextUseTUI = this.shouldUseTUI();
    if (this.useTUI && !nextUseTUI && this.spinner?.isSpinning) {
      this.spinner.stop();
      this.spinner = null;
    }
    this.useTUI = nextUseTUI;
  }

  /**
   * Permanently switch to plain (non-TUI) mode for this process.
   * Stops any active spinner and prevents new ones from starting.
   */
  forcePlainOutput() {
    this.disableTUI = true;
    this.useTUI = false;
    if (this.spinner?.isSpinning) {
      this.spinner.stop();
      this.spinner = null;
    }
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
        return `${provider}:${rest.join('__')} (MCP)`;
      }
    }
    if (toolName.startsWith('subagent__')) {
      const name = toolName.substring(10); // Remove 'subagent__' prefix
      return `${name} (Subagent)`;
    }
    return toolName;
  }

  /**
   * Get agent activity prefix
   */
  private getAgentPrefix(): string {
    return this.useTUI ? '⋮' : '';
  }

  private formatLlmSpinnerText(model: string, latencyMs?: number): string {
    const badge = chalk.bgGreen.black.bold(' LLM ');
    const latencySuffix = latencyMs !== undefined
      ? chalk.gray(` • ${latencyMs >= 1000 ? `${(latencyMs / 1000).toFixed(1)}s` : `${Math.round(latencyMs)}ms`}`)
      : '';
    return ` ${badge} ${chalk.gray(model)}${latencySuffix}`;
  }

  configure(options: LoggerOptions) {
    if (options.level !== undefined) {
      this.level = options.level;
    }
    if (options.enableDebug !== undefined) {
      this.enableDebug = options.enableDebug;
    }
    if (options.disableTUI !== undefined) {
      this.disableTUI = options.disableTUI;
    }
    // Update TUI setting based on new configuration
    if (this.disableTUI) {
      this.forcePlainOutput();
    } else {
      this.refreshTUIState();
    }
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
    // Stop spinner on first response output to avoid conflicts
    if (this.spinner?.isSpinning && !this.spinnerStoppedByOutput) {
      // LLM spinner should be cleared (not persisted) - it's just a loading indicator
      // The streaming response replaces it
      this.spinner.stop();
      this.spinner = null;
      this.spinnerStoppedByOutput = true;
      this.activeLlmModel = null;
    }

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
    // Stop spinner before writing to avoid cursor conflicts
    if (this.spinner?.isSpinning) {
      this.spinner.stopAndPersist({ symbol: '⋮' });
      this.spinner = null;
    }

    const prefix = this.getAgentPrefix();
    const badge = this.useTUI ? chalk.bgRed.white.bold(' ERROR ') : '[ERROR]';
    const errorMessage = error ? `${message}: ${error.message}` : message;
    const formattedMessage = this.useTUI
      ? `${prefix}  ${badge} ${errorMessage}`
      : `${badge} ${errorMessage}`;

    this.writeToStderr(chalk.red(formattedMessage));
    if (error?.stack && this.isDebugEnabled()) {
      this.writeToStderr(chalk.gray(error.stack));
    }
  }

  warn(message: string) {
    if (this.level <= LogLevel.WARN) {
      // Stop spinner before writing to avoid cursor conflicts
      if (this.spinner?.isSpinning) {
        this.spinner.stopAndPersist({ symbol: '⋮' });
        this.spinner = null;
      }

      const prefix = this.getAgentPrefix();
      const badge = this.useTUI ? chalk.bgYellow.black.bold(' WARN ') : '[WARN]';
      const formattedMessage = this.useTUI
        ? `${prefix}  ${badge} ${message}`
        : `${badge} ${message}`;

      this.writeToStderr(chalk.yellow(formattedMessage));
    }
  }

  info(message: string) {
    if (this.level <= LogLevel.INFO) {
      // Stop spinner before writing to avoid cursor conflicts
      if (this.spinner?.isSpinning) {
        this.spinner.stopAndPersist({ symbol: '⋮' });
        this.spinner = null;
      }

      const prefix = this.getAgentPrefix();
      const badge = this.useTUI ? chalk.bgBlue.white.bold(' INFO ') : '[INFO]';
      const formattedMessage = this.useTUI
        ? `${prefix}  ${badge} ${message}`
        : `\n${badge} ${message}`;

      this.writeToStderr(chalk.blue(formattedMessage));
    }
  }

  debug(message: string) {
    if (this.isDebugEnabled() && this.level <= LogLevel.DEBUG) {
      this.writeToStderr(chalk.gray(`[DEBUG] ${message}`));
    }
  }

  /**
   * Format and log a warning with tool context
   * Automatically uses debug mode based on logger configuration
   */
  warnWithTool(tool: string, operation: string, error: string) {
    const formatted = formatWarning(tool, operation, error, this.isDebugEnabled());
    this.warn(formatted);
  }

  /**
   * Log tool result with formatting and optional timing/status
   */
  toolResult(result: string, options?: { duration?: number; success?: boolean; tokens?: number }) {
    this.refreshTUIState();

    // Stop spinner and persist the line
    if (this.spinner?.isSpinning) {
      // Add static symbol when stopping
      this.spinner.stopAndPersist({ symbol: '⋮' });
      this.spinner = null;
    }
    this.spinnerStoppedByOutput = false;

    const debugMode = this.isDebugEnabled();
    const useTUI = this.useTUI && !debugMode;

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
    if (!debugMode && result.length > MAX_RESULT_LENGTH) {
      resultStr = result.substring(0, MAX_RESULT_LENGTH) + '...';
    }

    const line = `  ${statusIcon} ${resultStr}${durationStr}${tokensStr}`;

    if (!useTUI) {
      this.writeToStderr(line);
      return;
    }

    this.writeToStderr(line);
  }

  system(message: string) {
    this.writeToStderr(chalk.magenta(`[SYSTEM] ${message}`));
  }

  /**
   * Start LLM spinner in TUI mode or log a message in non-TUI mode
   * Displays the model name and starts tracking for first-token latency
   * @param model - The name of the LLM model being called (e.g., "claude-sonnet-4")
   */
  llmStart(model: string) {
    this.refreshTUIState();

    // Stop any existing spinner - just clear it, don't persist
    // LLM spinners are loading indicators, not permanent output
    if (this.spinner?.isSpinning) {
      this.spinner.stop();
      this.spinner = null;
    }

    this.activeLlmModel = null;
    this.spinnerStoppedByOutput = false;
    const debugMode = this.isDebugEnabled();
    const useTUI = this.useTUI && !debugMode;

    if (useTUI) {
      let text = this.formatLlmSpinnerText(model);

      const MAX_LINE_LENGTH = 140;
      if (text.length > MAX_LINE_LENGTH) {
        text = text.substring(0, MAX_LINE_LENGTH - 3) + '...';
      }

      this.spinner = ora({
        text,
        stream: process.stderr,
        spinner: {
          interval: 120,
          frames: ['⋮', '⋰', '⋯', '⋱']
        },
        isEnabled: useTUI
      }).start();

      this.capture(`${this.getAgentPrefix()}${text}\n`);
      this.activeLlmModel = model;
    } else {
      // In non-TUI mode, just log to debug (model already in metadata)
      this.debug(`Calling model: ${model}`);
      this.activeLlmModel = null;
    }

  }

  /**
   * Update LLM spinner with first-token latency
   * Called after receiving the first token from the LLM to display response time
   * @param model - The name of the LLM model
   * @param latencyMs - Time in milliseconds from request start to first token
   */
  llmFirstToken(model: string, latencyMs: number) {
    if (!this.spinner?.isSpinning || this.activeLlmModel !== model) {
      return;
    }

    let text = this.formatLlmSpinnerText(model, latencyMs);
    const MAX_LINE_LENGTH = 140;
    if (text.length > MAX_LINE_LENGTH) {
      text = text.substring(0, MAX_LINE_LENGTH - 3) + '...';
    }

    this.spinner.text = text;
  }

  tool(name: string, args?: unknown, result?: unknown, isSubAgent?: boolean) {
    this.refreshTUIState();

    // Only show when tool is being called, not when returning results
    if (args !== undefined) {
      // Stop any existing spinner and persist the line
      if (this.spinner?.isSpinning) {
        // Add static symbol when stopping
        this.spinner.stopAndPersist({ symbol: '⋮' });
        this.spinner = null;
      }

      this.activeLlmModel = null;

      // Reset flag for new tool execution
      this.spinnerStoppedByOutput = false;

      const debugMode = this.isDebugEnabled();
      const useTUI = this.useTUI && !debugMode;

      // Format args with granular truncation
      // (Full args shown in separate [DEBUG] line below if debug mode is enabled)
      let argsDisplay = '';
      if (args) {
        const formatted = formatToolArgsGranular(args, { disableTruncation: debugMode });
        if (formatted) {
          argsDisplay = ` ${chalk.gray(formatted)}`;
        }
      }

      // Format with new TUI style
      if (useTUI) {
        const badge = this.formatToolBadge(name, isSubAgent);
        let text = ` ${badge}${argsDisplay}`;

        // Truncate to prevent terminal wrapping (which causes duplicate lines)
        // Symbol (1) + space (2) + text = total line length
        // Leave room for terminal width variations (use 140 chars as safe limit)
        const MAX_LINE_LENGTH = 140;
        if (text.length > MAX_LINE_LENGTH) {
          text = text.substring(0, MAX_LINE_LENGTH - 3) + '...';
        }

        // Create and start ora spinner
        this.spinner = ora({
          text,
          stream: process.stderr,
          spinner: {
            interval: 120,
            frames: ['⋮', '⋰', '⋯', '⋱']
          },
          isEnabled: useTUI
        }).start();

        // Capture for testing/debugging (include prefix for logging)
        this.capture(`${this.getAgentPrefix()}${text}\n`);
      } else {
        // Fallback for non-TTY
        const callType = (name.startsWith('subagent__') || isSubAgent) ? 'Calling subagent:' : 'Calling tool:';
        const displayName = this.getToolDisplayName(name);
        this.info(`${callType} ${chalk.cyan(displayName)}${chalk.gray(argsDisplay)}`);
      }

      // Show full args in debug mode
      if (debugMode) {
        this.writeToStderr(chalk.gray(`[DEBUG] Full parameters: ${JSON.stringify(args, null, 2)}`));
      }
    } else if (result !== undefined) {
      const debugMode = this.isDebugEnabled();
      if (debugMode) {
        const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
        this.writeToStderr(chalk.gray(`[DEBUG] Tool ${name} result: ${resultStr}`));
      }
    }
  }

  /**
   * Print a thin horizontal separator line
   */
  separator() {
    this.refreshTUIState();

    // Stop any existing spinner before printing separator
    if (this.spinner?.isSpinning) {
      this.spinner.stopAndPersist({ symbol: '⋮' });
      this.spinner = null;
    }

    const line = '─'.repeat(50);
    const output = this.useTUI ? chalk.gray(line) : line;
    this.writeToStderr(output);
  }

  /**
   * Print execution summary with timing and token info
   */
  summary(data: ExecutionSummary) {
    this.refreshTUIState();

    // Stop any existing spinner
    if (this.spinner?.isSpinning) {
      this.spinner.stopAndPersist({ symbol: '⋮' });
      this.spinner = null;
    }

    const icon = data.success ? chalk.green('✓') : chalk.red('✗');
    const status = data.success ? 'Completed' : 'Failed';

    // Format duration
    let durationStr: string;
    if (data.durationMs < 1000) {
      durationStr = `${Math.round(data.durationMs)}ms`;
    } else {
      durationStr = `${(data.durationMs / 1000).toFixed(1)}s`;
    }

    // Build summary parts
    const parts = [`${status} in ${durationStr}`];

    if (data.tokensUsed !== undefined) {
      parts.push(`${data.tokensUsed.toLocaleString()} tokens`);
    }

    if (data.toolCallCount !== undefined && data.toolCallCount > 0) {
      parts.push(`${data.toolCallCount} tool call${data.toolCallCount === 1 ? '' : 's'}`);
    }

    const message = `${icon} ${parts.join(' • ')}`;
    this.writeToStderr(message);
  }

  /**
   * Print grouped metadata lines (key: value format)
   */
  metadata(lines: string[]) {
    // Stop any existing spinner
    if (this.spinner?.isSpinning) {
      this.spinner.stopAndPersist({ symbol: '⋮' });
      this.spinner = null;
    }

    for (const line of lines) {
      this.writeToStderr(line);
    }
  }

  /**
   * Print grouped warnings as a block
   */
  groupedWarnings(warnings: string[]) {
    if (warnings.length === 0) return;

    // Stop any existing spinner
    if (this.spinner?.isSpinning) {
      this.spinner.stopAndPersist({ symbol: '⋮' });
      this.spinner = null;
    }

    const icon = chalk.yellow('⚠');
    const count = warnings.length;
    const header = `${icon} ${count} warning${count === 1 ? '' : 's'}:`;

    this.writeToStderr(header);
    for (const warning of warnings) {
      this.writeToStderr(chalk.yellow(`  • ${warning}`));
    }
  }
}

export const logger = new Logger({
  level: process.env.LOG_LEVEL ? 
    (LogLevel[process.env.LOG_LEVEL as keyof typeof LogLevel] ?? LogLevel.INFO) : 
    LogLevel.INFO,
  enableDebug: isEnvDebugFlagEnabled(),
  disableTUI: process.env.NO_TTY === 'true',
});
