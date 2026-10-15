import { Command } from 'commander';
import chalk from 'chalk';
import { cloudConfigPath, cloudUrl, computerName, platformLabel, readCloudConnection, removeCloudConnection, writeCloudConnection } from '../cloud/config.js';
import { revokeThisComputer, startPairing, waitForApproval } from '../cloud/pairing.js';
import { openBrowser } from '../utils/open-browser.js';
import { daemonRequestHeaders, findServerForProject, serverBaseUrl } from '../utils/server-registry.js';

/**
 * `agentuse connect`, `agentuse status`, `agentuse disconnect`: this
 * computer's link to AgentUse Cloud, which lets Claude, ChatGPT, Cursor or any
 * MCP app reach AgentUse here. Deliberately not "login": `agentuse provider
 * login` already means model keys.
 */

function fail(error: unknown): void {
  console.error(chalk.red((error as Error).message));
  process.exitCode = 1;
}

async function liveTunnelState(): Promise<string | undefined> {
  const server = findServerForProject();
  if (!server) return undefined;
  try {
    const response = await fetch(`${serverBaseUrl(server)}/api/cloud`, {
      headers: daemonRequestHeaders(),
      signal: AbortSignal.timeout(3_000),
    });
    if (!response.ok) return undefined;
    const state = await response.json() as { status?: string };
    return state.status;
  } catch {
    return undefined;
  }
}

export function registerCloudCommands(program: Command): void {
  program
    .command('connect')
    .description('Connect this computer to AgentUse Cloud, so Claude, ChatGPT, Cursor or any MCP app can use AgentUse here')
    .option('--name <name>', 'How this computer is shown in your account', undefined)
    .option('--url <url>', 'AgentUse Cloud address', undefined)
    .option('--no-browser', 'Print the link instead of opening a browser')
    .action(async (options: { name?: string; url?: string; browser: boolean }) => {
      try {
        const existing = readCloudConnection();
        if (existing) {
          console.log(`Already connected as ${chalk.bold(existing.name)}${existing.account ? ` (${existing.account})` : ''}.`);
          console.log(chalk.dim('Run `agentuse disconnect` first to connect it again.'));
          return;
        }
        const url = cloudUrl(options.url);
        const name = options.name ?? computerName();
        const start = await startPairing(url, name, platformLabel());
        console.log(`\nConnect ${chalk.bold(name)} to AgentUse Cloud.`);
        console.log(`Open ${chalk.cyan(start.verification_uri)} and enter ${chalk.bold(start.user_code)}\n`);
        if (options.browser && await openBrowser(start.verification_uri_complete)) {
          console.log(chalk.dim('Opened your browser. Sign in there and press Connect.'));
        }
        console.log(chalk.dim('Waiting…'));
        const approved = await waitForApproval(url, start);
        writeCloudConnection({ ...approved, url, connectedAt: new Date().toISOString() });
        console.log(chalk.green(`\nConnected as ${approved.name}${approved.account ? ` (${approved.account})` : ''}.`));
        console.log(`Add this address in Claude, ChatGPT, Cursor, or any app that supports MCP:\n  ${chalk.cyan(approved.mcpUrl)}`);
        console.log(chalk.dim('A running `agentuse serve` picks this up within a minute.'));
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('status')
    .description('Show whether this computer is connected to AgentUse Cloud')
    .action(async () => {
      try {
        const connection = readCloudConnection();
        if (!connection) {
          console.log('Not connected to AgentUse Cloud. Run `agentuse connect`.');
          return;
        }
        const live = await liveTunnelState();
        console.log(`AgentUse Cloud: ${connection.url}`);
        console.log(`Account:        ${connection.account ?? 'unknown'}`);
        console.log(`This computer:  ${connection.name}`);
        console.log(`MCP address:    ${connection.mcpUrl}`);
        console.log(`Live line:      ${live ?? 'agentuse serve is not running'}`);
      } catch (error) {
        fail(error);
      }
    });

  program
    .command('disconnect')
    .description('Disconnect this computer from AgentUse Cloud')
    .action(async () => {
      try {
        const connection = readCloudConnection();
        if (!connection) {
          console.log('This computer is not connected.');
          return;
        }
        await revokeThisComputer(connection);
        removeCloudConnection();
        console.log(`Disconnected ${connection.name}. Removed ${cloudConfigPath()}.`);
      } catch (error) {
        fail(error);
      }
    });
}
