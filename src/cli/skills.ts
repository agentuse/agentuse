import { Command } from 'commander';
import chalk from 'chalk';
import { homedir } from 'os';
import { dirname, join, relative } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';
import { readFile, stat } from 'fs/promises';
import { glob } from 'glob';
import {
  discoverSkills,
  discoverSkillsInDirectories,
  getDiscoveryDirectories,
} from '../skill/discovery.js';
import { parseSkillContent } from '../skill/parser.js';
import { resolveProjectContext } from '../utils/project.js';
import type { SkillContent, SkillInfo } from '../skill/types.js';

type SkillSource = 'builtin' | 'installed';

interface DirectoryInfo {
  path: string;
  label: string;
  exists: boolean;
}

interface ExtraSkillFile {
  path: string;
  content: string;
}

interface SkillsContext {
  projectRoot: string;
  source: SkillSource;
  directories: DirectoryInfo[];
  skills: Map<string, SkillInfo>;
}

interface ParsedSkillsArgs {
  command: 'list' | 'get' | 'path' | 'installed';
  args: string[];
  options: {
    verbose?: boolean;
    json?: boolean;
    all?: boolean;
    full?: boolean;
  };
}

function getPackageRoot(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const sourceRoot = join(moduleDir, '..', '..');
  if (existsSync(join(sourceRoot, 'package.json'))) {
    return sourceRoot;
  }
  return join(moduleDir, '..');
}

function getBuiltinDirectoryInfo(): DirectoryInfo[] {
  const path = join(getPackageRoot(), 'skill-data');
  return [{
    path,
    label: 'agentuse builtins',
    exists: existsSync(path),
  }];
}

function getInstalledDirectoryInfo(projectRoot: string): DirectoryInfo[] {
  const home = homedir();
  const labels = new Map([
    [join(projectRoot, '.agentuse', 'skills'), '.agentuse/skills'],
    [join(home, '.agentuse', 'skills'), '~/.agentuse/skills'],
    [join(projectRoot, '.claude', 'skills'), '.claude/skills'],
    [join(home, '.claude', 'skills'), '~/.claude/skills'],
  ]);

  return getDiscoveryDirectories(projectRoot).map((path) => ({
    path,
    label: labels.get(path) ?? path,
    exists: existsSync(path),
  }));
}

async function getSkillsContext(source: SkillSource): Promise<SkillsContext> {
  const projectContext = resolveProjectContext(process.cwd());
  const projectRoot = projectContext.projectRoot;

  if (source === 'builtin') {
    const directories = getBuiltinDirectoryInfo();
    const skills = await discoverSkillsInDirectories(directories.map((dir) => dir.path));
    return { projectRoot, source, directories, skills };
  }

  const directories = getInstalledDirectoryInfo(projectRoot);
  const skills = await discoverSkills(projectRoot);
  return { projectRoot, source, directories, skills };
}

function getSourceDir(location: string, directories: DirectoryInfo[]): string {
  for (const dir of directories) {
    if (location === dir.path || location.startsWith(`${dir.path}/`)) {
      return dir.label;
    }
  }
  return 'unknown';
}

function sortSkills(skills: Iterable<SkillInfo>): SkillInfo[] {
  return [...skills].sort((a, b) => a.name.localeCompare(b.name));
}

function skillToJson(skill: SkillInfo, source: string) {
  return {
    name: skill.name,
    description: skill.description,
    location: skill.location,
    source,
    allowedTools: skill.allowedTools ?? [],
    license: skill.license ?? null,
    compatibility: skill.compatibility ?? null,
    metadata: skill.metadata ?? null,
  };
}

async function listSkills(source: SkillSource, options: { verbose?: boolean; json?: boolean }) {
  const context = await getSkillsContext(source);
  const sortedSkills = sortSkills(context.skills.values());

  if (options.json) {
    console.log(JSON.stringify({
      project: context.projectRoot,
      source: context.source,
      count: sortedSkills.length,
      directories: context.directories,
      skills: sortedSkills.map((skill) => skillToJson(skill, getSourceDir(skill.location, context.directories))),
    }, null, 2));
    return;
  }

  if (context.skills.size === 0) {
    if (source === 'builtin') {
      console.log(chalk.gray('No builtin AgentUse skills found.'));
      console.log(chalk.gray('\nBuiltin skill directory:'));
    } else {
      console.log(chalk.gray('No installed skills found.'));
      console.log(chalk.gray('\nSkill directories searched:'));
    }
    for (const dir of context.directories) {
      console.log(chalk.gray(`  ${dir.label}: ${dir.path}`));
    }
    if (source === 'builtin') {
      console.log(chalk.gray('\nUse `agentuse skills installed` to inspect project and user-installed skills.'));
    }
    return;
  }

  const grouped = new Map<string, SkillInfo[]>();
  for (const skill of sortedSkills) {
    const label = getSourceDir(skill.location, context.directories);
    if (!grouped.has(label)) {
      grouped.set(label, []);
    }
    grouped.get(label)!.push(skill);
  }

  const noun = source === 'builtin' ? 'builtin skill' : 'installed skill';
  console.log(chalk.bold(`\nFound ${context.skills.size} ${noun}(s):\n`));

  for (const dir of context.directories) {
    const sourceSkills = grouped.get(dir.label);
    if (!sourceSkills?.length) {
      continue;
    }

    console.log(chalk.yellow(dir.label));
    for (const skill of sourceSkills) {
      console.log(`  ${chalk.cyan(skill.name)}`);
      console.log(chalk.gray(`    ${skill.description}`));
      if (options.verbose) {
        console.log(chalk.gray(`    ${skill.location}`));
      }
      if (skill.allowedTools?.length) {
        console.log(chalk.gray(`    tools: ${skill.allowedTools.join(', ')}`));
      }
    }
    console.log();
  }
}

function exitWithUnknownSkill(name: string, context: SkillsContext): never {
  const label = context.source === 'builtin' ? 'builtin skill' : 'installed skill';
  console.error(chalk.red(`Unknown ${label}: ${name}`));
  const names = sortSkills(context.skills.values()).map((skill) => skill.name);
  if (names.length > 0) {
    console.error(chalk.gray(`Available ${label}s: ${names.join(', ')}`));
  }
  if (context.source === 'builtin') {
    console.error(chalk.gray('Use `agentuse skills installed get <name>` to read project or user-installed skills.'));
  }
  process.exit(1);
}

async function readTextFile(path: string): Promise<string | undefined> {
  const buffer = await readFile(path);
  if (buffer.includes(0)) {
    return undefined;
  }
  return buffer.toString('utf-8');
}

async function loadExtraSkillFiles(skill: SkillContent): Promise<ExtraSkillFile[]> {
  const files = await glob('**/*', {
    cwd: skill.directory,
    absolute: true,
    nodir: true,
    ignore: ['SKILL.md', '**/.git/**', '**/node_modules/**'],
  });
  const extras: ExtraSkillFile[] = [];

  for (const file of files.sort()) {
    const fileStat = await stat(file);
    if (fileStat.size > 1024 * 1024) {
      continue;
    }
    const content = await readTextFile(file);
    if (content === undefined) {
      continue;
    }
    extras.push({
      path: relative(skill.directory, file),
      content,
    });
  }

  return extras;
}

async function loadSkillForOutput(skill: SkillInfo, full: boolean) {
  const raw = await readFile(skill.location, 'utf-8');
  const parsed = await parseSkillContent(skill.location);
  const files = full ? await loadExtraSkillFiles(parsed) : [];

  return {
    info: skill,
    parsed,
    raw,
    files,
  };
}

function renderSkillContent(
  skill: Awaited<ReturnType<typeof loadSkillForOutput>>,
  options: { full?: boolean | undefined; header?: string | undefined }
): string {
  const sections: string[] = [];
  if (options.header) {
    sections.push(`--- ${options.header} ---`);
  }
  sections.push(skill.raw.trimEnd());

  if (options.full) {
    for (const file of skill.files) {
      sections.push(`--- ${file.path} ---\n\n${file.content.trimEnd()}`);
    }
  }

  return sections.join('\n\n');
}

async function getSkills(source: SkillSource, names: string[], options: { all?: boolean; full?: boolean; json?: boolean }) {
  const context = await getSkillsContext(source);
  const requested = options.all
    ? sortSkills(context.skills.values())
    : names.map((name) => context.skills.get(name) ?? exitWithUnknownSkill(name, context));

  if (requested.length === 0) {
    console.error(chalk.red('Specify at least one skill name, or use --all.'));
    process.exit(1);
  }

  const loaded = await Promise.all(requested.map((skill) => loadSkillForOutput(skill, options.full === true)));

  if (options.json) {
    console.log(JSON.stringify({
      project: context.projectRoot,
      source: context.source,
      count: loaded.length,
      skills: loaded.map((skill) => ({
        ...skillToJson(skill.info, getSourceDir(skill.info.location, context.directories)),
        directory: skill.parsed.directory,
        content: skill.raw,
        files: skill.files,
      })),
    }, null, 2));
    return;
  }

  const includeHeaders = loaded.length > 1 || options.all === true;
  console.log(loaded.map((skill) => renderSkillContent(skill, {
    full: options.full,
    header: includeHeaders ? `${skill.info.name}/SKILL.md` : undefined,
  })).join('\n\n'));
}

async function printSkillPaths(source: SkillSource, name: string | undefined, options: { json?: boolean }) {
  const context = await getSkillsContext(source);

  if (!name) {
    if (options.json) {
      console.log(JSON.stringify({
        project: context.projectRoot,
        source: context.source,
        directories: context.directories,
      }, null, 2));
      return;
    }

    for (const dir of context.directories) {
      console.log(dir.path);
    }
    return;
  }

  const skill = context.skills.get(name) ?? exitWithUnknownSkill(name, context);
  const directory = dirname(skill.location);

  if (options.json) {
    console.log(JSON.stringify({
      name: skill.name,
      path: directory,
      skillFile: skill.location,
      source: getSourceDir(skill.location, context.directories),
    }, null, 2));
    return;
  }

  console.log(directory);
}

function parseSkillsArgs(tokens: string[] | undefined, options: ParsedSkillsArgs['options']): ParsedSkillsArgs {
  const remaining = [...(tokens ?? [])];
  const command = remaining[0] === 'get' || remaining[0] === 'path' || remaining[0] === 'list' || remaining[0] === 'installed'
    ? remaining.shift() as ParsedSkillsArgs['command']
    : 'list';
  const parsedOptions = { ...options };
  const args: string[] = [];

  for (const token of remaining) {
    if (token === '--json' || token === '-j') {
      parsedOptions.json = true;
    } else if (token === '--verbose' || token === '-v') {
      parsedOptions.verbose = true;
    } else if (token === '--all') {
      parsedOptions.all = true;
    } else if (token === '--full') {
      parsedOptions.full = true;
    } else if (token.startsWith('-')) {
      console.error(chalk.red(`Unknown option: ${token}`));
      process.exit(1);
    } else {
      args.push(token);
    }
  }

  return { command, args, options: parsedOptions };
}

async function dispatchSourceCommand(source: SkillSource, tokens: string[], options: ParsedSkillsArgs['options']) {
  const nested = parseSkillsArgs(tokens, options);

  if (nested.command === 'installed') {
    console.error(chalk.red('Unexpected nested `installed` subcommand.'));
    process.exit(1);
  }

  if (nested.command === 'list') {
    if (nested.args.length > 0) {
      console.error(chalk.red(`Unknown skills subcommand: ${nested.args[0]}`));
      process.exit(1);
    }
    await listSkills(source, nested.options);
    return;
  }

  if (nested.command === 'get') {
    await getSkills(source, nested.args, nested.options);
    return;
  }

  await printSkillPaths(source, nested.args[0], nested.options);
}

async function dispatchSkillsCommand(tokens: string[] | undefined, options: ParsedSkillsArgs['options']) {
  const parsed = parseSkillsArgs(tokens, options);

  if (parsed.command === 'installed') {
    await dispatchSourceCommand('installed', parsed.args, parsed.options);
    return;
  }

  await dispatchSourceCommand('builtin', [parsed.command, ...parsed.args], parsed.options);
}

export function createSkillsCommand(): Command {
  const skillsCommand = new Command('skills')
    .description('List and retrieve AgentUse builtin skills')
    .usage('[subcommand] [options]')
    .argument('[tokens...]', 'Subcommand and arguments')
    .option('-v, --verbose', 'Show skill file paths')
    .option('-j, --json', 'Output as JSON')
    .option('--all', 'Output every skill when using get')
    .option('--full', 'Include supporting files when using get')
    .addHelpText('after', `

Subcommands:
  list                       List AgentUse builtin skills (default)
  get <name> [name...]       Output builtin skill content
  get <name> --full          Include references and templates
  get --all                  Output every builtin skill
  path [name]                Print builtin skill path(s)
  installed [subcommand]     Inspect project and user-installed skills

Installed skill subcommands:
  installed list             List installed/discovered skills
  installed get <name>       Output installed skill content
  installed path [name]      Print installed discovery paths or a skill path

Examples:
  agentuse skills
  agentuse skills list
  agentuse skills get core
  agentuse skills get core --full
  agentuse skills get runner
  agentuse skills get creator
  agentuse skills path core
  agentuse skills installed
  agentuse skills installed list --json
  agentuse skills installed get code-review
`)
    .action(dispatchSkillsCommand);

  return skillsCommand;
}
