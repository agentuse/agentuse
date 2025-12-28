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
        if (
          arg.startsWith('/') ||
          arg.startsWith('./') ||
          arg.startsWith('../') ||
          arg.startsWith('~/') ||
          arg.includes('/') ||
          arg === '.' ||
          arg === '..'
        ) {
          // Remove quotes if present
          const cleanPath = arg.replace(/^['"]|['"]$/g, '');
          paths.push(cleanPath);
        }
      }
    }
  }

  return paths;
}
