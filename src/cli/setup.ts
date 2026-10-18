import { Command } from 'commander';
import chalk from 'chalk';
import type * as ClackPrompts from '@clack/prompts';
import type { ProviderStatus } from '../auth/provider-status';
import { cloudUrl, computerName, platformLabel, readCloudConnection, removeCloudConnection, writeCloudConnection, type CloudConnection } from '../cloud/config';
import { connectionRevoked, startPairing, waitForApproval } from '../cloud/pairing';
import { FIRST_PROJECT_DEFAULT_NAME } from '../onboarding';
import { loadGlobalConfig } from '../utils/global-config';
import { createManagedProject, ManagedProjectError } from '../utils/managed-project';
import { openBrowser } from '../utils/open-browser';
import { cliCommand } from '../utils/npx';
import { findServerForProject, serverBaseUrl } from '../utils/server-registry';
import { createServeCommand } from './serve';
import { installService, serviceInstalled, serviceLogPath, serviceProgram } from './service';

/**
 * `agentuse setup`: one flow from install to a running AgentUse, in four steps.
 *
 *   1. Where you use it: Cloud (from an AI assistant) or Local (this computer only)
 *   2. Sign in, Cloud only: this computer shows a code, the person types it on the web
 *   3. Pick the AI that runs agents
 *   4. Ready: a project, and `agentuse serve` kept running in the background
 *
 * Every step that is already done shows a ✓ and is skipped, so running it
 * again is safe. `agentuse connect` is this flow with Cloud already picked.
 */

export interface SetupOptions {
  web?: boolean;
  terminal?: boolean;
  cloud?: boolean;
  local?: boolean;
  name?: string;
  computerName?: string;
  url?: string;
  yes?: boolean;
  /** `--no-service` sets this to false. */
  service?: boolean;
  /** `--no-browser` sets this to false. */
  browser?: boolean;
  port?: string;
  host?: string;
  auth?: boolean;
}

export type SetupRoute = 'cloud' | 'local';

let prompts: typeof ClackPrompts | undefined;
async function loadPrompts(): Promise<typeof ClackPrompts> {
  prompts ??= await import('@clack/prompts');
  return prompts;
}

/** Which route to take without asking, or 'prompt' when the person should choose. */
export function resolveRoute(
  options: Pick<SetupOptions, 'cloud' | 'local' | 'yes'>,
  connected: boolean,
  interactive: boolean,
): SetupRoute | 'prompt' {
  if (options.cloud && options.local) throw new Error('Choose either --cloud or --local, not both');
  if (options.local && connected) {
    throw new Error('This computer is connected to AgentUse Cloud. Run `agentuse disconnect` first to use it locally only.');
  }
  if (options.cloud || connected) return 'cloud';
  if (options.local) return 'local';
  if (interactive && !options.yes) return 'prompt';
  return 'local';
}

export type AiStep =
  | { kind: 'ready'; label: string }
  | { kind: 'save-env'; provider: string; providerName: string; envVar: string }
  | { kind: 'ask' };

/**
 * Whether an AI is ready for agents. A key that only lives in this shell does
 * not reach the background service, so it is offered for saving instead.
 */
export function aiStep(status: Pick<ProviderStatus, 'providers' | 'customProviders'>): AiStep {
  for (const provider of status.providers) {
    const stored = provider.sources.find((source) => source.stored);
    if (provider.configured && stored) return { kind: 'ready', label: `${provider.name} (${stored.name})` };
  }
  // A model on this computer (Ollama, LM Studio) needs no key; it was checked when saved.
  const custom = status.customProviders.find((provider) => provider.hasApiKey || (provider.models?.length ?? 0) > 0);
  if (custom) return { kind: 'ready', label: custom.id };
  for (const provider of status.providers) {
    const env = provider.sources.find((source) => source.kind === 'environment');
    if (provider.configured && env) {
      return { kind: 'save-env', provider: provider.id, providerName: provider.name, envVar: env.name };
    }
  }
  return { kind: 'ask' };
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

class SetupCancelled extends Error {}

async function ask<T>(value: Promise<T | symbol>): Promise<T> {
  const p = await loadPrompts();
  const answer = await value;
  if (p.isCancel(answer)) throw new SetupCancelled();
  return answer as T;
}

async function chooseRoute(): Promise<SetupRoute> {
  const p = await loadPrompts();
  return ask(p.select<SetupRoute>({
    message: 'Where will you use AgentUse?',
    options: [
      { value: 'cloud', label: 'From your AI assistant', hint: 'Cloud · Claude, ChatGPT, Claude Code, Codex and any MCP app' },
      { value: 'local', label: 'Only on this computer', hint: 'no account' },
    ],
    initialValue: 'cloud',
  }));
}

const signedInLine = (connection: CloudConnection): string =>
  `Signed in  ${chalk.dim(`${connection.account ?? 'your account'} · ${connection.name}`)}`;

async function signIn(options: SetupOptions): Promise<CloudConnection> {
  const p = await loadPrompts();
  const url = cloudUrl(options.url);
  const name = options.computerName ?? computerName();

  const start = await startPairing(url, name, platformLabel());
  p.log.step('Sign in to AgentUse Cloud');
  p.log.message([
    `Open   ${chalk.cyan(start.verification_uri)}`,
    `Code   ${chalk.bold(start.user_code)}`,
    chalk.dim('Sign in there and type the code. No browser here (SSH, a server)? Open the link on any phone or laptop.'),
  ].join('\n'));
  // Like `gh auth login`: the page asks for the code, so a link someone sends
  // can never carry one that adds their computer to your account.
  if (options.browser !== false) await openBrowser(start.verification_uri);
  const spin = p.spinner();
  spin.start('Waiting for you to type the code');
  try {
    const approved = await waitForApproval(url, start);
    const connection = { ...approved, url, connectedAt: new Date().toISOString() };
    writeCloudConnection(connection);
    spin.stop(signedInLine(connection));
    return connection;
  } catch (error) {
    spin.stop('Not connected', 1);
    throw error;
  }
}

async function chatGptLogin(): Promise<void> {
  const p = await loadPrompts();
  const { startProviderOAuth, completeProviderOAuth } = await import('../auth/provider-setup');
  const flow = await startProviderOAuth('openai');
  p.log.message([
    'Sign in to ChatGPT in your browser. Afterwards the page may show an error: that is expected.',
    'Copy the full address from the browser and paste it here.',
    '',
    chalk.cyan(flow.authorizationUrl),
  ].join('\n'));
  await openBrowser(flow.authorizationUrl);
  const callback = await ask(p.text({ message: 'Paste the address from your browser' }));
  await completeProviderOAuth(flow.flowId, callback);
}

async function pasteKey(): Promise<void> {
  const p = await loadPrompts();
  const { saveProviderApiKey } = await import('../auth/provider-setup');
  const provider = await ask(p.select<string>({
    message: 'Whose key?',
    options: [
      { value: 'anthropic', label: 'Anthropic', hint: 'Claude models' },
      { value: 'openai', label: 'OpenAI' },
      { value: 'openrouter', label: 'OpenRouter', hint: 'many models' },
      { value: 'opencode-go', label: 'OpenCode Go' },
    ],
  }));
  const key = await ask(p.password({ message: 'API key', validate: (value) => (value?.trim() ? undefined : 'Paste the key') }));
  await saveProviderApiKey(provider, key);
}

async function pickAi(interactive: boolean, yes: boolean | undefined): Promise<void> {
  const p = await loadPrompts();
  const { getProviderStatus } = await import('../auth/provider-status');
  const step = aiStep(await getProviderStatus({ readiness: 'defer' }));
  if (step.kind === 'ready') {
    p.log.success(`AI  ${chalk.dim(step.label)}`);
    return;
  }
  if (!interactive || yes) {
    p.log.warn(step.kind === 'save-env'
      ? `${step.envVar} is only set in this shell, so the background service won't see it. Run \`${cliCommand()} provider login\`.`
      : `No AI is set up to run agents yet. Run \`${cliCommand()} provider login\`.`);
    return;
  }

  type Choice = 'save-env' | 'chatgpt' | 'key' | 'skip';
  const options: { value: Choice; label: string; hint?: string }[] = [];
  if (step.kind === 'save-env') {
    options.push({ value: 'save-env', label: `Use ${step.envVar} from your shell`, hint: 'found · saved so agents can use it in the background' });
  }
  options.push(
    { value: 'chatgpt', label: 'Sign in with ChatGPT', hint: 'uses your ChatGPT plan' },
    { value: 'key', label: 'Paste an API key', hint: 'Anthropic, OpenAI, OpenRouter' },
    { value: 'skip', label: 'Skip for now' },
  );
  p.log.message(chalk.dim('Your assistant writes agents. This AI runs them here, on schedule.\nKeys stay on this computer. A Claude Pro or Max plan can\'t run agents here.'));
  const choice = await ask(p.select<Choice>({ message: 'Which AI runs your agents?', options, initialValue: options[0]!.value }));

  if (choice === 'skip') {
    p.log.warn(`No AI yet. Agents can't run until you add one: \`${cliCommand()} provider login\`.`);
    return;
  }
  if (choice === 'save-env' && step.kind === 'save-env') {
    const { saveProviderApiKey } = await import('../auth/provider-setup');
    await saveProviderApiKey(step.provider, process.env[step.envVar]);
    p.log.success(`AI  ${chalk.dim(`${step.providerName}, from ${step.envVar}`)}`);
    return;
  }
  if (choice === 'chatgpt') await chatGptLogin();
  else await pasteKey();
  p.log.success(`AI  ${chalk.dim(choice === 'chatgpt' ? 'your ChatGPT plan' : 'key saved')}`);
}

async function ensureProject(options: SetupOptions): Promise<void> {
  const p = await loadPrompts();
  const configured = loadGlobalConfig()?.serve?.projects ?? [];
  if (configured.length > 0) {
    p.log.success(`Project  ${chalk.dim(configured.map((project) => project.path).join(', '))}`);
    return;
  }
  try {
    const project = await createManagedProject(options.name ?? FIRST_PROJECT_DEFAULT_NAME);
    p.log.success(`Project  ${chalk.dim(project.root)}`);
  } catch (error) {
    const message = error instanceof ManagedProjectError ? error.message : (error as Error).message;
    throw new Error(`Could not create the project: ${message}`);
  }
}

/** Keep `agentuse serve` running. Returns the dashboard address when one is known. */
async function keepRunning(options: SetupOptions): Promise<string | undefined> {
  const p = await loadPrompts();
  const running = findServerForProject();
  const runningUrl = running ? serverBaseUrl(running) : undefined;
  if (options.service === false) {
    p.log.info(runningUrl ? `Running  ${chalk.dim(runningUrl)}` : `Not started. Run \`${cliCommand()} serve\` and leave it open.`);
    return runningUrl;
  }
  // Already running some other way (pm2, a terminal, the Mac app): leave it be.
  if (running && !serviceInstalled()) {
    p.log.success(`Running  ${chalk.dim(`${runningUrl}, started another way`)}`);
    return runningUrl;
  }
  const resolved = serviceProgram();
  if (!resolved.ok) {
    p.log.warn(resolved.reason === 'npx'
      ? 'To keep AgentUse running in the background, install it first with `npm i -g agentuse`, then run `agentuse setup` again.'
      : `A background service isn't available here. Run \`${cliCommand()} serve\` and leave it open.`);
    return runningUrl;
  }
  const spin = p.spinner();
  spin.start('Starting AgentUse in the background');
  try {
    await installService(resolved.program);
    let server = findServerForProject();
    for (let tries = 0; !server && tries < 20; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      server = findServerForProject();
    }
    spin.stop(`Background  ${chalk.dim('starts when you log in')}`);
    return server ? serverBaseUrl(server) : undefined;
  } catch (error) {
    spin.stop('Could not start the background service', 1);
    p.log.warn(`${(error as Error).message}\nRun \`${cliCommand()} serve\` instead. Logs: ${serviceLogPath()}`);
    return runningUrl;
  }
}

export function readyText(route: SetupRoute, mcpUrl: string | undefined, dashboard: string | undefined, command = cliCommand()): string {
  if (route === 'cloud' && mcpUrl) {
    return [
      chalk.bold('You\'re set.'),
      '',
      'Came from the Claude or ChatGPT plugin? Go back and ask again.',
      '',
      'Otherwise, add this to your AI assistant:',
      `  ${chalk.green.bold(mcpUrl)}`,
      chalk.dim('  How to add it: https://docs.agentuse.io/guides/agentuse-cloud'),
      '',
      chalk.dim(`Check any time: ${command} status`),
    ].join('\n');
  }
  const base = dashboard ?? 'http://127.0.0.1:12233';
  return [
    chalk.bold('You\'re set.'),
    '',
    `Dashboard     ${chalk.cyan(base)}`,
    `Claude Code   ${chalk.cyan(`claude mcp add --transport http agentuse ${base}/mcp`)}`,
    '',
    chalk.dim(`Use it from Claude or ChatGPT later: ${command} connect`),
  ].join('\n');
}

export async function runSetup(options: SetupOptions): Promise<void> {
  const interactive = Boolean(process.stdin.isTTY && process.stdout.isTTY);
  const p = await loadPrompts();
  let connection: CloudConnection | undefined;
  try {
    connection = readCloudConnection();
  } catch (error) {
    console.error(chalk.red((error as Error).message));
    process.exitCode = 1;
    return;
  }

  // Disconnected from the account page: forget the dead token and sign in again.
  const revoked = connection !== undefined && await connectionRevoked(connection);
  if (revoked) {
    removeCloudConnection();
    connection = undefined;
  }

  try {
    const decided = resolveRoute(options, Boolean(connection), interactive);
    p.intro('AgentUse setup');
    const route = decided === 'prompt' ? await chooseRoute() : decided;
    p.log.success(`Where  ${chalk.dim(route === 'cloud' ? 'AgentUse Cloud' : 'Only on this computer')}`);

    if (route === 'cloud') {
      if (revoked) p.log.warn('This computer was disconnected from your account, so it signs in again.');
      if (connection) {
        p.log.success(signedInLine(connection));
      } else {
        connection = await signIn(options);
      }
    }
    await pickAi(interactive, options.yes);
    await ensureProject(options);
    const dashboard = await keepRunning(options);
    p.outro(readyText(route, connection?.mcpUrl, dashboard));
  } catch (error) {
    if (error instanceof SetupCancelled) {
      p.cancel('Setup cancelled. Run it again any time; finished steps are kept.');
      return;
    }
    p.log.error((error as Error).message);
    process.exitCode = 1;
  }
}

export function createSetupCommand(): Command {
  return new Command('setup')
    .description('Set up AgentUse: where you use it, sign in, the AI that runs agents, and keep it running')
    .option('--cloud', 'Use AgentUse from your AI assistant (Claude, ChatGPT, any MCP app)')
    .option('--local', 'Use AgentUse only on this computer, with no account')
    .option('--name <name>', `Project name for a first project (default: ${FIRST_PROJECT_DEFAULT_NAME})`)
    .option('--computer-name <name>', 'How this computer is shown in your account')
    .option('--url <url>', 'AgentUse Cloud address')
    .option('-y, --yes', 'Use the defaults without asking')
    .option('--no-service', 'Do not install the background service')
    .option('--no-browser', 'Print links instead of opening a browser')
    .option('--web', 'Continue setup in the browser dashboard instead')
    .option('--terminal', 'Set up in the terminal (the default)')
    .option('-p, --port <number>', 'Web setup server port (default: 12233)')
    .option('-H, --host <string>', 'Web setup server host (default: 127.0.0.1)')
    .option('--no-auth', 'Disable server API key requirement (dangerous on publicly reachable hosts)')
    .action(async (options: SetupOptions) => {
      if (options.web && options.terminal) {
        console.error(chalk.red('Choose either --web or --terminal, not both'));
        process.exitCode = 1;
        return;
      }
      if (options.web) {
        await createServeCommand().parseAsync(webSetupServeArgs(options), { from: 'user' });
        return;
      }
      await runSetup(options);
    });
}
