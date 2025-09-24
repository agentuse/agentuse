import chalk from 'chalk';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
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

interface LoggerOptions {
  level?: LogLevel;
  enableDebug?: boolean;
}

class Logger {
  private level: LogLevel;
  private enableDebug: boolean;
  private captureBuffer: string[] = [];
  private isCapturing: boolean = false;

  constructor(options: LoggerOptions = {}) {
    this.level = options.level ?? LogLevel.INFO;
    this.enableDebug = options.enableDebug ?? (process.env.DEBUG === 'true' || process.env.DEBUG === '1');
  }

  configure(options: LoggerOptions) {
    if (options.level !== undefined) {
      this.level = options.level;
    }
    if (options.enableDebug !== undefined) {
      this.enableDebug = options.enableDebug;
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
    const errorMessage = error ? `${message}: ${error.message}` : message;
    this.writeToStderr(chalk.red(`[ERROR] ${errorMessage}`));
    if (error?.stack && this.enableDebug) {
      this.writeToStderr(chalk.gray(error.stack));
    }
  }

  warn(message: string) {
    if (this.level <= LogLevel.WARN) {
      this.writeToStderr(chalk.yellow(`[WARN] ${message}`));
    }
  }

  info(message: string) {
    if (this.level <= LogLevel.INFO) {
      this.writeToStderr(chalk.blue(`\n[INFO] ${message}`));
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

  system(message: string) {
    this.writeToStderr(chalk.magenta(`[SYSTEM] ${message}`));
  }

  tool(name: string, args?: unknown, result?: unknown, isSubAgent?: boolean) {
    // Only show when tool is being called, not when returning results
    if (args !== undefined) {
      // Format args concisely for display
      let argsDisplay = '';
      if (args && typeof args === 'object' && !Array.isArray(args)) {
        const entries = Object.entries(args);
        if (entries.length > 0) {
          // Show key-value pairs, truncating long values
          const MAX_VALUE_LENGTH = 50;
          const params = entries.map(([key, value]) => {
            let valueStr = '';
            if (value === null || value === undefined) {
              valueStr = String(value);
            } else if (typeof value === 'string') {
              valueStr = value.length > MAX_VALUE_LENGTH
                ? `"${value.substring(0, MAX_VALUE_LENGTH)}..."`
                : `"${value}"`;
            } else if (typeof value === 'object') {
              valueStr = Array.isArray(value) ? `[${value.length} items]` : '{...}';
            } else {
              valueStr = String(value);
            }
            return `${key}: ${valueStr}`;
          }).join(', ');
          argsDisplay = ` (${params})`;
        }
      } else if (args) {
        // For non-object args, just stringify with length limit
        const argsStr = JSON.stringify(args);
        argsDisplay = argsStr.length > 100 ? ` (${argsStr.substring(0, 100)}...)` : ` (${argsStr})`;
      }

      // Check if this is a subagent or regular tool
      const callType = isSubAgent ? 'Calling subagent:' : 'Calling tool:';

      // Tool is being called - show concise message with parameters
      this.info(`${callType} ${chalk.cyan(name)}${chalk.gray(argsDisplay)}`);

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