import chalk from 'chalk';

export enum LogLevel {
  DEBUG = 0,
  INFO = 1,
  WARN = 2,
  ERROR = 3,
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

  private writeToStderr(message: string) {
    process.stderr.write(message + '\n');
  }

  response(message: string) {
    // For streaming responses, don't add newline
    process.stdout.write(message);
  }
  
  responseComplete() {
    // Add newline after complete response
    process.stdout.write('\n');
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

  system(message: string) {
    this.writeToStderr(chalk.magenta(`[SYSTEM] ${message}`));
  }

  tool(name: string, args?: unknown, result?: unknown) {
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
      
      // Tool is being called - show concise message with parameters
      this.info(`Calling tool: ${chalk.cyan(name)}${chalk.gray(argsDisplay)}`);
      
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