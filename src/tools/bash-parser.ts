import { Parser, Language } from 'web-tree-sitter';
import { fileURLToPath } from 'url';
import path from 'path';
import fs from 'fs';

let parserInstance: Parser | null = null;

/**
 * Find the node_modules directory from the current location
 */
function findNodeModules(): string {
  let currentDir = path.dirname(fileURLToPath(import.meta.url));

  // Try up to 5 levels up
  for (let i = 0; i < 5; i++) {
    const nodeModulesPath = path.join(currentDir, 'node_modules');
    if (fs.existsSync(nodeModulesPath)) {
      return nodeModulesPath;
    }
    currentDir = path.dirname(currentDir);
  }

  throw new Error('Could not find node_modules directory');
}

/**
 * Initialize tree-sitter parser for bash
 */
async function initParser(): Promise<Parser> {
  if (parserInstance) return parserInstance;

  // Initialize Parser with WASM
  await Parser.init();

  // Load bash language from node_modules (works in both dev and built versions)
  const nodeModulesPath = findNodeModules();
  const bashWasmPath = path.join(
    nodeModulesPath,
    'tree-sitter-bash/tree-sitter-bash.wasm'
  );

  if (!fs.existsSync(bashWasmPath)) {
    throw new Error(`Bash WASM file not found at: ${bashWasmPath}`);
  }

  const bashLanguage = await Language.load(bashWasmPath);

  const parser = new Parser();
  parser.setLanguage(bashLanguage);

  parserInstance = parser;
  return parser;
}

/**
 * Represents a parsed bash command with structured arguments
 */
export interface ParsedCommand {
  head: string;      // Command name (e.g., "git", "npm", "cd")
  tail: string[];    // Arguments (e.g., ["push", "origin", "main"])
  raw: string;       // Original command text
}

function stripOuterQuotes(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length < 2) return trimmed;
  const quote = trimmed[0];
  if ((quote !== '"' && quote !== "'") || trimmed[trimmed.length - 1] !== quote) {
    return trimmed;
  }
  return trimmed.slice(1, -1);
}

// Node types inside an unquoted here-doc body that the shell genuinely expands.
// `<<EOF` really does run `$(...)` in its body, so those spans must stay visible
// to the scanners and to the allowlist. Everything else in a body is inert data.
const EXPANDED_PAYLOAD_TYPES = new Set([
  'command_substitution',
  'process_substitution',
  'expansion',
  'simple_expansion',
  'arithmetic_expansion',
]);

interface SourceRange {
  start: number;
  end: number;
}

/**
 * Queue `node`'s whole span for masking, minus any descendant the shell expands.
 */
function maskSpanExceptExpansions(node: any, ranges: SourceRange[]): void {
  const keep: SourceRange[] = [];

  const walk = (current: any): void => {
    if (EXPANDED_PAYLOAD_TYPES.has(current.type)) {
      // Keep the expansion whole; its contents are a real command line.
      keep.push({ start: current.startIndex, end: current.endIndex });
      return;
    }
    for (let i = 0; i < current.childCount; i += 1) {
      const child = current.child(i);
      if (child) walk(child);
    }
  };
  walk(node);

  keep.sort((a, b) => a.start - b.start);

  let cursor = node.startIndex;
  for (const span of keep) {
    if (span.start > cursor) ranges.push({ start: cursor, end: span.start });
    cursor = Math.max(cursor, span.end);
  }
  if (node.endIndex > cursor) ranges.push({ start: cursor, end: node.endIndex });
}

/**
 * Blank out here-doc and here-string payloads, keeping every other index intact.
 *
 * `extractPipeTargets` and `extractRedirectionTargets` walk the raw command
 * string character by character and have no idea where a payload starts, so they
 * read stdin data as shell. That cuts both ways:
 *
 *   - False positives. A JavaScript arrow function looks like a redirect:
 *     `x => /^\d+$/.test(t)` is read as `> /^\d+$/.test(t)` and rejected with
 *     `Add "/^\d+$" to tools.bash.allowedPaths`. A regex alternation such as
 *     `/a|bash/` is read as a pipe to bash and hits the built-in denylist.
 *   - False negatives, which are worse. An apostrophe in the payload (`don't`)
 *     leaves the scanners' quote tracking open, so every operator after the
 *     here-doc becomes invisible: a redirect writing outside the project root
 *     was allowed, and `| bash` slipped past the built-in denylist.
 *
 * Masked characters become spaces so the string keeps its length and every
 * offset stays meaningful; newlines survive so the payload's line structure, and
 * therefore the surrounding parse, is unchanged.
 */
export async function maskInertPayloads(commandString: string): Promise<string> {
  const parser = await initParser();
  const tree = parser.parse(commandString as any);
  if (!tree) return commandString;

  const ranges: SourceRange[] = [];

  for (const body of tree.rootNode.descendantsOfType('heredoc_body')) {
    maskSpanExceptExpansions(body, ranges);
  }

  // `cmd <<< data` feeds a literal word to stdin. It is not a path, and not a
  // nested command line.
  for (const redirect of tree.rootNode.descendantsOfType('herestring_redirect')) {
    for (let i = 0; i < redirect.childCount; i += 1) {
      const child = redirect.child(i);
      if (child && child.type !== '<<<') maskSpanExceptExpansions(child, ranges);
    }
  }

  if (ranges.length === 0) return commandString;

  ranges.sort((a, b) => a.start - b.start);

  let masked = '';
  let cursor = 0;
  for (const range of ranges) {
    const start = Math.max(range.start, cursor);
    if (range.end <= start) continue;
    masked += commandString.slice(cursor, start);
    masked += commandString.slice(start, range.end).replace(/[^\n]/g, ' ');
    cursor = range.end;
  }

  return masked + commandString.slice(cursor);
}

function isPathLike(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('./') ||
    value.startsWith('../') ||
    value.startsWith('~/') ||
    value.includes('/') ||
    value === '.' ||
    value === '..'
  );
}

function readShellWord(input: string, start: number): { word: string; end: number } | null {
  let i = start;
  while (i < input.length && /\s/.test(input[i])) i += 1;
  if (i >= input.length) return null;

  let word = '';
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (; i < input.length; i += 1) {
    const char = input[i];

    if (escaped) {
      word += char;
      escaped = false;
      continue;
    }

    if (char === '\\') {
      escaped = true;
      word += char;
      continue;
    }

    if (quote) {
      word += char;
      if (char === quote) quote = null;
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      word += char;
      continue;
    }

    if (/\s/.test(char) || char === '|' || char === ';' || char === '&' || char === '<' || char === '>') {
      break;
    }

    word += char;
  }

  return word ? { word, end: i } : null;
}

export function extractPipeTargets(commandString: string): string[] {
  const targets: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < commandString.length; i += 1) {
    const char = commandString[i];

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
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== '|') continue;
    if (commandString[i + 1] === '|') {
      i += 1;
      continue;
    }

    const first = readShellWord(commandString, commandString[i + 1] === '&' ? i + 2 : i + 1);
    if (!first) continue;

    let target = stripOuterQuotes(first.word);
    let end = first.end;
    while (/^[A-Za-z_][A-Za-z0-9_]*=/.test(target)) {
      const next = readShellWord(commandString, end);
      if (!next) break;
      target = stripOuterQuotes(next.word);
      end = next.end;
    }
    targets.push(target);
  }

  return targets;
}

export function extractRedirectionTargets(commandString: string): string[] {
  const targets: string[] = [];
  let quote: '"' | "'" | null = null;
  let escaped = false;

  for (let i = 0; i < commandString.length; i += 1) {
    const char = commandString[i];

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
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char !== '<' && char !== '>') continue;

    let opEnd = i + 1;
    const next = commandString[opEnd];
    if (char === '<' && next === '<') {
      // Here-doc and here-string delimiters are not filesystem paths.
      i = opEnd;
      continue;
    }
    if ((char === '>' && next === '|') || (char === '<' && next === '>')) opEnd += 1;
    if (next === char) opEnd += 1;
    if (commandString[opEnd] === '&') {
      // File descriptor duplication, e.g. 2>&1.
      continue;
    }
    if (commandString[opEnd] === '(') {
      // Process substitution, not a direct path target.
      continue;
    }

    const target = readShellWord(commandString, opEnd);
    if (!target) continue;
    const clean = stripOuterQuotes(target.word);
    if (clean && isPathLike(clean)) targets.push(clean);
    i = target.end - 1;
  }

  return targets;
}

/**
 * Parse a bash command string into structured commands
 * Returns array of commands found in the input (handles pipelines, &&, ||, etc.)
 */
export async function parseBashCommand(commandString: string): Promise<ParsedCommand[]> {
  const parser = await initParser();
  const tree = parser.parse(commandString as any);

  if (!tree) {
    throw new Error('Failed to parse command');
  }

  const commands: ParsedCommand[] = [];

  // Find all command nodes in the tree
  const commandNodes = tree.rootNode.descendantsOfType('command');

  for (const node of commandNodes) {
    const parts: string[] = [];

    // Extract command parts from AST
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (!child) continue;

      // Only extract actual command parts (not syntax elements)
      if (
        child.type === 'command_name' ||
        child.type === 'word' ||
        child.type === 'concatenation'
      ) {
        parts.push(child.text);
      } else if (child.type === 'string' || child.type === 'raw_string') {
        // Strip the surrounding quotes so allowlist patterns match the argument
        // value: `curl "https://r.jina.ai/x"` must match `curl https://r.jina.ai/*`
        parts.push(stripOuterQuotes(child.text));
      }
    }

    if (parts.length > 0) {
      commands.push({
        head: parts[0],
        tail: parts.slice(1),
        raw: node.text,
      });
    }
  }

  return commands;
}

/**
 * Check if a command accesses paths and extract them
 * Used for external directory checking
 *
 * `scanText` is the same command with here-doc/here-string payloads blanked out
 * (see maskInertPayloads). Only the character-scanning half needs it: the
 * argument scan below reads `command` nodes from the AST, which already knows
 * where a payload starts and ends.
 */
export async function extractPaths(
  commandString: string,
  scanText: string = commandString
): Promise<string[]> {
  const commands = await parseBashCommand(commandString);
  const paths: string[] = [];

  for (const cmd of commands) {
    // Commands that commonly operate on paths
    const pathCommands = [
      'cd', 'rm', 'cp', 'mv', 'mkdir', 'touch', 'chmod', 'chown', 'cat', 'ls',
      // Script interpreters that execute files
      'bash', 'sh', 'zsh', 'fish', 'python', 'python3', 'node', 'ruby', 'perl',
    ];

    if (pathCommands.includes(cmd.head)) {
      for (const arg of cmd.tail) {
        // Skip flags
        if (arg.startsWith('-') || (cmd.head === 'chmod' && arg.startsWith('+'))) {
          continue;
        }

        // Check if it looks like a path
        if (isPathLike(arg)) {
          // Remove quotes if present
          const cleanPath = stripOuterQuotes(arg);
          paths.push(cleanPath);
        }
      }
    }
  }

  return [...paths, ...extractRedirectionTargets(scanText)];
}
