import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync, rmSync, mkdirSync, cpSync, statSync, readFileSync } from 'fs';
import { glob } from 'glob';
import { join, basename, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import * as readline from 'readline';
import * as p from '@clack/prompts';
import { resolveProjectContext } from '../utils/project.js';
import { telemetry, type AddCommandResult } from '../telemetry/index.js';

type SourceType = 'github' | 'git' | 'local' | 'skill';

/**
 * Extract a privacy-safe source identifier for telemetry
 * - GitHub: user/repo format
 * - Git URLs: extracts user/repo from common formats
 * - Local paths: returns undefined (privacy)
 */
function sanitizeSourceForTelemetry(source: string, type: SourceType): string | undefined {
  if (type === 'local' || type === 'skill') {
    // Don't track local paths for privacy
    return undefined;
  }

  if (type === 'github') {
    // GitHub shorthand: user/repo or user/repo#ref
    return source.split('#')[0];
  }

  if (type === 'git') {
    // Extract user/repo from git URLs
    // https://github.com/user/repo.git -> user/repo
    // git@github.com:user/repo.git -> user/repo
    const httpsMatch = source.match(/github\.com\/([^/]+\/[^/.]+)/);
    if (httpsMatch) return httpsMatch[1];

    const sshMatch = source.match(/github\.com:([^/]+\/[^/.]+)/);
    if (sshMatch) return sshMatch[1];

    // For other git hosts, just return the hostname
    try {
      const url = new URL(source);
      return url.hostname;
    } catch {
      return undefined;
    }
  }

  return undefined;
}

interface ResolvedSource {
  type: SourceType;
  path: string;
  ref?: string;
  needsClone: boolean;
}

interface SkillInfo {
  name: string;
  description: string;
  path: string;
}

interface AgentInfo {
  path: string;
  name: string;
}

interface CopyResult {
  skills: { name: string; action: 'added' | 'skipped' | 'overwritten' }[];
  agents: { path: string; action: 'added' | 'skipped' | 'overwritten' }[];
}

type ConflictMode = 'prompt' | 'skip-all' | 'overwrite-all';

/**
 * Resolve the source to a normalized format
 */
export function resolveSource(source: string): ResolvedSource {
  // Direct skill path (contains SKILL.md)
  if (existsSync(source) && existsSync(join(source, 'SKILL.md'))) {
    return { type: 'skill', path: resolve(source), needsClone: false };
  }

  // Local directory (starts with ./ or / or is an existing directory)
  if (source.startsWith('./') || source.startsWith('/') || (existsSync(source) && statSync(source).isDirectory())) {
    return { type: 'local', path: resolve(source), needsClone: false };
  }

  // Git URL (https:// or git@)
  if (source.startsWith('https://') || source.startsWith('git@')) {
    return { type: 'git', path: source, needsClone: true };
  }

  // GitHub shorthand (user/repo or user/repo#ref)
  const [repo, ref] = source.split('#');
  return { type: 'github', path: `https://github.com/${repo}.git`, ref, needsClone: true };
}

/**
 * Parse skill description from SKILL.md frontmatter
 */
function parseSkillDescription(skillMdPath: string): string {
  try {
    const content = readFileSync(skillMdPath, 'utf-8');
    const match = content.match(/^---\s*\n([\s\S]*?)\n---/);
    if (match) {
      const frontmatter = match[1];
      const descMatch = frontmatter.match(/description:\s*(.+)/);
      if (descMatch) {
        return descMatch[1].trim().replace(/^["']|["']$/g, '');
      }
    }
  } catch {
    // Ignore parse errors
  }
  return '';
}

/**
 * Discover available skills and agents in a directory
 */
export async function discoverItems(workDir: string): Promise<{ skills: SkillInfo[]; agents: AgentInfo[] }> {
  const skills: SkillInfo[] = [];
  const agents: AgentInfo[] = [];

  // Find skills
  const skillFiles = await glob('**/SKILL.md', {
    cwd: workDir,
    ignore: ['node_modules/**', '.git/**', 'docs/**', 'tests/**'],
  });

  for (const skillMd of skillFiles) {
    const skillDir = dirname(skillMd);
    const skillName = basename(skillDir);
    const description = parseSkillDescription(join(workDir, skillMd));
    skills.push({ name: skillName, description, path: skillDir });
  }

  // Find agents
  const agentFiles = await glob('**/*.agentuse', {
    cwd: workDir,
    ignore: ['node_modules/**', '.git/**', 'docs/**', 'tests/**'],
  });

  for (const agent of agentFiles) {
    agents.push({ path: agent, name: basename(agent, '.agentuse') });
  }

  return { skills, agents };
}

/**
 * Prompt user for conflict resolution
 */
async function promptConflict(
  type: 'skill' | 'agent',
  name: string
): Promise<'skip' | 'overwrite' | 'skip-all' | 'overwrite-all'> {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  return new Promise((resolve) => {
    console.log(chalk.yellow(`\n${type === 'skill' ? 'Skill' : 'Agent'} "${name}" already exists.`));
    rl.question(chalk.gray('  [s] Skip  [o] Overwrite  [a] Skip all  [O] Overwrite all: '), (answer) => {
      rl.close();
      switch (answer.trim()) {
        case 'o':
          resolve('overwrite');
          break;
        case 'a':
          resolve('skip-all');
          break;
        case 'O':
          resolve('overwrite-all');
          break;
        case 's':
        default:
          resolve('skip');
          break;
      }
    });
  });
}

/**
 * Copy a skill or agent, prompting on conflict
 */
async function copyWithConflictHandling(
  src: string,
  dest: string,
  type: 'skill' | 'agent',
  name: string,
  mode: ConflictMode
): Promise<{ action: 'added' | 'skipped' | 'overwritten'; newMode?: ConflictMode }> {
  const exists = existsSync(dest);

  if (exists) {
    if (mode === 'skip-all') {
      return { action: 'skipped' };
    }
    if (mode === 'overwrite-all') {
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      return { action: 'overwritten' };
    }

    // Prompt user
    const answer = await promptConflict(type, name);

    if (answer === 'skip-all') {
      return { action: 'skipped', newMode: 'skip-all' };
    }
    if (answer === 'overwrite-all') {
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      return { action: 'overwritten', newMode: 'overwrite-all' };
    }
    if (answer === 'overwrite') {
      rmSync(dest, { recursive: true, force: true });
      mkdirSync(dirname(dest), { recursive: true });
      cpSync(src, dest, { recursive: true });
      return { action: 'overwritten' };
    }
    return { action: 'skipped' };
  }

  // No conflict - just copy
  mkdirSync(dirname(dest), { recursive: true });
  cpSync(src, dest, { recursive: true });
  return { action: 'added' };
}

interface AddOptions {
  force?: boolean;
  selectedSkills?: string[] | undefined;
  selectedAgents?: string[] | undefined;
}

/**
 * Main add function
 */
export async function add(
  source: string,
  projectRoot: string,
  options: AddOptions = {}
): Promise<CopyResult> {
  const resolved = resolveSource(source);
  let workDir: string;
  let shouldCleanup = false;
  const result: CopyResult = { skills: [], agents: [] };
  let conflictMode: ConflictMode = options.force ? 'overwrite-all' : 'prompt';

  // 1. Get working directory
  if (resolved.needsClone) {
    workDir = join(tmpdir(), `agentuse-add-${Date.now()}`);
    const cloneCmd = resolved.ref
      ? `git clone --depth 1 --branch ${resolved.ref} "${resolved.path}" "${workDir}"`
      : `git clone --depth 1 "${resolved.path}" "${workDir}"`;

    console.log(chalk.gray(`Cloning ${resolved.path}...`));
    try {
      execSync(cloneCmd, { stdio: 'pipe' });
    } catch (error) {
      throw new Error(`Failed to clone repository: ${(error as Error).message}`);
    }
    shouldCleanup = true;
  } else {
    workDir = resolved.path;
  }

  try {
    // 2. Handle direct skill path
    if (resolved.type === 'skill') {
      const skillName = basename(workDir);
      const dest = join(projectRoot, '.agentuse', 'skills', skillName);
      const { action } = await copyWithConflictHandling(workDir, dest, 'skill', skillName, conflictMode);
      result.skills.push({ name: skillName, action });
      return result;
    }

    // 3. Find available items
    const { skills, agents } = await discoverItems(workDir);

    // 4. Filter by selection if provided
    const selectedSkills = options.selectedSkills;
    const selectedAgents = options.selectedAgents;

    // Copy skills
    for (const skill of skills) {
      if (selectedSkills && !selectedSkills.includes(skill.name)) {
        continue;
      }

      const src = join(workDir, skill.path);
      const dest = join(projectRoot, '.agentuse', 'skills', skill.name);

      const { action, newMode } = await copyWithConflictHandling(src, dest, 'skill', skill.name, conflictMode);
      if (newMode) conflictMode = newMode;
      result.skills.push({ name: skill.name, action });
    }

    // Copy agents
    for (const agent of agents) {
      if (selectedAgents && !selectedAgents.includes(agent.path)) {
        continue;
      }

      const src = join(workDir, agent.path);
      const dest = join(projectRoot, agent.path);

      const { action, newMode } = await copyWithConflictHandling(src, dest, 'agent', agent.path, conflictMode);
      if (newMode) conflictMode = newMode;
      result.agents.push({ path: agent.path, action });
    }

    return result;
  } finally {
    // 5. Cleanup
    if (shouldCleanup) {
      rmSync(workDir, { recursive: true, force: true });
    }
  }
}

/**
 * Print summary of what was added
 */
function printSummary(result: CopyResult): void {
  const skillsAdded = result.skills.filter((s) => s.action === 'added').length;
  const skillsOverwritten = result.skills.filter((s) => s.action === 'overwritten').length;
  const skillsSkipped = result.skills.filter((s) => s.action === 'skipped').length;

  const agentsAdded = result.agents.filter((a) => a.action === 'added').length;
  const agentsOverwritten = result.agents.filter((a) => a.action === 'overwritten').length;
  const agentsSkipped = result.agents.filter((a) => a.action === 'skipped').length;

  const lines: string[] = [];

  if (result.skills.length > 0) {
    const parts: string[] = [];
    if (skillsAdded > 0) parts.push(chalk.green(`${skillsAdded} added`));
    if (skillsOverwritten > 0) parts.push(chalk.yellow(`${skillsOverwritten} overwritten`));
    if (skillsSkipped > 0) parts.push(chalk.gray(`${skillsSkipped} skipped`));
    lines.push(`Skills: ${parts.join(', ')}`);

    for (const skill of result.skills) {
      const icon =
        skill.action === 'added' ? chalk.green('+') : skill.action === 'overwritten' ? chalk.yellow('~') : chalk.gray('-');
      lines.push(`  ${icon} ${skill.name}`);
    }
  }

  if (result.agents.length > 0) {
    const parts: string[] = [];
    if (agentsAdded > 0) parts.push(chalk.green(`${agentsAdded} added`));
    if (agentsOverwritten > 0) parts.push(chalk.yellow(`${agentsOverwritten} overwritten`));
    if (agentsSkipped > 0) parts.push(chalk.gray(`${agentsSkipped} skipped`));
    lines.push(`Agents: ${parts.join(', ')}`);

    for (const agent of result.agents) {
      const icon =
        agent.action === 'added' ? chalk.green('+') : agent.action === 'overwritten' ? chalk.yellow('~') : chalk.gray('-');
      lines.push(`  ${icon} ${agent.path}`);
    }
  }

  if (result.skills.length === 0 && result.agents.length === 0) {
    lines.push(chalk.gray('No skills or agents found in the source.'));
  }

  if (lines.length > 0) {
    p.log.success(lines.join('\n'));
  }
}

/**
 * Interactive selection prompt - combined skills and agents
 */
async function promptSelection(
  skills: SkillInfo[],
  agents: AgentInfo[],
  projectRoot: string
): Promise<{ selectedSkills: string[]; selectedAgents: string[] } | null> {
  // Build combined options with type prefixes
  const options: { value: string; label: string }[] = [];

  for (const s of skills) {
    const exists = existsSync(join(projectRoot, '.agentuse', 'skills', s.name));
    const marker = exists ? chalk.yellow(' (exists)') : '';
    options.push({ value: `skill:${s.name}`, label: `${chalk.blue('[skill]')} ${s.name}${marker}` });
  }

  for (const a of agents) {
    const exists = existsSync(join(projectRoot, a.path));
    const marker = exists ? chalk.yellow(' (exists)') : '';
    options.push({ value: `agent:${a.path}`, label: `${chalk.magenta('[agent]')} ${a.path}${marker}` });
  }

  if (options.length === 0) {
    return { selectedSkills: [], selectedAgents: [] };
  }

  const selection = await p.multiselect({
    message: 'Select items to install (use --list to see descriptions)',
    options,
    initialValues: options.map((o) => o.value),
    required: false,
  });

  if (p.isCancel(selection)) {
    return null;
  }

  const selected = selection as string[];
  const selectedSkills = selected.filter((v) => v.startsWith('skill:')).map((v) => v.slice(6));
  const selectedAgents = selected.filter((v) => v.startsWith('agent:')).map((v) => v.slice(6));

  return { selectedSkills, selectedAgents };
}

interface CliOptions {
  force?: boolean;
  all?: boolean;
  list?: boolean;
  skill?: string[];
  agent?: string[];
}

export function createAddCommand(): Command {
  const addCommand = new Command('add')
    .description('Add skills and agents from a GitHub repo, git URL, or local path')
    .argument('<source>', 'Source to add (user/repo, git URL, or local path)')
    .option('--force', 'Overwrite existing skills/agents without prompting')
    .option('--all', 'Install all skills and agents without prompting')
    .option('--list', 'List available skills and agents without installing')
    .option('-s, --skill <name...>', 'Install specific skill(s) by name')
    .option('-a, --agent <path...>', 'Install specific agent(s) by path')
    .action(async (source: string, options: CliOptions) => {
      const projectContext = resolveProjectContext(process.cwd());
      const startTime = Date.now();

      // Telemetry state - will be updated as we progress
      let telemetryData: Partial<AddCommandResult> = {
        sourceType: 'github', // Will be updated after resolving
        mode: options.list ? 'list' : options.all ? 'all' : options.skill || options.agent ? 'explicit' : 'interactive',
        force: options.force ?? false,
        success: false,
      };
      // Track if source is trackable (non-local)
      let isTrackableSource = false;

      p.intro(chalk.bold.blue('AgentUse Add'));
      p.log.info(chalk.gray(`Project: ${projectContext.projectRoot}`));

      try {
        // 1. Resolve and clone/access source
        const resolved = resolveSource(source);
        telemetryData.sourceType = resolved.type;
        const sanitizedSource = sanitizeSourceForTelemetry(source, resolved.type);
        if (sanitizedSource) {
          telemetryData.source = sanitizedSource;
          isTrackableSource = true;
        }

        let workDir: string;
        let shouldCleanup = false;

        if (resolved.needsClone) {
          workDir = join(tmpdir(), `agentuse-add-${Date.now()}`);
          const cloneCmd = resolved.ref
            ? `git clone --depth 1 --branch ${resolved.ref} "${resolved.path}" "${workDir}"`
            : `git clone --depth 1 "${resolved.path}" "${workDir}"`;

          const spinner = p.spinner();
          spinner.start(`Cloning ${resolved.path}`);
          try {
            execSync(cloneCmd, { stdio: 'pipe' });
            spinner.stop('Repository cloned');
          } catch (error) {
            spinner.stop('Clone failed');
            telemetryData.errorType = 'clone_failed';
            throw new Error(`Failed to clone repository: ${(error as Error).message}`);
          }
          shouldCleanup = true;
        } else {
          workDir = resolved.path;
        }

        try {
          // Handle direct skill path
          if (resolved.type === 'skill') {
            const result = await add(source, projectContext.projectRoot, { force: options.force ?? false });
            // Track installed skills (only for non-local sources)
            if (isTrackableSource) {
              const installed = result.skills.filter((s) => s.action === 'added' || s.action === 'overwritten');
              if (installed.length > 0) {
                telemetryData.skillsInstalled = installed.map((s) => s.name);
              }
            }
            telemetryData.success = true;
            printSummary(result);
            p.outro('Done');
            return;
          }

          // 2. Discover available items
          const { skills, agents } = await discoverItems(workDir);

          if (skills.length === 0 && agents.length === 0) {
            telemetryData.success = true;
            p.outro(chalk.gray('No skills or agents found in the source.'));
            return;
          }

          p.log.info(chalk.gray(`Found ${skills.length} skill(s), ${agents.length} agent(s)`));

          // 3. Handle --list mode
          if (options.list) {
            if (skills.length > 0) {
              const skillLines = skills.map((skill) => {
                const exists = existsSync(join(projectContext.projectRoot, '.agentuse', 'skills', skill.name));
                const marker = exists ? chalk.yellow(' (exists)') : '';
                const desc = skill.description ? `\n    ${chalk.gray(skill.description)}` : '';
                return `  ${chalk.cyan(skill.name)}${marker}${desc}`;
              });
              p.log.message(`${chalk.bold('Skills:')}\n${skillLines.join('\n')}`);
            }

            if (agents.length > 0) {
              const agentLines = agents.map((agent) => {
                const exists = existsSync(join(projectContext.projectRoot, agent.path));
                const marker = exists ? chalk.yellow(' (exists)') : '';
                return `  ${chalk.cyan(agent.path)}${marker}`;
              });
              p.log.message(`${chalk.bold('Agents:')}\n${agentLines.join('\n')}`);
            }

            telemetryData.success = true;
            p.outro('Use --skill or --agent to install specific items');
            return;
          }

          // 4. Determine what to install
          let selectedSkills: string[] | undefined;
          let selectedAgents: string[] | undefined;

          if (options.skill || options.agent) {
            // Explicit selection via flags
            selectedSkills = options.skill;
            selectedAgents = options.agent;

            // Validate selections
            if (selectedSkills) {
              const availableSkillNames = skills.map((s) => s.name);
              for (const name of selectedSkills) {
                if (!availableSkillNames.includes(name)) {
                  telemetryData.errorType = 'validation_failed';
                  throw new Error(`Skill "${name}" not found. Available: ${availableSkillNames.join(', ')}`);
                }
              }
            }
            if (selectedAgents) {
              const availableAgentPaths = agents.map((a) => a.path);
              for (const path of selectedAgents) {
                if (!availableAgentPaths.includes(path)) {
                  telemetryData.errorType = 'validation_failed';
                  throw new Error(`Agent "${path}" not found. Available: ${availableAgentPaths.join(', ')}`);
                }
              }
            }
          } else if (!options.all) {
            // Interactive selection
            const selection = await promptSelection(skills, agents, projectContext.projectRoot);
            if (!selection) {
              telemetryData.errorType = 'cancelled';
              telemetryData.success = false;
              p.outro('Cancelled');
              return;
            }
            selectedSkills = selection.selectedSkills;
            selectedAgents = selection.selectedAgents;

            if (selectedSkills.length === 0 && selectedAgents.length === 0) {
              telemetryData.success = true;
              p.outro('Nothing selected');
              return;
            }
          }
          // If --all, selectedSkills and selectedAgents remain undefined (install all)

          // 5. Install selected items
          const result = await add(source, projectContext.projectRoot, {
            force: options.force ?? false,
            selectedSkills,
            selectedAgents,
          });

          // Update telemetry with results (only for non-local sources)
          if (isTrackableSource) {
            const installedSkills = result.skills
              .filter((s) => s.action === 'added' || s.action === 'overwritten')
              .map((s) => s.name);
            const installedAgents = result.agents
              .filter((a) => a.action === 'added' || a.action === 'overwritten')
              .map((a) => basename(a.path, '.agentuse'));
            if (installedSkills.length > 0) {
              telemetryData.skillsInstalled = installedSkills;
            }
            if (installedAgents.length > 0) {
              telemetryData.agentsInstalled = installedAgents;
            }
          }
          telemetryData.success = true;

          printSummary(result);
          p.outro('Done');
        } finally {
          if (shouldCleanup) {
            rmSync(workDir, { recursive: true, force: true });
          }
        }
      } catch (error) {
        if (!telemetryData.errorType) {
          telemetryData.errorType = 'unknown';
        }
        p.outro(chalk.red(`Error: ${(error as Error).message}`));
        process.exit(1);
      } finally {
        // Capture telemetry
        telemetryData.durationMs = Date.now() - startTime;
        telemetry.captureAddCommand(telemetryData as AddCommandResult);
      }
    });

  return addCommand;
}
