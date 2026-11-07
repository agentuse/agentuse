import { existsSync } from 'node:fs';
import { mkdir, readFile, realpath, rename, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import path from 'node:path';

/**
 * Adds AgentUse's local MCP server to the coding agents on this computer, plus
 * tiny `automate` and `triage` skills, so the person types /automate (Claude
 * Code) or $automate (Codex) and the command always fires. The skills hold no
 * steps: they call get_workflow, so fixes to the steps need no new Set up. The
 * Mac app's setup and the dashboard's empty Home share it. Claude Code and
 * Codex for now.
 */

export const CODING_AGENT_IDS = ['claude-code', 'codex'] as const;
export type CodingAgentId = typeof CODING_AGENT_IDS[number];

/** `outdated`: set up, but for another address or key (the server moved ports), or with old or missing skills. */
export type CodingAgentState = 'not-installed' | 'not-set-up' | 'set-up' | 'outdated';

export interface CodingAgentStatus {
  id: CodingAgentId;
  name: string;
  /** The file AgentUse writes, with the home folder shown as `~`. */
  configPath: string;
  state: CodingAgentState;
  /** What to type to make an agent: the short command, or what works instead when the person has their own skill by that name. */
  command: string;
  /** The same for fixing agents that fail. */
  triageCommand: string;
  /** Why it's `outdated`: the address only matters when it changed, so the Update note can say which. */
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
  /** The short command for a skill, and what works when the person's own skill has that name. */
  command: (skill: SkillName) => string;
  fallbackCommand: (skill: SkillName) => string;
  where: string;
  configFile: (home: string) => string;
  skillFile: (home: string, skill: SkillName) => string;
  /** Installed: its folder exists, or (Claude) its Mac app, which makes no folder until signed in. */
  installed: (home: string, appDirs: readonly string[]) => boolean;
  read: (text: string) => Entry | undefined;
  write: (text: string, target: McpTarget) => string;
}

const SERVER_NAME = 'agentuse';

const SKILLS = {
  automate: 'Turn work from this conversation into an AgentUse work agent that runs on its own. Use when the person types automate, or asks to automate a job or run it on a schedule with AgentUse.',
  triage: 'Find and fix AgentUse work agents that are failing. Use when the person types triage, or asks to fix their failing AgentUse agents.',
} as const;
type SkillName = keyof typeof SKILLS;
const SKILL_NAMES = Object.keys(SKILLS) as SkillName[];

/** Marks a skill file AgentUse wrote, so a person's own skill by that name is never replaced. */
const skillMarker = (skill: SkillName): string => `<!-- agentuse:${skill} -->`;

const bearer = (target: McpTarget): string | undefined => target.apiKey ? `Bearer ${target.apiKey}` : undefined;

const claudeCode: CodingAgent = {
  id: 'claude-code',
  name: 'Claude Code',
  command: (skill) => `/${skill}`,
  // The MCP server's own prompt, under the name Claude Code gives it.
  fallbackCommand: (skill) => `/mcp__${SERVER_NAME}__${skill}`,
  where: 'App or terminal',
  configFile: (home) => path.join(home, '.claude.json'),
  skillFile: (home, skill) => path.join(home, '.claude', 'skills', skill, 'SKILL.md'),
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
  command: (skill) => `$${skill}`,
  // Codex has no slash commands from MCP, so plain words are what's left.
  fallbackCommand: (skill) => skill === 'automate' ? 'Use AgentUse to automate this' : 'Use AgentUse to fix my failing agents',
  where: 'App or terminal',
  configFile: (home) => path.join(home, '.codex', 'config.toml'),
  skillFile: (home, skill) => path.join(home, '.agents', 'skills', skill, 'SKILL.md'),
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

/** The skill: a pointer to the MCP server's workflow, which stays the one source of the steps. */
export function skillText(skill: SkillName): string {
  return [
    '---',
    `name: ${skill}`,
    `description: ${SKILLS[skill]}`,
    '---',
    skillMarker(skill),
    '',
    `Call the \`get_workflow\` tool from the \`${SERVER_NAME}\` MCP server with \`workflow\` set to \`${skill}\`, then follow what it returns. Pass along anything the person typed after the command: as \`goal\` for automate, or as \`agent\` for triage when they named one.`,
    '',
    'If that tool is missing or asks for sign-in, stop and say AgentUse is not connected here yet: press Set up on AgentUse\'s Home, or sign in to AgentUse in this app. If AgentUse is not running, say to open it. Do not use the `agentuse` command line or write agent files yourself instead.',
    '',
  ].join('\n');
}

type SkillState = 'current' | 'old' | 'missing' | 'theirs';

async function skillState(agent: CodingAgent, skill: SkillName, home: string): Promise<SkillState> {
  const file = agent.skillFile(home, skill);
  if (!existsSync(file)) return 'missing';
  const text = await readText(file);
  if (text === skillText(skill)) return 'current';
  return text.includes(skillMarker(skill)) ? 'old' : 'theirs';
}

/** Where Mac apps are installed. */
export function appFolders(home = homedir()): string[] {
  return ['/Applications', path.join(home, 'Applications')];
}

async function statusOf(agent: CodingAgent, target: McpTarget, home: string, appDirs: readonly string[]): Promise<CodingAgentStatus> {
  const file = agent.configFile(home);
  const [automate, triage] = await Promise.all(SKILL_NAMES.map((skill) => skillState(agent, skill, home)));
  const commandFor = (skill: SkillName, state: SkillState | undefined): string =>
    state === 'theirs' ? agent.fallbackCommand(skill) : agent.command(skill);
  const base = {
    id: agent.id,
    name: agent.name,
    configPath: displayPath(file, home),
    command: commandFor('automate', automate),
    triageCommand: commandFor('triage', triage),
    where: agent.where,
  };
  if (!agent.installed(home, appDirs)) return { ...base, state: 'not-installed' };
  const entry = agent.read(await readText(file));
  if (!entry) return { ...base, state: 'not-set-up' };
  if (entry.url !== target.url || entry.authorization !== bearer(target)) return { ...base, state: 'outdated', outdatedBecause: 'address' };
  const skillsReady = [automate, triage].every((state) => state === 'current' || state === 'theirs');
  return skillsReady ? { ...base, state: 'set-up' } : { ...base, state: 'outdated', outdatedBecause: 'skills' };
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
 * other settings, and writes the skills, replacing older copies AgentUse
 * wrote. A person's own skill by the same name is left alone.
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
  for (const skill of SKILL_NAMES) {
    if (await skillState(agent, skill, home) !== 'theirs') await writeAtomically(agent.skillFile(home, skill), skillText(skill));
  }
  return statusOf(agent, target, home, appDirs);
}
