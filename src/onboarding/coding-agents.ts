import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, rm, rmdir, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Adds AgentUse's MCP server to the coding agents on this computer. MCP is the
 * one source of the steps: the person says what they want in plain words, or
 * types /agentuse in Claude Code and picks from its menu of MCP prompts.
 * Set up writes no skills, and removes the ones earlier versions wrote. The Mac
 * app's setup and the dashboard's empty Home share it. Claude Code and Codex
 * for now.
 */

export const CODING_AGENT_IDS = ['claude-code', 'codex'] as const;
export type CodingAgentId = typeof CODING_AGENT_IDS[number];

/** `outdated`: set up, but for another address or key (the server moved ports), or with a skill an earlier version wrote. */
export type CodingAgentState = 'not-installed' | 'not-set-up' | 'set-up' | 'outdated';

export interface CodingAgentStatus {
  id: CodingAgentId;
  name: string;
  /** The file AgentUse writes, with the home folder shown as `~`. */
  configPath: string;
  state: CodingAgentState;
  /** What to type to open the menu of AgentUse's commands, in apps that show MCP prompts. */
  command?: string;
  /** Why it's `outdated`, so the Update note can say which. */
  outdatedBecause?: 'address' | 'skills';
  /** Where people use it: its Mac app or the terminal, which share one config. */
  where: string;
}

/** The MCP server to add: this daemon's `/mcp`, and its operator key when it has one. */
export interface McpTarget {
  url: string;
  apiKey?: string;
}

interface Entry {
  url?: string;
  authorization?: string;
}

interface CodingAgent {
  id: CodingAgentId;
  name: string;
  command?: string;
  where: string;
  configFile: (home: string) => string;
  /** Where earlier versions wrote their skills. */
  skillsDir: (home: string) => string;
  /** Installed: its folder exists, or (Claude) its Mac app, which makes no folder until signed in. */
  installed: (home: string, appDirs: readonly string[]) => boolean;
  read: (text: string) => Entry | undefined;
  write: (text: string, target: McpTarget) => string;
}

const SERVER_NAME = 'agentuse';

/** Skills earlier versions wrote. The marker tells them from a person's own skill by that name. */
const OLD_SKILLS = ['automate', 'triage'] as const;
const skillMarker = (skill: string): string => `<!-- agentuse:${skill} -->`;

const bearer = (target: McpTarget): string | undefined => target.apiKey ? `Bearer ${target.apiKey}` : undefined;

const claudeCode: CodingAgent = {
  id: 'claude-code',
  name: 'Claude Code',
  // Claude Code lists MCP prompts as /agentuse:automate, but typing that in full
  // fails: the menu fills in the real name, /mcp__agentuse__automate.
  command: `/${SERVER_NAME}`,
  where: 'App or terminal',
  configFile: (home) => path.join(home, '.claude.json'),
  skillsDir: (home) => path.join(home, '.claude', 'skills'),
  installed: (home, appDirs) => existsSync(path.join(home, '.claude.json')) || existsSync(path.join(home, '.claude'))
    || appDirs.some((dir) => existsSync(path.join(dir, 'Claude.app'))),
  read(text) {
    const entry = parseClaudeConfig(text).mcpServers?.[SERVER_NAME];
    if (!entry || typeof entry !== 'object') return undefined;
    const { url, headers } = entry as { url?: unknown; headers?: Record<string, unknown> };
    const authorization = headers?.Authorization;
    return {
      ...(typeof url === 'string' && { url }),
      ...(typeof authorization === 'string' && { authorization }),
    };
  },
  write(text, target) {
    const config = parseClaudeConfig(text);
    const authorization = bearer(target);
    // User scope: the top-level mcpServers, which every Claude Code project sees.
    config.mcpServers = {
      ...config.mcpServers,
      [SERVER_NAME]: { type: 'http', url: target.url, ...(authorization && { headers: { Authorization: authorization } }) },
    };
    return `${JSON.stringify(config, null, 2)}\n`;
  },
};

function parseClaudeConfig(text: string): { mcpServers?: Record<string, unknown>; [key: string]: unknown } {
  if (!text.trim()) return {};
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('~/.claude.json is not a JSON object');
  return parsed as { mcpServers?: Record<string, unknown> };
}

const TOML_HEADER = /^\s*\[\[?\s*([^\]]+?)\s*\]\]?\s*(#.*)?$/;
const CODEX_TABLE = `mcp_servers.${SERVER_NAME}`;

/** Splits config.toml into the lines of the `[mcp_servers.agentuse]` table (and its subtables) and the rest. */
function splitCodexTable(text: string): { rest: string[]; table: string[] } {
  const rest: string[] = [];
  const table: string[] = [];
  let inTable = false;
  for (const line of text.split('\n')) {
    const header = TOML_HEADER.exec(line);
    if (header) inTable = header[1] === CODEX_TABLE || header[1].startsWith(`${CODEX_TABLE}.`);
    (inTable ? table : rest).push(line);
  }
  return { rest, table };
}

const codex: CodingAgent = {
  id: 'codex',
  name: 'Codex',
  // No command: Codex shows no MCP prompts, and @AgentUse needs the plugin.
  where: 'App or terminal',
  configFile: (home) => path.join(home, '.codex', 'config.toml'),
  skillsDir: (home) => path.join(home, '.agents', 'skills'),
  // The Codex app makes ~/.codex on first open, before sign-in.
  installed: (home) => existsSync(path.join(home, '.codex')),
  read(text) {
    const { table } = splitCodexTable(text);
    if (table.length === 0) return undefined;
    const body = table.join('\n');
    const url = /^\s*url\s*=\s*"([^"]*)"/m.exec(body)?.[1];
    const authorization = /Authorization\s*=\s*"([^"]*)"/.exec(body)?.[1];
    return { ...(url && { url }), ...(authorization && { authorization }) };
  },
  write(text, target) {
    const rest = splitCodexTable(text).rest.join('\n').replace(/\n+$/, '');
    const authorization = bearer(target);
    const table = [
      `[${CODEX_TABLE}]`,
      `url = ${JSON.stringify(target.url)}`,
      ...(authorization ? [`http_headers = { Authorization = ${JSON.stringify(authorization)} }`] : []),
    ];
    return `${rest ? `${rest}\n\n` : ''}${table.join('\n')}\n`;
  },
};

const CODING_AGENTS: readonly CodingAgent[] = [claudeCode, codex];

/**
 * The address coding agents get: AgentUse Cloud's once this computer is
 * connected to it, so Claude Code sees one AgentUse next to a claude.ai
 * connector (it merges servers with the same address), otherwise this
 * daemon's own. The cloud address carries no key: each tool signs in itself.
 */
export function codingAgentTarget(local: McpTarget, cloud?: { mcpUrl: string }): McpTarget {
  return cloud ? { url: cloud.mcpUrl } : local;
}

export function isCodingAgentId(value: unknown): value is CodingAgentId {
  return typeof value === 'string' && (CODING_AGENT_IDS as readonly string[]).includes(value);
}

async function readText(file: string): Promise<string> {
  try {
    return await readFile(file, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return '';
    throw error;
  }
}

function displayPath(file: string, home: string): string {
  return file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
}

/** The skill files an earlier version of AgentUse wrote here. */
async function oldSkillFiles(agent: CodingAgent, home: string): Promise<string[]> {
  const found = await Promise.all(OLD_SKILLS.map(async (skill) => {
    const file = path.join(agent.skillsDir(home), skill, 'SKILL.md');
    return (await readText(file)).includes(skillMarker(skill)) ? file : undefined;
  }));
  return found.filter((file): file is string => file !== undefined);
}

/** Where Mac apps are installed. */
export function appFolders(home = homedir()): string[] {
  return ['/Applications', path.join(home, 'Applications')];
}

async function statusOf(agent: CodingAgent, target: McpTarget, home: string, appDirs: readonly string[]): Promise<CodingAgentStatus> {
  const file = agent.configFile(home);
  const base = {
    id: agent.id,
    name: agent.name,
    configPath: displayPath(file, home),
    ...(agent.command && { command: agent.command }),
    where: agent.where,
  };
  if (!agent.installed(home, appDirs)) return { ...base, state: 'not-installed' };
  const entry = agent.read(await readText(file));
  if (!entry) return { ...base, state: 'not-set-up' };
  if (entry.url !== target.url || entry.authorization !== bearer(target)) return { ...base, state: 'outdated', outdatedBecause: 'address' };
  return (await oldSkillFiles(agent, home)).length === 0
    ? { ...base, state: 'set-up' }
    : { ...base, state: 'outdated', outdatedBecause: 'skills' };
}

/** Write next to the file and rename over it, keeping its mode (these configs can hold keys) and following a symlink. */
async function writeAtomically(target: string, text: string): Promise<void> {
  // A symlinked config (dotfiles repos): replace its target, not the link.
  const file = await realpath(target).catch(() => target);
  const mode = await stat(file).then((info) => info.mode & 0o777, () => 0o600);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.agentuse-${process.pid}.tmp`;
  await writeFile(temp, text, { mode });
  await rename(temp, file);
}

export async function codingAgentStatuses(target: McpTarget, home = homedir(), appDirs = appFolders(home)): Promise<CodingAgentStatus[]> {
  return Promise.all(CODING_AGENTS.map((agent) => statusOf(agent, target, home, appDirs)));
}

/**
 * Adds (or points again) AgentUse in this coding agent's config, keeping its
 * other settings, and removes skills an earlier version wrote. A person's own
 * skill by the same name is left alone.
 */
export async function setUpCodingAgent(
  id: CodingAgentId,
  target: McpTarget,
  home = homedir(),
  appDirs = appFolders(home),
): Promise<CodingAgentStatus> {
  const agent = CODING_AGENTS.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`Unknown coding agent: ${id}`);
  if (!agent.installed(home, appDirs)) throw new Error(`${agent.name} is not installed on this computer.`);
  const file = agent.configFile(home);
  await writeAtomically(file, agent.write(await readText(file), target));
  for (const skill of await oldSkillFiles(agent, home)) {
    await rm(skill);
    // Only when empty: anything the person added to the folder stays.
    await rmdir(path.dirname(skill)).catch(() => undefined);
  }
  return statusOf(agent, target, home, appDirs);
}
