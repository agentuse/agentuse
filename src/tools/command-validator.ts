import * as path from 'path';
import * as os from 'os';
import type { CommandValidationResult } from './types.js';
import { parseBashCommand, extractPaths, extractPipeTargets, extractRedirectionTargets, type ParsedCommand } from './bash-parser.js';
import { matchStructured, type StructuredCommand } from './wildcard.js';
import { resolveRealPath, type PathResolverContext } from './path-validator.js';

// Built-in denylist - always blocked, cannot be overridden
const BUILTIN_DENYLIST: Record<string, boolean> = {
  // Destructive filesystem operations
  'rm -rf /': true,
  'rm -rf ~': true,
  'rm -rf /*': true,
  'rm -rf ~/*': true,
  'rm -rf *': true,

  // Privilege escalation
  'sudo *': true,
  'su *': true,
  'doas *': true,

  // Dangerous permissions
  'chmod -R 777 /': true,
  'chmod -R 777 ~': true,
  'chmod 777 /': true,

  // Disk operations
  'mkfs*': true,
  'dd of=/dev/*': true,
  'dd if=* of=/dev/*': true,

  // System operations
  'shutdown*': true,
  'reboot*': true,
  'halt*': true,
  'poweroff*': true,
  'init 0': true,
  'init 6': true,

  // Network exfiltration patterns
  '* | nc *': true,
  '* | netcat *': true,
  '* | ncat *': true,
  '* | curl *': true,
  '* | wget *': true,
  '* > /dev/tcp/*': true,
  '* > /dev/udp/*': true,

  // Reverse shell patterns
  'nc -e *': true,
  'nc * -e *': true,
  'netcat -e *': true,
  'netcat * -e *': true,
  'ncat -e *': true,
  'ncat * -e *': true,
  'bash -i *': true,
  'bash -c *sh -i*': true,

  // History/credential theft
  'cat *history*': true,
  'cat *_history': true,
  'cat *.ssh/*': true,
  'cat *id_rsa*': true,
  'cat *id_ed25519*': true,
  'cat /etc/passwd': true,
  'cat /etc/shadow': true,
};

interface PayloadCommandPattern {
  pattern: string;
  prefix: string[];
}

export interface PayloadCommandInvocation {
  command: string;
  args: string[];
  matchedPattern: string;
}

function escapeRegex(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function getPayloadCommandPatterns(allowedPatterns: Iterable<string>): PayloadCommandPattern[] {
  const patterns: PayloadCommandPattern[] = [];

  for (const pattern of allowedPatterns) {
    const parts = pattern.trim().split(/\s+/);
    if (parts.length !== 3) continue;
    if (parts[1] !== 'eval' || parts[2] !== '*') continue;
    if (parts[0].includes('*')) continue;

    patterns.push({
      pattern,
      prefix: [parts[0], parts[1]],
    });
  }

  return patterns;
}

function stripOuterShellQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;

  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) {
    return trimmed;
  }

  const inner = trimmed.slice(1, -1);
  if (quote === "'") return inner;

  return inner
    .replace(/\\(["\\$`])/g, '$1')
    .replace(/\\n/g, '\n');
}

function unsafeShellSyntaxInPayload(payload: string): string | undefined {
  const trimmed = payload.trim();
  const first = trimmed[0];

  if (first === '"' || first === "'") {
    let escaped = false;

    for (let i = 1; i < trimmed.length; i += 1) {
      const char = trimmed[i];

      if (escaped) {
        escaped = false;
        continue;
      }

      if (first === '"' && char === '\\') {
        escaped = true;
        continue;
      }

      if (char !== first) continue;

      const suffix = trimmed.slice(i + 1).trim();
      if (!suffix) return undefined;
      if (suffix.startsWith('|')) return 'pipeline';
      if (suffix.startsWith('&')) return 'command chain';
      if (suffix.startsWith(';') || suffix.startsWith('\n')) return 'command separator';
      if (suffix.startsWith('$(') || suffix.startsWith('`')) return 'command substitution';
      if (suffix.startsWith('>') || suffix.startsWith('<')) return 'redirection';
      return 'suffix';
    }

    return undefined;
  }

  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < payload.length; i += 1) {
    const char = payload[i];
    const next = payload[i + 1];

    if (escaped) {
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      continue;
    }

    if (quote) {
      if (char === quote) quote = null;
      if (quote !== "'" && char === '$' && next === '(') {
        return 'command substitution';
      }
      if (quote !== "'" && char === '`') {
        return 'command substitution';
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (char === ';' || char === '\n') return 'command separator';
    if (char === '|') return 'pipeline';
    if (char === '&') return 'command chain';
    if (char === '$' && next === '(') return 'command substitution';
    if (char === '`') return 'command substitution';
    if (
      (char === '>' || char === '<') &&
      /\s/.test(payload[i - 1] ?? ' ') &&
      /\s/.test(next ?? ' ')
    ) {
      return 'redirection';
    }
  }

  return undefined;
}

export function getBuiltinPayloadCommandInvocation(
  command: string,
  allowedPatterns: Iterable<string>
): PayloadCommandInvocation | undefined {
  const normalized = command.trim();

  for (const payloadCommand of getPayloadCommandPatterns(allowedPatterns)) {
    const prefixPattern = payloadCommand.prefix.map(escapeRegex).join('\\s+');
    const match = normalized.match(new RegExp(`^${prefixPattern}(?:\\s+([\\s\\S]*))?$`));
    if (!match) continue;

    const payload = match[1]?.trim() ?? '';
    const unsafe = unsafeShellSyntaxInPayload(payload);
    if (unsafe) {
      return {
        command: '',
        args: [],
        matchedPattern: `blocked:${unsafe}`,
      };
    }

    return {
      command: payloadCommand.prefix[0],
      args: [...payloadCommand.prefix.slice(1), stripOuterShellQuotes(payload)],
      matchedPattern: payloadCommand.pattern,
    };
  }

  return undefined;
}

export class CommandValidator {
  private readonly allowedPatterns: Record<string, 'allow' | 'deny'>;
  private readonly projectRoot: string | null;
  private readonly allowedPaths: string[];
  private readonly context: PathResolverContext | null;

  constructor(
    allowedPatterns: string[],
    projectRoot?: string,
    allowedPaths?: string[],
    context?: PathResolverContext
  ) {
    // Convert array of patterns to Record with "allow" value
    this.allowedPatterns = {};
    for (const pattern of allowedPatterns) {
      this.allowedPatterns[pattern] = 'allow';
    }

    // Auto-allow cd within project (it's just navigation)
    this.allowedPatterns['cd *'] = 'allow';

    this.projectRoot = projectRoot ?? null;
    this.allowedPaths = allowedPaths ?? [];
    this.context = context ?? (projectRoot ? { projectRoot } : null);
  }

  /**
   * Resolve variable placeholders in an allowed path.
   * Supported: ${root}, ${agentDir}, ${tmpDir}, ~
   */
  private resolveAllowedPath(allowedPath: string): string {
    let result = allowedPath;

    // Resolve ~ for home directory
    if (result.startsWith('~')) {
      result = result.replace(/^~/, os.homedir());
    }

    // Resolve variables if context is available
    if (this.context) {
      const tmpDir = resolveRealPath(this.context.tmpDir ?? os.tmpdir());
      result = result
        .replace(/\$\{root\}/g, this.context.projectRoot)
        .replace(/\$\{tmpDir\}/g, tmpDir);

      // Only replace ${agentDir} if it's defined
      if (this.context.agentDir) {
        result = result.replace(/\$\{agentDir\}/g, this.context.agentDir);
      }
    }

    return result;
  }

  /**
   * Resolve a path to absolute, handling ~ and relative paths.
   * Also resolves symlinks for consistent comparison with allowedPaths.
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

    // Resolve symlinks for consistent comparison (e.g., /var -> /private/var on macOS)
    return resolveRealPath(filePath);
  }

  /**
   * Check if a path is within a given root directory
   */
  private isPathWithin(filePath: string, rootDir: string): boolean {
    try {
      const resolvedPath = this.resolvePath(filePath);
      // Also resolve symlinks for rootDir for consistent comparison
      const normalizedRoot = resolveRealPath(rootDir);

      // Check if the path is within root
      const relative = path.relative(normalizedRoot, resolvedPath);

      // Path is within if:
      // 1. relative path doesn't start with '..' (not going up)
      // 2. relative path is not absolute (not a completely different path)
      return !relative.startsWith('..') && !path.isAbsolute(relative);
    } catch {
      return false;
    }
  }

  /**
   * Check if a path is within any allowed directory (project root or allowedPaths)
   */
  private isWithinAllowedPaths(filePath: string): boolean {
    // No project root = no restriction
    if (!this.projectRoot) return true;

    // Check project root first
    if (this.isPathWithin(filePath, this.projectRoot)) {
      return true;
    }

    // Check allowedPaths with variable resolution
    for (const allowedPath of this.allowedPaths) {
      const resolvedAllowedPath = this.resolveAllowedPath(allowedPath);

      if (this.isPathWithin(filePath, resolvedAllowedPath)) {
        return true;
      }
    }

    return false;
  }

  /**
   * Check for external directory access in parsed commands
   */
  private async checkExternalDirectoryAccess(
    commandString: string
  ): Promise<string | null> {
    if (!this.projectRoot) return null; // No project root = no restriction

    const paths = await extractPaths(commandString);

    for (const p of paths) {
      if (!this.isWithinAllowedPaths(p)) {
        const dir = path.dirname(p);
        return `Path outside allowed directories. Add "${dir}" to tools.bash.allowedPaths`;
      }
    }

    return null;
  }

  /**
   * Check if a command matches built-in denylist
   */
  private checkBuiltinDenylist(cmd: ParsedCommand): string | null {
    // Check full command
    const fullCmd = [cmd.head, ...cmd.tail].join(' ');

    for (const pattern in BUILTIN_DENYLIST) {
      if (this.matchesPattern(fullCmd, pattern)) {
        return `Command blocked by built-in security policy: "${pattern}"`;
      }
    }

    // Check if piping to dangerous targets (sh, bash, python, etc.)
    const dangerousTargets = ['sh', 'bash', 'zsh', 'fish', 'python', 'python3', 'node', 'perl', 'ruby'];
    if (dangerousTargets.includes(cmd.head)) {
      // It's ok if it's a direct call like "python script.py"
      // But not if it appears after a pipe in the original command
      // This is simplified - in practice, we'd need to check if this command
      // is the target of a pipe operator
    }

    return null;
  }

  private checkShellOperatorDenylist(command: string): string | null {
    for (const target of extractPipeTargets(command)) {
      const commandName = path.basename(target);
      const blockedPipeTargets = new Set([
        'nc', 'netcat', 'ncat', 'curl', 'wget',
        'sh', 'bash', 'zsh', 'fish',
        'python', 'python3', 'node', 'perl', 'ruby',
      ]);
      if (blockedPipeTargets.has(commandName)) {
        return `Command blocked by built-in security policy: pipe to "${commandName}"`;
      }
    }

    for (const target of extractRedirectionTargets(command)) {
      if (target.startsWith('/dev/tcp/') || target.startsWith('/dev/udp/')) {
        return 'Command blocked by built-in security policy: network redirection';
      }
    }

    return null;
  }

  /**
   * Match a string against a pattern (for simple checks)
   */
  private matchesPattern(str: string, pattern: string): boolean {
    const regexPattern = pattern
      .split('*')
      .map(part => part.replace(/[.+?^${}()|[\]\\]/g, char => '\\' + char))
      .join('.*');
    const regex = new RegExp(`^${regexPattern}$`, 'is');
    return regex.test(str);
  }

  /**
   * Validate a single parsed command
   */
  private validateSingleCommand(cmd: ParsedCommand): CommandValidationResult {
    // Check built-in denylist first
    const denyError = this.checkBuiltinDenylist(cmd);
    if (denyError) {
      return { allowed: false, error: denyError };
    }

    // cd is always allowed (only checked for external paths)
    if (cmd.head === 'cd') {
      return { allowed: true, matchedPattern: 'cd *' };
    }

    // Check allowlist using structured matching
    const structured: StructuredCommand = {
      head: cmd.head,
      tail: cmd.tail,
    };

    const result = matchStructured(structured, this.allowedPatterns);

    if (result === 'allow') {
      // Find which pattern matched for reporting
      const pattern = this.findMatchingPattern(structured);
      return { allowed: true, matchedPattern: pattern };
    }

    // Not in allowlist
    const allowedHint = Object.keys(this.allowedPatterns)
      .filter(p => this.allowedPatterns[p] === 'allow')
      .slice(0, 5)
      .join(', ');
    const moreCount =
      Object.keys(this.allowedPatterns).length > 5
        ? ` (+${Object.keys(this.allowedPatterns).length - 5} more)`
        : '';

    return {
      allowed: false,
      error: `Command not in allowlist: "${cmd.raw}". Allowed patterns: ${allowedHint}${moreCount}`,
    };
  }

  /**
   * Find which pattern matched a command (for reporting)
   */
  private findMatchingPattern(cmd: StructuredCommand): string {
    const sorted = Object.entries(this.allowedPatterns)
      .filter(([_, value]) => value === 'allow')
      .sort((a, b) => {
        const lenDiff = b[0].length - a[0].length; // Reverse sort (longest first)
        if (lenDiff !== 0) return lenDiff;
        return a[0].localeCompare(b[0]);
      });

    for (const [pattern] of sorted) {
      if (matchStructured(cmd, { [pattern]: 'allow' })) {
        return pattern;
      }
    }

    return 'unknown';
  }

  /**
   * Block commands that wait for stdin in non-interactive agent runs.
   */
  private checkInteractiveStdinCommand(command: string): string | null {
    if (/^\s*cat\s*(?:>|>>)\s*\S+/i.test(command)) {
      return 'Command waits for stdin and will hang: "cat > ...". Use the filesystem write tool instead.';
    }

    if (/^\s*tee\s+\S+/i.test(command)) {
      return 'Command waits for stdin and will hang: "tee ...". Use the filesystem write tool instead, or pipe explicit input into tee.';
    }

    if (/^\s*read(?:\s|$)/i.test(command)) {
      return 'Command waits for stdin and will hang: "read". Use a non-interactive command instead.';
    }

    return null;
  }

  /**
   * Validate a command (handles compound commands)
   */
  async validate(command: string): Promise<CommandValidationResult> {
    const normalizedCommand = command.trim();

    if (!normalizedCommand) {
      return { allowed: false, error: 'Empty command' };
    }

    const interactiveError = this.checkInteractiveStdinCommand(normalizedCommand);
    if (interactiveError) {
      return { allowed: false, error: interactiveError };
    }

    const payloadInvocation = getBuiltinPayloadCommandInvocation(
      normalizedCommand,
      Object.keys(this.allowedPatterns).filter((pattern) => this.allowedPatterns[pattern] === 'allow')
    );
    if (payloadInvocation?.matchedPattern.startsWith('blocked:')) {
      const reason = payloadInvocation.matchedPattern.slice('blocked:'.length);
      return {
        allowed: false,
        error: `Payload command contains shell ${reason}. Quote the payload or remove shell operators.`,
      };
    }
    if (payloadInvocation) {
      return { allowed: true, matchedPattern: payloadInvocation.matchedPattern };
    }

    // Parse command using tree-sitter
    let parsedCommands: ParsedCommand[];
    try {
      parsedCommands = await parseBashCommand(normalizedCommand);
    } catch (error) {
      return {
        allowed: false,
        error: `Failed to parse command: ${error instanceof Error ? error.message : 'unknown error'}`,
      };
    }

    if (parsedCommands.length === 0) {
      return { allowed: false, error: 'No valid commands found' };
    }

    const operatorDenyError = this.checkShellOperatorDenylist(normalizedCommand);
    if (operatorDenyError) {
      return { allowed: false, error: operatorDenyError };
    }

    // Validate each command individually (includes denylist check)
    const matchedPatterns: string[] = [];

    for (const cmd of parsedCommands) {
      const result = this.validateSingleCommand(cmd);
      if (!result.allowed) {
        return {
          allowed: false,
          error: result.error!,
        };
      }
      if (result.matchedPattern) {
        matchedPatterns.push(result.matchedPattern);
      }
    }

    // Check for external directory access last (after denylist and allowlist)
    // Only check if we have a project root configured
    const externalError = await this.checkExternalDirectoryAccess(normalizedCommand);
    if (externalError) {
      return { allowed: false, error: externalError };
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
    return Object.keys(this.allowedPatterns).filter(
      (p) => this.allowedPatterns[p] === 'allow'
    );
  }
}
