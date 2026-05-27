import { Command } from 'commander';
import chalk from 'chalk';
import fs from 'fs/promises';
import path, { resolve } from 'path';
import { parseAgent } from '../parser.js';
import { discoverSkills } from '../skill/discovery.js';
import { getExplicitSkillNames } from '../skill/config.js';
import { parseSkillContent } from '../skill/parser.js';
import { extractSkillCommandMentions } from '../skill/command-extract.js';
import { resolveProjectContext } from '../utils/project.js';
import { computeAgentId } from '../utils/agent-id.js';
import { getSessionStorageDir } from '../storage/paths.js';
import { parseBashCommand } from '../tools/bash-parser.js';
import type { Message, Part, SessionInfo, ToolPart } from '../session/types.js';

interface DoctorOptions {
  lastRun?: boolean | undefined;
}

interface RuntimeSessionDetails {
  session: SessionInfo;
  dirPath: string;
  messages: Array<{ message: Message; parts: Part[] }>;
}

interface RuntimeProblem {
  tool: string;
  command?: string | undefined;
  error: string;
  suggestedAllows: string[];
}

function skillLooksReferenced(agent: Awaited<ReturnType<typeof parseAgent>>, skillName: string): boolean {
  const haystack = [
    agent.name,
    agent.description ?? '',
    agent.instructions,
  ].join('\n').toLowerCase();
  return haystack.includes(skillName.toLowerCase());
}

function globallyAllowsCommand(agent: Awaited<ReturnType<typeof parseAgent>>, command: string): boolean {
  for (const pattern of agent.config.tools?.bash?.commands ?? []) {
    const parts = pattern.trim().split(/\s+/);
    if (parts[0] === command && (parts.length === 1 || parts[1] === '*')) {
      return true;
    }
  }
  return false;
}

function parseSessionDirName(dirName: string): { id: string; agentName: string } | null {
  const ulidLength = 26;
  if (dirName.length < ulidLength + 2) return null;
  const id = dirName.slice(0, ulidLength);
  if (!/^[0-9A-Z]{26}$/i.test(id)) return null;
  return { id, agentName: dirName.slice(ulidLength + 1) };
}

async function readJsonFile<T>(filePath: string): Promise<T | null> {
  try {
    return JSON.parse(await fs.readFile(filePath, 'utf-8')) as T;
  } catch {
    return null;
  }
}

async function findLatestSessionForAgent(
  projectRoot: string,
  agentId: string,
  agentFilePath: string
): Promise<{ session: SessionInfo; dirPath: string } | null> {
  const sessionDir = await getSessionStorageDir(projectRoot);
  const entries = await fs.readdir(sessionDir, { withFileTypes: true }).catch(() => []);
  const matches: Array<{ session: SessionInfo; dirPath: string }> = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !parseSessionDirName(entry.name)) continue;
    const dirPath = path.join(sessionDir, entry.name);
    const session = await readJsonFile<SessionInfo>(path.join(dirPath, 'session.json'));
    if (!session) continue;

    const sessionAgentId = session.agent.id ?? session.agent.name;
    const sameAgent = sessionAgentId === agentId || (
      session.agent.filePath !== undefined && path.resolve(session.agent.filePath) === agentFilePath
    );
    if (sameAgent && !session.agent.isSubAgent) {
      matches.push({ session, dirPath });
    }
  }

  matches.sort((a, b) => b.session.time.created - a.session.time.created);
  return matches[0] ?? null;
}

async function readRuntimeSessionDetails(session: { session: SessionInfo; dirPath: string }): Promise<RuntimeSessionDetails> {
  const messages: RuntimeSessionDetails['messages'] = [];
  const entries = await fs.readdir(session.dirPath, { withFileTypes: true }).catch(() => []);
  const messageDirs = entries
    .filter((entry) => entry.isDirectory() && /^[0-9A-Z]{26}$/i.test(entry.name))
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const messageDir of messageDirs) {
    const messagePath = path.join(session.dirPath, messageDir.name);
    const message = await readJsonFile<Message>(path.join(messagePath, 'message.json'));
    if (!message) continue;

    const parts: Part[] = [];
    const partEntries = await fs.readdir(path.join(messagePath, 'part'), { withFileTypes: true }).catch(() => []);
    for (const partEntry of partEntries) {
      if (!partEntry.isFile() || !partEntry.name.endsWith('.json')) continue;
      const part = await readJsonFile<Part>(path.join(messagePath, 'part', partEntry.name));
      if (part) parts.push(part);
    }

    messages.push({ message, parts });
  }

  return {
    session: session.session,
    dirPath: session.dirPath,
    messages,
  };
}

function getToolInputCommand(part: ToolPart): string | undefined {
  const input = part.state.input;
  if (input && typeof input === 'object' && typeof (input as Record<string, unknown>).command === 'string') {
    return (input as Record<string, string>).command;
  }
  return undefined;
}

async function extractCommandHeads(command: string): Promise<string[]> {
  try {
    const parsed = await parseBashCommand(command);
    return [...new Set(parsed.map((item) => item.head).filter(Boolean))];
  } catch {
    const first = command.trim().split(/\s+/, 1)[0];
    return first ? [first] : [];
  }
}

function isBlockedCommandError(error: string): boolean {
  return error.includes('Command blocked by agent configuration')
    || error.includes('Command validation failed')
    || error.includes('Command not allowed')
    || error.includes('does not match any allowed pattern');
}

async function collectRuntimeProblems(details: RuntimeSessionDetails): Promise<RuntimeProblem[]> {
  const problems: RuntimeProblem[] = [];

  for (const entry of details.messages) {
    for (const part of entry.parts) {
      if (part.type !== 'tool' || part.state.status !== 'error') continue;
      if (part.tool !== 'tools__bash') continue;
      if (!isBlockedCommandError(part.state.error)) continue;

      const command = getToolInputCommand(part);
      const suggestedAllows = command ? await extractCommandHeads(command) : [];
      problems.push({
        tool: part.tool,
        ...(command && { command }),
        error: part.state.error,
        suggestedAllows,
      });
    }
  }

  return problems;
}

function printRuntimeSuggestion(problem: RuntimeProblem): void {
  const allows = problem.suggestedAllows.filter((allow) => allow !== 'cd');
  if (allows.length === 0) return;

  console.log(chalk.gray('  Suggested global allow:'));
  console.log('  tools:');
  console.log('    bash:');
  console.log('      commands:');
  for (const allow of allows) {
    console.log(`        - ${allow} *`);
  }
}

async function printLastRunAnalysis(
  agentFilePath: string,
  projectRoot: string,
  agent: Awaited<ReturnType<typeof parseAgent>>
): Promise<void> {
  const agentId = computeAgentId(agentFilePath, projectRoot, agent.name);
  const lastSession = await findLatestSessionForAgent(projectRoot, agentId, agentFilePath);

  console.log(chalk.bold('\nRuntime Analysis From Last Run'));
  if (!lastSession) {
    console.log(chalk.gray('No prior sessions found for this agent in the current project.'));
    return;
  }

  const details = await readRuntimeSessionDetails(lastSession);
  const problems = await collectRuntimeProblems(details);
  console.log(chalk.gray(`Session: ${details.session.id} (${details.session.status})`));

  if (problems.length === 0) {
    console.log(chalk.green('No blocked bash commands found in the last run.'));
    return;
  }

  for (const problem of problems) {
    console.log(chalk.red('\nBlocked bash command'));
    if (problem.command) {
      console.log(`  command: ${problem.command}`);
    }
    console.log(`  reason: ${problem.error.split('\n')[0]}`);
    printRuntimeSuggestion(problem);
  }
}

export async function runDoctor(file: string, options: DoctorOptions = {}): Promise<void> {
  const agentFilePath = resolve(file);
  const projectContext = resolveProjectContext(path.dirname(agentFilePath));
  const agent = await parseAgent(agentFilePath);

  console.log(chalk.bold(`Agent: ${agent.name}`));
  console.log(chalk.gray(`File: ${agentFilePath}`));

  if (options.lastRun) {
    await printLastRunAnalysis(agentFilePath, projectContext.projectRoot, agent);
    return;
  }

  const skills = await discoverSkills(projectContext.projectRoot);
  const explicitSkillNames = getExplicitSkillNames(agent.config.skills);
  const skillNames = explicitSkillNames.length > 0
      ? explicitSkillNames
      : agent.config.skills!.auto
        ? [...skills.keys()].filter((skillName) => skillLooksReferenced(agent, skillName))
        : [];

  const unknownExplicit = explicitSkillNames.filter((name) => !skills.has(name));
  const ungrantedExplicit = skillNames
    .filter((name) => skills.has(name))
    .filter((name) => !agent.config.skills!.trusted && !agent.config.skills!.explicit[name]?.allow?.length);
  const grantedBySkill = new Map(
    Object.entries(agent.config.skills!.explicit)
      .map(([name, grant]) => [name, new Set(grant.allow ?? [])])
  );
  const inspectedSkills = skillNames.filter((name) => skills.has(name)).sort();
  const commandReports = [];

  for (const skillName of inspectedSkills) {
    const skill = skills.get(skillName);
    if (!skill) continue;
    const content = await parseSkillContent(skill.location);
    const mentions = await extractSkillCommandMentions(content);
    const grants = grantedBySkill.get(skillName) ?? new Set<string>();
    const globallyAllowed = mentions
      .map((mention) => mention.command)
      .filter((command) => globallyAllowsCommand(agent, command))
      .sort();
    commandReports.push({
      skillName,
      mentions,
      grants: [...grants].sort(),
      globallyAllowed,
      ungranted: mentions
        .map((mention) => mention.command)
        .filter((command) => agent.config.skills!.trusted
          ? !globallyAllowsCommand(agent, command)
          : !grants.has('*') && !grants.has(command) && !globallyAllowsCommand(agent, command))
        .sort(),
    });
  }

  if (agent.config.skills!.trusted) {
    console.log(chalk.yellow('\nSkill trust: trusted'));
    console.log(chalk.gray('Loaded skills may use all tools already configured for this agent. This does not enable new tools.'));
  }

  if (unknownExplicit.length > 0) {
    console.log(chalk.red('\nProblems:'));
    for (const name of unknownExplicit) {
      console.log(`- Explicit skill not found: ${name}`);
    }
  }

  if (ungrantedExplicit.length > 0) {
    console.log(chalk.yellow('\nSkill grants:'));
    for (const name of ungrantedExplicit) {
      console.log(`- ${name} is inspectable/loaded but has no skill-scoped allow grants.`);
    }
    console.log(chalk.gray('\nAgentUse does not infer command needs from skill text. Add only the CLI families you intentionally trust, for example:'));
    console.log('skills:');
    if (agent.config.skills!.auto) {
      console.log('  auto: true');
    }
    for (const name of ungrantedExplicit) {
      console.log(`  ${name}:`);
      console.log('    allow: [<cli-name>]');
    }
  }

  if (commandReports.length > 0) {
    console.log(chalk.bold('\nCommands Mentioned By Skills'));
    console.log(chalk.gray('Advisory only: AgentUse extracts command-looking snippets from skill docs; it does not prove they are required.'));

    for (const report of commandReports) {
      console.log(`\n${chalk.cyan(report.skillName)}`);
      if (report.mentions.length === 0) {
        console.log(chalk.gray('  No command-looking snippets found.'));
      } else {
        console.log(`  mentioned: ${report.mentions.map((mention) => mention.command).join(', ')}`);
      }
      console.log(`  granted: ${agent.config.skills!.trusted ? 'trusted' : report.grants.length > 0 ? report.grants.join(', ') : '(none)'}`);
      if (report.globallyAllowed.length > 0) {
        console.log(`  already allowed globally: ${report.globallyAllowed.join(', ')}`);
      }
      if (report.ungranted.length > 0) {
        console.log(`  not covered: ${report.ungranted.join(', ')}`);
      }
    }
  }

  if (unknownExplicit.length === 0 && ungrantedExplicit.length === 0 && commandReports.every((report) => report.ungranted.length === 0)) {
    console.log(chalk.green('\nNo skill capability problems found.'));
    if (agent.config.skills!.auto && explicitSkillNames.length === 0 && commandReports.length === 0) {
      console.log(chalk.gray('Auto skills are enabled. Define core skills explicitly to include them in static inspection.'));
    }
  }

  console.log(chalk.gray('\nFor runtime-accurate diagnosis, run `agentuse doctor <agent-file> --last-run`.'));

  if (unknownExplicit.length > 0) {
    process.exitCode = 1;
  }
}

export function createDoctorCommand(): Command {
  return new Command('doctor')
    .description('Diagnose an AgentUse agent configuration')
    .argument('<file>', 'Agent file to diagnose')
    .option('--last-run', 'Analyze the latest recorded session for this agent')
    .action((file: string, options: DoctorOptions) => {
      runDoctor(file, options).catch((error) => {
        console.error(chalk.red(`Doctor failed: ${(error as Error).message}`));
        process.exit(1);
      });
    });
}
