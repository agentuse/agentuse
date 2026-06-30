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
        child.type === 'string' ||
        child.type === 'raw_string' ||
        child.type === 'concatenation'
      ) {
        parts.push(child.text);
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
 */
export async function extractPaths(commandString: string): Promise<string[]> {
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

  return [...paths, ...extractRedirectionTargets(commandString)];
}
