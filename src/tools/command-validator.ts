import * as path from 'path';
import * as fs from 'fs';
import type { CommandValidationResult } from './types.js';

// Shell operators that separate commands
const SHELL_OPERATORS = ['&&', '||', '|', ';', '&'];

// Built-in denylist - always blocked, cannot be overridden
// These are checked against individual commands after parsing
const BUILTIN_DENYLIST = [
  // Destructive filesystem operations
  'rm -rf /',
  'rm -rf ~',
  'rm -rf /*',
  'rm -rf ~/*',
  'rm -rf *',

  // Privilege escalation
  'sudo *',
  'su *',
  'doas *',

  // Dangerous permissions
  'chmod -R 777 /',
  'chmod -R 777 ~',
  'chmod 777 /',

  // Disk operations
  'mkfs*',
  'dd of=/dev/*',
  'dd if=* of=/dev/*',

  // System operations
  'shutdown*',
  'reboot*',
  'halt*',
  'poweroff*',
  'init 0',
  'init 6',

  // Dangerous shells/interpreters (when used as command target in pipe)
  'sh',
  'bash',
  'zsh',
  'fish',
  'python',
  'python3',
  'node',
  'perl',
  'ruby',
  'eval *',

  // Fork bomb patterns
  ':(){ :|:& };:*',
];

export class CommandValidator {
  private readonly allowedPatterns: string[];
  private readonly denyPatterns: string[];
  private readonly projectRoot: string | null;

  constructor(allowedPatterns: string[], projectRoot?: string) {
    this.allowedPatterns = allowedPatterns;
    this.denyPatterns = [...BUILTIN_DENYLIST];
    this.projectRoot = projectRoot ?? null;
  }

  /**
   * Extract potential file paths from a command string
   * Looks for arguments that look like file paths
   */
  private extractPaths(command: string): string[] {
    const paths: string[] = [];

    // Simple tokenization respecting quotes
    const tokens: string[] = [];
    let current = '';
    let inQuote: string | null = null;

    for (let i = 0; i < command.length; i++) {
      const char = command[i];

      if ((char === '"' || char === "'") && (i === 0 || command[i - 1] !== '\\')) {
        if (inQuote === char) {
          inQuote = null;
          tokens.push(current);
          current = '';
        } else if (!inQuote) {
          inQuote = char;
        } else {
          current += char;
        }
      } else if (char === ' ' && !inQuote) {
        if (current) {
          tokens.push(current);
          current = '';
        }
      } else {
        current += char;
      }
    }
    if (current) {
      tokens.push(current);
    }

    // Filter tokens that look like paths
    for (const token of tokens) {
      // Skip flags
      if (token.startsWith('-')) continue;

      // Check if it looks like a path
      if (
        token.startsWith('/') ||           // Absolute path
        token.startsWith('./') ||          // Relative current
        token.startsWith('../') ||         // Relative parent
        token.startsWith('~/') ||          // Home directory
        token.includes('/') ||             // Contains path separator
        token === '.' ||                   // Current directory
        token === '..'                     // Parent directory
      ) {
        paths.push(token);
      }
    }

    return paths;
  }

  /**
   * Resolve a path to absolute, handling ~ and relative paths
   */
  private resolvePath(filePath: string): string {
    // Handle ~ for home directory
    if (filePath.startsWith('~')) {
      filePath = filePath.replace(/^~/, process.env.HOME || '/tmp');
    }

    // Resolve relative paths against project root or cwd
    if (!path.isAbsolute(filePath)) {
      const base = this.projectRoot || process.cwd();
      filePath = path.resolve(base, filePath);
    }

    return path.normalize(filePath);
  }

  /**
   * Check if a path is within the project root
   */
  private isWithinProjectRoot(filePath: string): boolean {
    if (!this.projectRoot) return true; // No project root = no restriction

    try {
      const resolvedPath = this.resolvePath(filePath);

      // Try to resolve symlinks for existing paths
      let realPath = resolvedPath;
      try {
        realPath = fs.realpathSync(resolvedPath);
      } catch {
        // Path doesn't exist, use resolved path
      }

      // Normalize project root
      let realProjectRoot = this.projectRoot;
      try {
        realProjectRoot = fs.realpathSync(this.projectRoot);
      } catch {
        // Use as-is
      }

      // Check if the path is within project root
      const relative = path.relative(realProjectRoot, realPath);
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch {
      return false;
    }
  }

  /**
   * Check command for external directory access
   */
  private checkExternalDirectoryAccess(command: string): string | null {
    if (!this.projectRoot) return null; // No project root = no restriction

    const paths = this.extractPaths(command);

    for (const p of paths) {
      if (!this.isWithinProjectRoot(p)) {
        return `Access to path outside project root: ${p}`;
      }
    }

    return null;
  }

  /**
   * Parse a compound command into individual commands
   * Handles: cmd1 && cmd2, cmd1 || cmd2, cmd1 | cmd2, cmd1 ; cmd2, cmd1 & cmd2
   */
  private parseCompoundCommand(command: string): { commands: string[]; operators: string[] } {
    const commands: string[] = [];
    const operators: string[] = [];

    let current = '';
    let inQuote: string | null = null;
    let i = 0;

    while (i < command.length) {
      const char = command[i];

      // Handle quotes (skip operators inside quotes)
      if ((char === '"' || char === "'") && (i === 0 || command[i - 1] !== '\\')) {
        if (inQuote === char) {
          inQuote = null;
        } else if (!inQuote) {
          inQuote = char;
        }
        current += char;
        i++;
        continue;
      }

      // Skip operator detection if inside quotes
      if (inQuote) {
        current += char;
        i++;
        continue;
      }

      // Check for operators (order matters: && before &, || before |)
      let foundOperator = false;
      for (const op of SHELL_OPERATORS) {
        if (command.slice(i, i + op.length) === op) {
          if (current.trim()) {
            commands.push(current.trim());
          }
          operators.push(op);
          current = '';
          i += op.length;
          foundOperator = true;
          break;
        }
      }

      if (!foundOperator) {
        current += char;
        i++;
      }
    }

    // Add the last command
    if (current.trim()) {
      commands.push(current.trim());
    }

    return { commands, operators };
  }

  /**
   * Check if a pipe chain contains dangerous patterns
   * e.g., curl ... | sh, wget ... | bash
   */
  private checkPipeChain(commands: string[], operators: string[]): string | null {
    for (let i = 0; i < operators.length; i++) {
      if (operators[i] === '|' && i + 1 < commands.length) {
        const pipeTarget = commands[i + 1].trim();
        // Check if piping to a shell/interpreter
        const dangerousTargets = ['sh', 'bash', 'zsh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby'];
        for (const target of dangerousTargets) {
          if (pipeTarget === target || pipeTarget.startsWith(target + ' ')) {
            return `Piping to ${target} is not allowed`;
          }
        }
      }
    }
    return null;
  }

  /**
   * Convert a wildcard pattern to a regex
   */
  private patternToRegex(pattern: string): RegExp {
    const regexPattern = pattern
      .split('*')
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, '\\$&'))
      .join('.*');
    return new RegExp(`^${regexPattern}$`, 'i');
  }

  /**
   * Check if a command matches a pattern
   */
  private matchesPattern(command: string, pattern: string): boolean {
    const regex = this.patternToRegex(pattern);
    return regex.test(command);
  }

  /**
   * Check if command matches any pattern in a list
   */
  private matchesAny(command: string, patterns: string[]): string | null {
    for (const pattern of patterns) {
      if (this.matchesPattern(command, pattern)) {
        return pattern;
      }
    }
    return null;
  }

  /**
   * Validate a single command (not compound)
   */
  private validateSingleCommand(command: string): CommandValidationResult {
    const trimmed = command.trim();

    if (!trimmed) {
      return { allowed: false, error: 'Empty command' };
    }

    // Check denylist
    const denyMatch = this.matchesAny(trimmed, this.denyPatterns);
    if (denyMatch) {
      return {
        allowed: false,
        error: `Command blocked: matches deny pattern "${denyMatch}"`,
        matchedPattern: denyMatch,
      };
    }

    // Check allowlist
    if (this.allowedPatterns.length === 0) {
      return { allowed: false, error: 'No commands allowed (empty allowlist)' };
    }

    const allowMatch = this.matchesAny(trimmed, this.allowedPatterns);
    if (allowMatch) {
      return { allowed: true, matchedPattern: allowMatch };
    }

    return { allowed: false, error: `Command not in allowlist: "${trimmed}"` };
  }

  /**
   * Validate a command (handles compound commands)
   */
  validate(command: string): CommandValidationResult {
    const normalizedCommand = command.trim();

    if (!normalizedCommand) {
      return { allowed: false, error: 'Empty command' };
    }

    // Parse compound command
    const { commands, operators } = this.parseCompoundCommand(normalizedCommand);

    if (commands.length === 0) {
      return { allowed: false, error: 'No valid commands found' };
    }

    // Check for dangerous pipe chains first
    const pipeError = this.checkPipeChain(commands, operators);
    if (pipeError) {
      return { allowed: false, error: pipeError };
    }

    // Check for external directory access in each command
    for (const cmd of commands) {
      const externalError = this.checkExternalDirectoryAccess(cmd);
      if (externalError) {
        return { allowed: false, error: externalError };
      }
    }

    // Validate each command individually
    const matchedPatterns: string[] = [];

    for (const cmd of commands) {
      const result = this.validateSingleCommand(cmd);
      if (!result.allowed) {
        return {
          allowed: false,
          error: `In compound command: ${result.error}`,
        };
      }
      if (result.matchedPattern) {
        matchedPatterns.push(result.matchedPattern);
      }
    }

    return {
      allowed: true,
      matchedPattern: matchedPatterns.join(', '),
    };
  }

  /**
   * Get the list of allowed patterns
   */
  getAllowedPatterns(): string[] {
    return [...this.allowedPatterns];
  }

  /**
   * Get the list of deny patterns
   */
  getDenyPatterns(): string[] {
    return [...this.denyPatterns];
  }
}
