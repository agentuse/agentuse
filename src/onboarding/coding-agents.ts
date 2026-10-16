import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Adds AgentUse's local MCP server to the coding agents on this computer, so
 * they can make and fix agents. The Mac app's setup and the dashboard's first
 * run share it. Claude Code and Codex for now.
 */

export const CODING_AGENT_IDS = ['claude-code', 'codex'] as const;
export type CodingAgentId = typeof CODING_AGENT_IDS[number];

/** `outdated`: set up, but for another address or key (the server moved ports). */
export type CodingAgentState = 'not-installed' | 'not-set-up' | 'set-up' | 'outdated';

export interface CodingAgentStatus {
  id: CodingAgentId;
  name: string;
  /** The file AgentUse writes, with the home folder shown as `~`. */
  configPath: string;
  state: CodingAgentState;
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
  configFile: (home: string) => string;
  installed: (home: string) => boolean;
  read: (text: string) => Entry | undefined;
  write: (text: string, target: McpTarget) => string;
}

const SERVER_NAME = 'agentuse';

const bearer = (target: McpTarget): string | undefined => target.apiKey ? `Bearer ${target.apiKey}` : undefined;

const claudeCode: CodingAgent = {
  id: 'claude-code',
  name: 'Claude Code',
  configFile: (home) => path.join(home, '.claude.json'),
  installed: (home) => existsSync(path.join(home, '.claude.json')) || existsSync(path.join(home, '.claude')),
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
  name: 'OpenAI Codex',
  configFile: (home) => path.join(home, '.codex', 'config.toml'),
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

async function statusOf(agent: CodingAgent, target: McpTarget, home: string): Promise<CodingAgentStatus> {
  const file = agent.configFile(home);
  const base = { id: agent.id, name: agent.name, configPath: displayPath(file, home) };
  if (!agent.installed(home)) return { ...base, state: 'not-installed' };
  const entry = agent.read(await readText(file));
  if (!entry) return { ...base, state: 'not-set-up' };
  const current = entry.url === target.url && entry.authorization === bearer(target);
  return { ...base, state: current ? 'set-up' : 'outdated' };
}

export async function codingAgentStatuses(target: McpTarget, home = homedir()): Promise<CodingAgentStatus[]> {
  return Promise.all(CODING_AGENTS.map((agent) => statusOf(agent, target, home)));
}

/** Adds (or points again) AgentUse in this coding agent's config. Other settings in the file are kept. */
export async function setUpCodingAgent(id: CodingAgentId, target: McpTarget, home = homedir()): Promise<CodingAgentStatus> {
  const agent = CODING_AGENTS.find((candidate) => candidate.id === id);
  if (!agent) throw new Error(`Unknown coding agent: ${id}`);
  if (!agent.installed(home)) throw new Error(`${agent.name} is not installed on this computer.`);
  // Follow a symlinked config (dotfiles repos) so the rename replaces its target, not the link.
  const file = await realpath(agent.configFile(home)).catch(() => agent.configFile(home));
  const next = agent.write(await readText(file), target);
  // Keep the file's permissions: these configs can hold keys.
  const mode = await stat(file).then((info) => info.mode & 0o777, () => 0o600);
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.agentuse-${process.pid}.tmp`;
  await writeFile(temp, next, { mode });
  await rename(temp, file);
  return statusOf(agent, target, home);
}
