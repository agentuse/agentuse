import { Command } from 'commander';
import chalk from 'chalk';
import { execFileSync } from 'child_process';
import { existsSync, rmSync, mkdirSync, cpSync, statSync, lstatSync, readdirSync, readlinkSync, readFileSync, realpathSync, renameSync } from 'fs';
import { glob } from 'glob';
import { join, basename, dirname, resolve } from 'path';
import { tmpdir } from 'os';
import * as readline from 'readline';
import type * as ClackPrompts from '@clack/prompts';

import { resolveProjectContext } from '../utils/project.js';
import { agentBaseName } from '../utils/agent-id.js';
import { isPathInside } from '../utils/path-policy.js';
import { telemetry, type AddCommandResult } from '../telemetry/index.js';

/**
 * @clack/prompts is ~4MB of interactive-terminal machinery that only this
 * command can reach, yet a static import made every other entry point pay for
 * it at startup -- including the serve workers, which can never prompt.
 * Every `p.*` call site below is reachable only from the async action handler,
 * which loads it first.
 */
let p!: typeof ClackPrompts;
async function loadPrompts(): Promise<void> {
  p ??= await import('@clack/prompts');
}

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
const GITHUB_REPO_RE = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const GIT_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function validateGitRef(ref: string): void {
  if (
    !GIT_REF_RE.test(ref) ||
    ref.includes('..') ||
    ref.endsWith('/') ||
    ref.endsWith('.') ||
    ref.includes('//')
  ) {
    throw new Error(`Invalid git ref: ${ref}`);
  }
}

function cloneSource(resolved: ResolvedSource, workDir: string): void {
  const args = ['clone', '--depth', '1'];
  if (resolved.ref) {
    validateGitRef(resolved.ref);
    args.push('--branch', resolved.ref);
  }
  args.push('--', resolved.path, workDir);
  execFileSync('git', args, { stdio: 'pipe' });
}

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
  const parts = source.split('#');
  if (parts.length > 2) {
    throw new Error(`Invalid GitHub source: ${source}`);
  }
  const [repo, ref] = parts;
  if (!repo || !GITHUB_REPO_RE.test(repo)) {
    throw new Error(`Invalid GitHub source: ${source}. Expected owner/repo or owner/repo#ref`);
  }
  if (ref) validateGitRef(ref);
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

interface DiscoveredItems {
  skills: SkillInfo[];
  agents: AgentInfo[];
}

/**
 * Discover available skills and agents in a directory.
 *
 * A SKILL.md at the root of `workDir` makes the whole directory one skill. Its
 * directory name is '.', which can never be an install target, so it is named
 * `rootSkillName` instead (the repo or directory name).
 */
export async function discoverItems(
  workDir: string,
  rootSkillName: string = basename(resolve(workDir))
): Promise<DiscoveredItems> {
  const skills: SkillInfo[] = [];
  const agents: AgentInfo[] = [];

  // Find skills
  const skillFiles = await glob('**/SKILL.md', {
    cwd: workDir,
    ignore: ['node_modules/**', '.git/**', 'docs/**', 'tests/**'],
  });

  for (const skillMd of skillFiles) {
    const skillDir = dirname(skillMd);
    const skillName = skillDir === '.' ? rootSkillName : basename(skillDir);
    const description = parseSkillDescription(join(workDir, skillMd));
    skills.push({ name: skillName, description, path: skillDir });
  }

  // Find agents
  const agentFiles = await glob('**/*.agentuse', {
    cwd: workDir,
    ignore: ['node_modules/**', '.git/**', 'docs/**', 'tests/**'],
  });

  for (const agent of agentFiles) {
    agents.push({ path: agent, name: agentBaseName(agent) });
  }

  return { skills, agents };
}

/** The name a source goes by: the repo name for remotes, the directory name for local paths. */
function sourceName(resolved: ResolvedSource): string {
  const last = resolved.path.split(/[\\/:]/).filter(Boolean).pop() ?? '';
  return last.replace(/\.git$/, '');
}

interface AcquiredSource {
  resolved: ResolvedSource;
  workDir: string;
  cleanup(): void;
}

/** Make a resolved source's files available locally, cloning a remote exactly once. */
function acquireSource(resolved: ResolvedSource): AcquiredSource {
  if (!resolved.needsClone) {
    return { resolved, workDir: resolved.path, cleanup: () => {} };
  }
  const workDir = join(tmpdir(), `agentuse-add-${Date.now()}`);
  try {
    cloneSource(resolved, workDir);
  } catch (error) {
    rmSync(workDir, { recursive: true, force: true });
    throw new Error(`Failed to clone repository: ${(error as Error).message}`);
  }
  return { resolved, workDir, cleanup: () => rmSync(workDir, { recursive: true, force: true }) };
}

/** Discover what a source offers. A direct skill path is exactly one skill: the directory itself. */
async function discoverSource(source: AcquiredSource): Promise<DiscoveredItems> {
  if (source.resolved.type === 'skill') {
    return {
      skills: [{
        name: sourceName(source.resolved),
        description: parseSkillDescription(join(source.workDir, 'SKILL.md')),
        path: '.',
      }],
      agents: [],
    };
  }
  return discoverItems(source.workDir, sourceName(source.resolved));
}

/** What to install: everything, or exactly the named skills and agent paths. */
export type Selection = 'all' | { skills: string[]; agents: string[] };

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

interface PlannedItem {
  kind: 'skill' | 'agent';
  /** Skill name or agent path, as shown to the user. */
  id: string;
  src: string;
  dest: string;
  /** The source already is the installed copy, so there is nothing to do. */
  sameItem: boolean;
}

/** Realpath of `path`, or of its nearest existing ancestor joined with the rest. */
function realpathLoose(path: string): string {
  const absolute = resolve(path);
  if (existsSync(absolute)) return realpathSync(absolute);
  const parent = dirname(absolute);
  if (parent === absolute) return absolute;
  return join(realpathLoose(parent), basename(absolute));
}

/** A clone's VCS metadata is never part of what gets installed. */
function isInstalledPath(path: string): boolean {
  return basename(path) !== '.git';
}

/**
 * The first symlink under `path` (or `path` itself) whose target lies outside
 * `boundary`. Links are read, never followed, so nothing outside the item is
 * touched. Every link is checked, so a chain can only escape through a link
 * that points outside on its own.
 */
function findEscapingSymlink(path: string, boundary: string): string | undefined {
  if (!isInstalledPath(path)) return undefined;
  const stat = lstatSync(path);
  if (stat.isSymbolicLink()) {
    const target = resolve(dirname(path), readlinkSync(path));
    // The boundary may sit under a symlinked ancestor (macOS /var), so a target
    // spelled through either form of it counts as inside.
    const inside = isPathInside(boundary, target) || isPathInside(realpathSync(boundary), target);
    return inside ? undefined : path;
  }
  if (!stat.isDirectory()) return undefined;
  for (const entry of readdirSync(path)) {
    const escaping = findEscapingSymlink(join(path, entry), boundary);
    if (escaping) return escaping;
  }
  return undefined;
}

function planItem(kind: PlannedItem['kind'], id: string, src: string, dest: string, container: string): PlannedItem {
  if (!isPathInside(resolve(container), resolve(dest), { allowEqual: false })) {
    throw new Error(`Refusing to install ${kind} "${id}": ${dest} is not inside ${container}`);
  }
  // A skill is its directory; an agent file is bounded by the directory it sits in.
  const boundary = kind === 'skill' ? resolve(src) : dirname(resolve(src));
  const escaping = findEscapingSymlink(resolve(src), boundary);
  if (escaping) {
    throw new Error(`Refusing to install ${kind} "${id}": symlink ${escaping} points outside ${boundary}`);
  }
  const realSrc = realpathSync(src);
  const realDest = realpathLoose(dest);
  const sameItem = realSrc === realDest;
  if (!sameItem && (isPathInside(realSrc, realDest) || isPathInside(realDest, realSrc))) {
    throw new Error(`Refusing to install ${kind} "${id}": source ${src} and destination ${dest} overlap`);
  }
  return { kind, id, src, dest, sameItem };
}

/**
 * Derive every install target up front, so an unsafe one aborts the whole
 * install before anything is written.
 */
function planInstall(workDir: string, items: DiscoveredItems, selection: Selection, projectRoot: string): PlannedItem[] {
  const skillsRoot = join(projectRoot, '.agentuse', 'skills');
  const plan: PlannedItem[] = [];
  for (const skill of items.skills) {
    if (selection !== 'all' && !selection.skills.includes(skill.name)) continue;
    plan.push(planItem('skill', skill.name, join(workDir, skill.path), join(skillsRoot, skill.name), skillsRoot));
  }
  for (const agent of items.agents) {
    if (selection !== 'all' && !selection.agents.includes(agent.path)) continue;
    plan.push(planItem('agent', agent.path, join(workDir, agent.path), join(projectRoot, agent.path), projectRoot));
  }
  // Two sources with one destination would silently overwrite each other.
  const byDest = new Map<string, PlannedItem>();
  for (const item of plan) {
    const earlier = byDest.get(resolve(item.dest));
    if (earlier) {
      throw new Error(
        `Refusing to install ${item.kind} "${item.id}": ${earlier.src} and ${item.src} both install to ${item.dest}`
      );
    }
    byDest.set(resolve(item.dest), item);
  }
  return plan;
}

/**
 * Copy `src` to `dest` through a sibling staging path. The previous install
 * is moved aside only once the new copy is complete, and is restored if the
 * swap fails, so a failed copy never destroys what was installed.
 */
function stagedInstall(src: string, dest: string): void {
  const parent = dirname(dest);
  mkdirSync(parent, { recursive: true });
  const tag = join(parent, `.${basename(dest)}.agentuse-add-${process.pid}-${Date.now()}`);
  const staged = `${tag}.new`;
  const backup = `${tag}.old`;
  try {
    cpSync(src, staged, { recursive: true, filter: isInstalledPath });
    const replacing = existsSync(dest);
    if (replacing) renameSync(dest, backup);
    try {
      renameSync(staged, dest);
    } catch (error) {
      if (replacing) renameSync(backup, dest);
      throw error;
    }
  } finally {
    rmSync(staged, { recursive: true, force: true });
  }
  try {
    rmSync(backup, { recursive: true, force: true });
  } catch (error) {
    console.warn(chalk.yellow(`Installed ${dest}, but could not remove the previous copy at ${backup}: ${(error as Error).message}`));
  }
}

/**
 * Install one planned item, prompting on conflict
 */
async function installWithConflictHandling(
  item: PlannedItem,
  mode: ConflictMode
): Promise<{ action: 'added' | 'skipped' | 'overwritten'; newMode?: ConflictMode | undefined }> {
  if (item.sameItem) {
    return { action: 'skipped' };
  }
  if (!existsSync(item.dest)) {
    stagedInstall(item.src, item.dest);
    return { action: 'added' };
  }

  const answer = mode === 'prompt' ? await promptConflict(item.kind, item.id) : mode;
  const newMode = answer === 'skip-all' || answer === 'overwrite-all' ? answer : undefined;
  if (answer === 'skip' || answer === 'skip-all') {
    return { action: 'skipped', newMode };
  }
  stagedInstall(item.src, item.dest);
  return { action: 'overwritten', newMode };
}

/**
 * Install the selected items from an acquired source into the project
 */
async function installItems(
  workDir: string,
  items: DiscoveredItems,
  selection: Selection,
  projectRoot: string,
  mode: ConflictMode
): Promise<CopyResult> {
  const plan = planInstall(workDir, items, selection, projectRoot);
  const result: CopyResult = { skills: [], agents: [] };
  let conflictMode = mode;
  for (const item of plan) {
    const { action, newMode } = await installWithConflictHandling(item, conflictMode);
    if (newMode) conflictMode = newMode;
    if (item.kind === 'skill') result.skills.push({ name: item.id, action });
    else result.agents.push({ path: item.id, action });
  }
  return result;
}

interface AddOptions {
  force?: boolean;
  selectedSkills?: string[] | undefined;
  selectedAgents?: string[] | undefined;
}

/**
 * Main add function. With no selection everything is installed; naming items
 * in either category installs exactly the named items.
 */
export async function add(
  source: string,
  projectRoot: string,
  options: AddOptions = {}
): Promise<CopyResult> {
  const resolved = resolveSource(source);
  if (resolved.needsClone) {
    console.log(chalk.gray(`Cloning ${resolved.path}...`));
  }
  const acquired = acquireSource(resolved);
  try {
    const items = await discoverSource(acquired);
    const selection: Selection =
      options.selectedSkills === undefined && options.selectedAgents === undefined
        ? 'all'
        : { skills: options.selectedSkills ?? [], agents: options.selectedAgents ?? [] };
    return await installItems(acquired.workDir, items, selection, projectRoot, options.force ? 'overwrite-all' : 'prompt');
  } finally {
    acquired.cleanup();
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
      await loadPrompts();
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

        let acquired: AcquiredSource;
        if (resolved.needsClone) {
          const spinner = p.spinner();
          spinner.start(`Cloning ${resolved.path}`);
          try {
            acquired = acquireSource(resolved);
            spinner.stop('Repository cloned');
          } catch (error) {
            spinner.stop('Clone failed');
            telemetryData.errorType = 'clone_failed';
            throw error;
          }
        } else {
          acquired = acquireSource(resolved);
        }

        try {
          // 2. Discover available items (a direct skill path is one skill)
          const items = await discoverSource(acquired);
          const { skills, agents } = items;

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

          // 4. Determine what to install. Naming items in either category
          // installs exactly those. --all, or a source that is itself one
          // skill, installs everything without asking.
          let selection: Selection;
          const installEverything = options.all || resolved.type === 'skill';

          if (options.skill || options.agent) {
            selection = { skills: options.skill ?? [], agents: options.agent ?? [] };

            const availableSkillNames = skills.map((s) => s.name);
            for (const name of selection.skills) {
              if (!availableSkillNames.includes(name)) {
                telemetryData.errorType = 'validation_failed';
                throw new Error(`Skill "${name}" not found. Available: ${availableSkillNames.join(', ')}`);
              }
            }
            const availableAgentPaths = agents.map((a) => a.path);
            for (const path of selection.agents) {
              if (!availableAgentPaths.includes(path)) {
                telemetryData.errorType = 'validation_failed';
                throw new Error(`Agent "${path}" not found. Available: ${availableAgentPaths.join(', ')}`);
              }
            }
          } else if (installEverything) {
            selection = 'all';
          } else {
            // Interactive selection
            const picked = await promptSelection(skills, agents, projectContext.projectRoot);
            if (!picked) {
              telemetryData.errorType = 'cancelled';
              telemetryData.success = false;
              p.outro('Cancelled');
              return;
            }
            if (picked.selectedSkills.length === 0 && picked.selectedAgents.length === 0) {
              telemetryData.success = true;
              p.outro('Nothing selected');
              return;
            }
            selection = { skills: picked.selectedSkills, agents: picked.selectedAgents };
          }

          // 5. Install selected items
          const result = await installItems(
            acquired.workDir,
            items,
            selection,
            projectContext.projectRoot,
            options.force ? 'overwrite-all' : 'prompt'
          );

          // Update telemetry with results (only for non-local sources)
          if (isTrackableSource) {
            const installedSkills = result.skills
              .filter((s) => s.action === 'added' || s.action === 'overwritten')
              .map((s) => s.name);
            const installedAgents = result.agents
              .filter((a) => a.action === 'added' || a.action === 'overwritten')
              .map((a) => agentBaseName(a.path));
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
          acquired.cleanup();
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
