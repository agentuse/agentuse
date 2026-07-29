import { parseBashCommand } from '../tools/bash-parser.js';
import type { SkillContent } from './types.js';

const SHELL_LANGUAGES = new Set(['', 'bash', 'sh', 'shell', 'zsh']);
const IGNORED_COMMANDS = new Set([
  'if',
  'then',
  'else',
  'elif',
  'fi',
  'for',
  'do',
  'done',
  'while',
  'case',
  'esac',
  'function',
  'export',
  'local',
  'set',
  'unset',
  'const',
  'let',
  'var',
  'delete',
  'return',
  'await',
  'async',
  'true',
  'false',
]);

export interface SkillCommandMention {
  command: string;
  evidence: string;
}

export async function extractSkillCommandMentions(skill: SkillContent): Promise<SkillCommandMention[]> {
  const snippets = [
    ...extractFencedShellBlocks(skill.content),
    ...extractInlineCommandSnippets(skill.content),
  ];
  const mentions = new Map<string, SkillCommandMention>();

  for (const snippet of snippets) {
    for (const command of await extractCommandsFromSnippet(snippet)) {
      if (!mentions.has(command)) {
        mentions.set(command, { command, evidence: snippet });
      }
    }
  }

  for (const tool of skill.allowedTools ?? []) {
    const command = extractCommandFromAllowedTool(tool);
    if (command && !mentions.has(command)) {
      mentions.set(command, { command, evidence: `allowed-tools: ${tool}` });
    }
  }

  return [...mentions.values()].sort((a, b) => a.command.localeCompare(b.command));
}

function extractFencedShellBlocks(markdown: string): string[] {
  const snippets: string[] = [];
  const fencePattern = /```([^\n`]*)\n([\s\S]*?)```/g;
  let match: RegExpExecArray | null;

  while ((match = fencePattern.exec(markdown)) !== null) {
    const language = (match[1] ?? '').trim().split(/\s+/)[0]?.toLowerCase() ?? '';
    if (SHELL_LANGUAGES.has(language)) {
      const body = (match[2] ?? '').trim();
      if (body) snippets.push(body);
    }
  }

  return snippets;
}

function extractInlineCommandSnippets(markdown: string): string[] {
  const snippets: string[] = [];
  const inlinePattern = /`([^`\n]+)`/g;
  let match: RegExpExecArray | null;

  while ((match = inlinePattern.exec(markdown)) !== null) {
    const snippet = (match[1] ?? '').trim();
    if (looksLikeInlineCommand(snippet)) {
      snippets.push(snippet);
    }
  }

  return snippets;
}

function looksLikeInlineCommand(snippet: string): boolean {
  const [first, second] = snippet.split(/\s+/, 2);
  if (!first) return false;
  if (!/^[A-Za-z0-9_.-]+$/.test(first)) return false;
  if (first.includes('/') || first.includes('=') || first.startsWith('.')) return false;
  return Boolean(second) || first.includes('-');
}

async function extractCommandsFromSnippet(snippet: string): Promise<string[]> {
  const commands = new Set<string>();

  try {
    const parsed = await parseBashCommand(snippet);
    for (const command of parsed) {
      addCommand(commands, command.head);
    }
  } catch {
    // Fall back to regex extraction below.
  }

  for (const command of extractCommandSubstitutionHeads(snippet)) {
    addCommand(commands, command);
  }

  if (commands.size === 0) {
    const first = snippet.trim().split(/\s+/, 1)[0];
    addCommand(commands, first);
  }

  return [...commands];
}

function extractCommandSubstitutionHeads(snippet: string): string[] {
  const commands: string[] = [];
  const substitutionPattern = /\$\(\s*([A-Za-z0-9_.-]+)(?=\s|\))/g;
  let match: RegExpExecArray | null;

  while ((match = substitutionPattern.exec(snippet)) !== null) {
    commands.push(match[1]);
  }

  return commands;
}

/**
 * The literal command prefix of a `Bash(...)` allowed-tools pattern, or
 * undefined when the pattern is not a simple prefix grant.
 *
 * Per the Claude Code permissions spec the trailing-wildcard forms are
 * equivalent (`Bash(ls:*)` matches the same commands as `Bash(ls *)`) and `:*`
 * is recognized ONLY at the end of a pattern. Multi-word prefixes are legal and
 * documented: `Bash(git commit *)`, `Bash(npm run *)`.
 *
 * A wildcard anywhere but the tail (`Bash(git * main)`) deliberately yields
 * nothing. Collapsing it to `git` would hand over the entire `git` family when
 * the skill asked for one narrow shape - a trust grant must never widen.
 */
export function extractCommandFromAllowedTool(tool: string): string | undefined {
  const match = tool.match(/^Bash\(([^()]+)\)$/);
  if (!match) return undefined;
  // Strip an equivalent trailing wildcard in either spelling.
  const prefix = match[1].trim().replace(/(?::\*|\s+\*)$/, '').trim();
  if (!prefix || prefix.includes('*')) return undefined;
  // Shell-safe words only: no quoting, redirection, substitution, or operators.
  if (!/^[A-Za-z0-9_./-]+(?: [A-Za-z0-9_./-]+)*$/.test(prefix)) return undefined;
  return prefix;
}

function addCommand(commands: Set<string>, command: string | undefined): void {
  if (!command) return;
  const normalized = command.replace(/^['"]|['"]$/g, '');
  if (!/^[A-Za-z0-9_.-]+$/.test(normalized)) return;
  if (normalized.includes('=') || normalized.startsWith('-')) return;
  if (IGNORED_COMMANDS.has(normalized)) return;
  commands.add(normalized);
}
