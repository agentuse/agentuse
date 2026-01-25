import { Command } from 'commander';
import chalk from 'chalk';
import { execSync } from 'child_process';
import { existsSync, rmSync, mkdirSync, cpSync, statSync } from 'fs';
import { glob } from 'glob';
import { join, basename, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import * as readline from 'readline';
import { resolveProjectContext } from '../utils/project.js';

type SourceType = 'github' | 'git' | 'local' | 'skill';

interface ResolvedSource {
  type: SourceType;
  path: string;
  ref?: string;
  needsClone: boolean;
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

/**
 * Main add function
 */
export async function add(source: string, projectRoot: string, options: { force?: boolean } = {}): Promise<CopyResult> {
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

    // 3. Find and copy skills (any SKILL.md in the repo)
    const skillFiles = await glob('**/SKILL.md', {
      cwd: workDir,
      ignore: ['node_modules/**', '.git/**', 'docs/**', 'tests/**'],
    });

    for (const skillMd of skillFiles) {
      const skillDir = dirname(skillMd);
      const skillName = basename(skillDir);
      const src = join(workDir, skillDir);
      const dest = join(projectRoot, '.agentuse', 'skills', skillName);

      const { action, newMode } = await copyWithConflictHandling(src, dest, 'skill', skillName, conflictMode);
      if (newMode) conflictMode = newMode;
      result.skills.push({ name: skillName, action });
    }

    // 4. Find and copy agents (preserve directory structure)
    const agentFiles = await glob('**/*.agentuse', {
      cwd: workDir,
      ignore: ['node_modules/**', '.git/**', 'docs/**', 'tests/**'],
    });

    for (const agent of agentFiles) {
      const src = join(workDir, agent);
      const dest = join(projectRoot, agent);

      const { action, newMode } = await copyWithConflictHandling(src, dest, 'agent', agent, conflictMode);
      if (newMode) conflictMode = newMode;
      result.agents.push({ path: agent, action });
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

  console.log();
  console.log(chalk.bold('Summary:'));

  if (result.skills.length > 0) {
    const parts: string[] = [];
    if (skillsAdded > 0) parts.push(chalk.green(`${skillsAdded} added`));
    if (skillsOverwritten > 0) parts.push(chalk.yellow(`${skillsOverwritten} overwritten`));
    if (skillsSkipped > 0) parts.push(chalk.gray(`${skillsSkipped} skipped`));
    console.log(`  Skills: ${parts.join(', ')}`);

    for (const skill of result.skills) {
      const icon =
        skill.action === 'added' ? chalk.green('+') : skill.action === 'overwritten' ? chalk.yellow('~') : chalk.gray('-');
      console.log(`    ${icon} ${skill.name}`);
    }
  }

  if (result.agents.length > 0) {
    const parts: string[] = [];
    if (agentsAdded > 0) parts.push(chalk.green(`${agentsAdded} added`));
    if (agentsOverwritten > 0) parts.push(chalk.yellow(`${agentsOverwritten} overwritten`));
    if (agentsSkipped > 0) parts.push(chalk.gray(`${agentsSkipped} skipped`));
    console.log(`  Agents: ${parts.join(', ')}`);

    for (const agent of result.agents) {
      const icon =
        agent.action === 'added' ? chalk.green('+') : agent.action === 'overwritten' ? chalk.yellow('~') : chalk.gray('-');
      console.log(`    ${icon} ${agent.path}`);
    }
  }

  if (result.skills.length === 0 && result.agents.length === 0) {
    console.log(chalk.gray('  No skills or agents found in the source.'));
  }
}

export function createAddCommand(): Command {
  const addCommand = new Command('add')
    .description('Add skills and agents from a GitHub repo, git URL, or local path')
    .argument('<source>', 'Source to add (user/repo, git URL, or local path)')
    .option('--force', 'Overwrite existing skills/agents without prompting')
    .option('--dry-run', 'Preview what would be added without making changes')
    .action(async (source: string, options: { force?: boolean; dryRun?: boolean }) => {
      const projectContext = resolveProjectContext(process.cwd());

      console.log();
      console.log(chalk.bold.blue('◆ AgentUse Add'));
      console.log(chalk.gray(`  Project: ${projectContext.projectRoot}`));
      console.log();

      if (options.dryRun) {
        console.log(chalk.yellow('Dry run mode - no files will be modified'));
        console.log();
      }

      try {
        // For dry-run, we still need to clone/resolve to see what's there
        const resolved = resolveSource(source);
        let workDir: string;
        let shouldCleanup = false;

        if (resolved.needsClone) {
          workDir = join(tmpdir(), `agentuse-add-${Date.now()}`);
          const cloneCmd = resolved.ref
            ? `git clone --depth 1 --branch ${resolved.ref} "${resolved.path}" "${workDir}"`
            : `git clone --depth 1 "${resolved.path}" "${workDir}"`;

          console.log(chalk.gray(`Cloning ${resolved.path}...`));
          execSync(cloneCmd, { stdio: 'pipe' });
          shouldCleanup = true;
        } else {
          workDir = resolved.path;
        }

        try {
          if (options.dryRun) {
            // Preview mode - just list what would be added
            const result: CopyResult = { skills: [], agents: [] };

            if (resolved.type === 'skill') {
              const skillName = basename(workDir);
              const dest = join(projectContext.projectRoot, '.agentuse', 'skills', skillName);
              const exists = existsSync(dest);
              result.skills.push({ name: skillName, action: exists ? 'overwritten' : 'added' });
            } else {
              const skillFiles = await glob('**/SKILL.md', {
                cwd: workDir,
                ignore: ['node_modules/**', '.git/**', 'docs/**', 'tests/**'],
              });

              for (const skillMd of skillFiles) {
                const skillDir = dirname(skillMd);
                const skillName = basename(skillDir);
                const dest = join(projectContext.projectRoot, '.agentuse', 'skills', skillName);
                const exists = existsSync(dest);
                result.skills.push({ name: skillName, action: exists ? 'overwritten' : 'added' });
              }

              const agentFiles = await glob('**/*.agentuse', {
                cwd: workDir,
                ignore: ['node_modules/**', '.git/**', 'docs/**', 'tests/**'],
              });

              for (const agent of agentFiles) {
                const dest = join(projectContext.projectRoot, agent);
                const exists = existsSync(dest);
                result.agents.push({ path: agent, action: exists ? 'overwritten' : 'added' });
              }
            }

            console.log(chalk.bold('Would add:'));
            for (const skill of result.skills) {
              const exists = skill.action === 'overwritten';
              console.log(`  ${exists ? chalk.yellow('~') : chalk.green('+')} skill: ${skill.name}${exists ? ' (exists)' : ''}`);
            }
            for (const agent of result.agents) {
              const exists = agent.action === 'overwritten';
              console.log(`  ${exists ? chalk.yellow('~') : chalk.green('+')} agent: ${agent.path}${exists ? ' (exists)' : ''}`);
            }

            if (result.skills.length === 0 && result.agents.length === 0) {
              console.log(chalk.gray('  No skills or agents found in the source.'));
            }
          } else {
            // Actual add
            const result = await add(source, projectContext.projectRoot, { force: options.force ?? false });
            printSummary(result);
          }
        } finally {
          if (shouldCleanup) {
            rmSync(workDir, { recursive: true, force: true });
          }
        }
      } catch (error) {
        console.error(chalk.red(`Error: ${(error as Error).message}`));
        process.exit(1);
      }
    });

  return addCommand;
}
