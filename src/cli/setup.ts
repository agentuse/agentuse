import { Command } from 'commander';
import chalk from 'chalk';
import type * as ClackPrompts from '@clack/prompts';
import { FIRST_PROJECT_DEFAULT_NAME, terminalFirstAgentPrompt, validateManagedProjectName } from '../onboarding';
import { loadGlobalConfig } from '../utils/global-config';
import { createManagedProject, ManagedProjectError } from '../utils/managed-project';
import { createServeCommand } from './serve';

type SetupSurface = 'web' | 'terminal';

interface SetupOptions {
  web?: boolean;
  terminal?: boolean;
  name?: string;
  yes?: boolean;
  port?: string;
  host?: string;
  auth?: boolean;
}

let prompts: typeof ClackPrompts | undefined;
async function loadPrompts(): Promise<typeof ClackPrompts> {
  prompts ??= await import('@clack/prompts');
  return prompts;
}

export function resolveSetupSurface(
  options: Pick<SetupOptions, 'web' | 'terminal' | 'name' | 'yes'>,
  interactive: boolean,
): SetupSurface | 'prompt' {
  if (options.web && options.terminal) throw new Error('Choose either --web or --terminal, not both');
  if (options.web && (options.name !== undefined || options.yes)) {
    throw new Error('--name and --yes are terminal setup options; remove --web or use --terminal');
  }
  if (options.web) return 'web';
  if (options.terminal || options.name !== undefined || options.yes) return 'terminal';
  if (interactive) return 'prompt';
  throw new Error('Choose a setup surface: --web or --terminal');
}

async function chooseSurface(): Promise<SetupSurface | null> {
  const p = await loadPrompts();
  const selected = await p.select({
    message: 'How would you like to continue?',
    options: [
      { value: 'web', label: 'Browser', hint: 'guided visual setup' },
      { value: 'terminal', label: 'Terminal', hint: 'guided text setup' },
    ],
    initialValue: 'web',
  });
  if (p.isCancel(selected)) return null;
  return selected as SetupSurface;
}

async function promptProjectName(): Promise<string | null> {
  const p = await loadPrompts();
  const name = await p.text({
    message: 'Project name',
    initialValue: FIRST_PROJECT_DEFAULT_NAME,
    validate: (value) => {
      try {
        validateManagedProjectName(value);
      } catch (error) {
        return (error as Error).message;
      }
      return undefined;
    },
  });
  if (p.isCancel(name)) return null;
  return String(name);
}

export function webSetupServeArgs(
  options: Pick<SetupOptions, 'port' | 'host' | 'auth'>,
): string[] {
  const args = ['--open'];
  if (options.port) args.push('--port', options.port);
  if (options.host) args.push('--host', options.host);
  if (options.auth === false) args.push('--no-auth');
  return args;
}

async function runWebSetup(options: SetupOptions): Promise<void> {
  const args = webSetupServeArgs(options);
  await createServeCommand().parseAsync(args, { from: 'user' });
}

function printTerminalNextSteps(projectRoot: string): void {
  console.log(chalk.bold('\nNext — create your first agent'));
  console.log(chalk.dim('\n1. Start AgentUse in another terminal and leave it running:'));
  console.log(`\n   ${chalk.cyan('agentuse serve')}`);
  console.log(chalk.dim('\n2. Install the AgentUse skill for your coding agent (one time):'));
  console.log(`\n   ${chalk.cyan('npx skills add agentuse/agentuse')}`);
  console.log(chalk.dim('\n3. Open the project with your preferred coding agent:'));
  console.log(`\n   ${chalk.cyan(`cd ${JSON.stringify(projectRoot)}`)}`);
  console.log(`   ${chalk.cyan('codex')}  ${chalk.dim('# or: claude, pi')}`);
  console.log(chalk.dim('\n4. Paste this prompt:'));
  console.log(`\n${terminalFirstAgentPrompt(projectRoot)}`);
}

async function runTerminalSetup(options: SetupOptions, interactive: boolean): Promise<void> {
  let config;
  try {
    config = loadGlobalConfig();
  } catch (error) {
    console.error(chalk.red((error as Error).message));
    process.exitCode = 1;
    return;
  }

  const configured = config?.serve?.projects ?? [];
  if (configured.length > 0) {
    console.log(chalk.green('AgentUse is already set up.'));
    for (const project of configured) {
      console.log(`  ${chalk.cyan(project.id ?? 'project')}  ${chalk.dim(project.path)}`);
    }
    console.log(chalk.dim('\nStart AgentUse with:'));
    console.log(`\n  ${chalk.cyan('agentuse serve')}`);
    return;
  }

  let name = options.name;
  if (name === undefined) {
    if (options.yes) {
      name = FIRST_PROJECT_DEFAULT_NAME;
    } else if (interactive) {
      name = await promptProjectName() ?? undefined;
      if (name === undefined) {
        console.log(chalk.dim('Setup cancelled.'));
        return;
      }
    } else {
      console.error(chalk.red('Project name required in a non-interactive terminal.'));
      console.error(chalk.dim(`Run: agentuse setup --terminal --name ${FIRST_PROJECT_DEFAULT_NAME} --yes`));
      process.exitCode = 1;
      return;
    }
  }

  try {
    const project = await createManagedProject(name);
    console.log(chalk.green(`✓ Created project ${project.name}`));
    console.log(`  ${chalk.dim('Location')}  ${project.root}`);
    console.log(`  ${chalk.dim('Agents')}    ${project.root}/agents`);
    printTerminalNextSteps(project.root);
  } catch (error) {
    const message = error instanceof ManagedProjectError ? error.message : (error as Error).message;
    console.error(chalk.red(`Setup failed: ${message}`));
    process.exitCode = 1;
  }
}

export function createSetupCommand(): Command {
  return new Command('setup')
    .description('Set up AgentUse in a browser or terminal')
    .option('--web', 'Continue setup in the Web UI')
    .option('--terminal', 'Continue setup in the terminal')
    .option('--name <name>', `Managed project name (default: ${FIRST_PROJECT_DEFAULT_NAME})`)
    .option('-y, --yes', 'Accept the default project name without prompting')
    .option('-p, --port <number>', 'Web setup server port (default: 12233)')
    .option('-H, --host <string>', 'Web setup server host (default: 127.0.0.1)')
    .option('--no-auth', 'Disable server API key requirement (dangerous on publicly reachable hosts)')
    .action(async (options: SetupOptions) => {
      const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
      let surface: SetupSurface | 'prompt';
      try {
        surface = resolveSetupSurface(options, interactive);
      } catch (error) {
        console.error(chalk.red((error as Error).message));
        process.exitCode = 1;
        return;
      }

      if (surface === 'prompt') {
        const p = await loadPrompts();
        p.intro('AgentUse setup');
        const selected = await chooseSurface();
        if (!selected) {
          p.cancel('Setup cancelled.');
          return;
        }
        surface = selected;
      }

      if (surface === 'web') await runWebSetup(options);
      else await runTerminalSetup(options, interactive);
    });
}
