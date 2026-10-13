import { Command } from 'commander';
import chalk from 'chalk';
import { createServer } from 'node:http';
import { parseAgent } from '../parser.js';
import { resolveLocalAgentPath } from '../utils/project.js';
import { openBrowser } from '../utils/open-browser.js';
import { MCPAuthStorage } from '../auth/mcp-oauth-storage.js';
import {
  CLI_LOGIN_PORT,
  CLI_LOGIN_REDIRECT_URL,
  finishMCPLogin,
  getMCPAuthState,
  oauthSettings,
  startMCPLogin,
  type MCPOAuthSettings,
} from '../mcp-oauth.js';

const LOGIN_TIMEOUT_MS = 5 * 60 * 1000;

async function loadServers(rawAgent: string) {
  const agentFile = resolveLocalAgentPath(rawAgent);
  if (!agentFile) throw new Error(`Agent file not found: ${rawAgent}`);
  const parsed = await parseAgent(agentFile);
  return parsed.config.mcpServers ?? {};
}

async function loadOAuthServer(rawAgent: string, serverName: string) {
  const config = (await loadServers(rawAgent))[serverName];
  if (!config) throw new Error(`No MCP server named "${serverName}" in ${rawAgent}`);
  const settings = oauthSettings(config);
  if (!settings || !('url' in config)) {
    throw new Error(`MCP server "${serverName}" signs in with a token, not OAuth (remove auth.token and the Authorization header to use OAuth).`);
  }
  return { url: config.url, settings };
}

const page = (message: string) =>
  `<!doctype html><meta charset="utf-8"><title>AgentUse</title>` +
  `<body style="font-family:system-ui;padding:3rem;text-align:center"><p>${message}</p></body>`;

/** Run one browser login against a loopback callback. */
async function browserLogin(url: string, settings: MCPOAuthSettings, openInBrowser: boolean): Promise<void> {
  let settle!: { resolve: () => void; reject: (error: Error) => void };
  const done = new Promise<void>((resolve, reject) => { settle = { resolve, reject }; });
  let state = '';

  const server = createServer(async (req, res) => {
    const callback = new URL(req.url ?? '/', CLI_LOGIN_REDIRECT_URL);
    if (callback.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    const error = callback.searchParams.get('error');
    const code = callback.searchParams.get('code');
    if (callback.searchParams.get('state') !== state) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('This login link does not match. Start the login again.'));
      return;
    }
    try {
      if (error || !code) throw new Error(callback.searchParams.get('error_description') ?? error ?? 'No code returned');
      const issuer = callback.searchParams.get('iss');
      await finishMCPLogin({ serverUrl: url, settings, state, code, ...(issuer && { issuer }) });
      res.writeHead(200, { 'Content-Type': 'text/html' }).end(page('Logged in. You can close this tab.'));
      settle.resolve();
    } catch (failure) {
      res.writeHead(400, { 'Content-Type': 'text/html' }).end(page('Login failed. Check the terminal.'));
      settle.reject(failure as Error);
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once('error', (error: NodeJS.ErrnoException) => reject(
      error.code === 'EADDRINUSE'
        ? new Error(`Port ${CLI_LOGIN_PORT} is busy. Close whatever is using it (maybe another login) and try again.`)
        : error,
    ));
    server.listen(CLI_LOGIN_PORT, '127.0.0.1', resolve);
  });

  const timer = setTimeout(() => settle.reject(new Error('Timed out waiting for the browser login.')), LOGIN_TIMEOUT_MS);
  try {
    const started = await startMCPLogin({ serverUrl: url, settings, redirectUrl: CLI_LOGIN_REDIRECT_URL });
    state = started.state;
    if (!openInBrowser || !await openBrowser(started.authorizationUrl)) {
      process.stdout.write(`Open this URL in your browser:\n\n${started.authorizationUrl}\n\n`);
    }
    process.stdout.write(chalk.dim('Waiting for the browser login...\n'));
    await done;
  } finally {
    clearTimeout(timer);
    server.close();
  }
}

function fail(error: unknown): void {
  console.error(chalk.red((error as Error).message));
  process.exitCode = 1;
}

export function createMcpCommand(): Command {
  const command = new Command('mcp').description('Manage logins for an agent\'s MCP servers');

  command
    .command('login <agent> <server>')
    .description('Log in to an OAuth MCP server. Every agent using the same server URL shares the login.')
    .option('--no-browser', 'Print the login URL instead of opening a browser')
    .action(async (agent: string, serverName: string, options: { browser: boolean }) => {
      try {
        const { url, settings } = await loadOAuthServer(agent, serverName);
        await browserLogin(url, settings, options.browser);
        console.log(chalk.green(`Logged in to ${serverName}.`));
      } catch (error) {
        fail(error);
      }
    });

  command
    .command('logout <agent> <server>')
    .description('Forget the saved login for an OAuth MCP server')
    .action(async (agent: string, serverName: string) => {
      try {
        const { url } = await loadOAuthServer(agent, serverName);
        console.log(await MCPAuthStorage.logout(url) ? `Logged out of ${serverName}.` : `${serverName} was not logged in.`);
      } catch (error) {
        fail(error);
      }
    });

  command
    .command('status <agent>')
    .description('Show how each MCP server of an agent signs in')
    .action(async (agent: string) => {
      try {
        const servers = Object.entries(await loadServers(agent));
        if (servers.length === 0) {
          console.log(chalk.dim('This agent has no MCP servers.'));
          return;
        }
        const labels = {
          none: 'no login',
          token: 'token',
          'needs-token': chalk.yellow('needs a token (auth.token)'),
          'logged-in': chalk.green('logged in'),
          'needs-login': chalk.yellow('needs login'),
        };
        for (const [name, config] of servers) {
          console.log(`${name.padEnd(20)} ${labels[await getMCPAuthState(config)]}`);
        }
      } catch (error) {
        fail(error);
      }
    });

  return command;
}
