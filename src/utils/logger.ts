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
    this.writeToStderr(`[ERROR] ${errorMessage}`);
    if (error?.stack && this.enableDebug) {
      this.writeToStderr(error.stack);
    }
  }

  warn(message: string) {
    if (this.level <= LogLevel.WARN) {
      this.writeToStderr(`[WARN] ${message}`);
    }
  }

  info(message: string) {
    if (this.level <= LogLevel.INFO) {
      this.writeToStderr(`\n[INFO] ${message}`);
    }
  }

  debug(message: string) {
    if (this.enableDebug && this.level <= LogLevel.DEBUG) {
      this.writeToStderr(`[DEBUG] ${message}`);
    }
  }

  system(message: string) {
    this.writeToStderr(`[SYSTEM] ${message}`);
  }

  tool(name: string, args?: any, result?: any) {
    // Only show when tool is being called, not when returning results
    if (args !== undefined) {
      // Tool is being called - show concise message
      this.info(`Calling tool: ${name}`);
      
      // Show full args in debug mode
      if (this.enableDebug) {
        this.writeToStderr(`[DEBUG] Parameters: ${JSON.stringify(args, null, 2)}`);
      }
    } else if (result !== undefined && this.enableDebug) {
      // Only show results in debug mode
      const resultStr = typeof result === 'string' ? result : JSON.stringify(result);
      const RESULT_PREVIEW_LENGTH = 500;
      if (resultStr.length > RESULT_PREVIEW_LENGTH) {
        this.writeToStderr(`[DEBUG] Tool ${name} result: ${resultStr.substring(0, RESULT_PREVIEW_LENGTH)}...`);
      } else {
        this.writeToStderr(`[DEBUG] Tool ${name} result: ${resultStr}`);
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