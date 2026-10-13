import { randomBytes } from 'crypto';
import {
  auth,
  type OAuthAuthorizationServerInformation,
  type OAuthClientInformation,
  type OAuthClientMetadata,
  type OAuthClientProvider,
} from '@ai-sdk/mcp';
import type { AgentConfig } from './parser';
import { MCPAuthStorage, type PendingMCPLogin } from './auth/mcp-oauth-storage';
import { resolveEnvVariables } from './utils/env';

type MCPServerConfig = NonNullable<AgentConfig['mcpServers']>[string];
export type MCPHttpServerConfig = Extract<MCPServerConfig, { url: string }>;
export type MCPOAuthSettings = Extract<NonNullable<MCPHttpServerConfig['auth']>, { type: 'oauth' }>;

/**
 * Fixed loopback callback for `agentuse mcp login`. A fixed port keeps one
 * dynamic registration per server instead of a new one per login, and works
 * with authorization servers that match loopback redirect URIs exactly.
 */
export const CLI_LOGIN_PORT = 33418;
export const CLI_LOGIN_REDIRECT_URL = `http://127.0.0.1:${CLI_LOGIN_PORT}/callback`;

/** Never sent anywhere: a run cannot finish a browser login, it only reports it. */
const RUN_REDIRECT_URL = 'http://127.0.0.1/callback';

export class MCPLoginRequiredError extends Error {
  override name = 'MCPLoginRequiredError';
  constructor(readonly serverName: string) {
    super(
      `MCP server "${serverName}" needs you to log in. Open this agent in AgentUse and choose Log in ` +
      `next to "${serverName}", or run: agentuse mcp login <agent-file> ${serverName}`,
    );
  }
}

export function oauthSettings(config: MCPServerConfig): MCPOAuthSettings | undefined {
  return 'url' in config && config.auth?.type === 'oauth' ? config.auth : undefined;
}

function configuredClient(settings: MCPOAuthSettings): OAuthClientInformation | undefined {
  if (!settings.clientId) return undefined;
  return {
    client_id: settings.clientId,
    ...(settings.clientSecret && { client_secret: resolveEnvVariables(settings.clientSecret) }),
  };
}

function clientMetadata(settings: MCPOAuthSettings, redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: 'AgentUse',
    redirect_uris: [redirectUrl],
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    token_endpoint_auth_method: settings.clientSecret ? 'client_secret_post' : 'none',
    ...(settings.scopes?.length && { scope: settings.scopes.join(' ') }),
  };
}

/**
 * The provider an agent run uses. It sends the stored tokens and saves the
 * refreshed ones. It never starts a browser login: when one is needed it
 * throws MCPLoginRequiredError, and it leaves pending logins untouched so a
 * run cannot break a login the user is finishing in the browser.
 */
export function createRunAuthProvider(
  serverName: string,
  serverUrl: string,
  settings: MCPOAuthSettings,
): OAuthClientProvider {
  const loginRequired = (): never => {
    throw new MCPLoginRequiredError(serverName);
  };
  return {
    get redirectUrl() { return RUN_REDIRECT_URL; },
    get clientMetadata() { return clientMetadata(settings, RUN_REDIRECT_URL); },
    // Read from disk each time: another run may have rotated the tokens.
    async tokens() {
      return (await MCPAuthStorage.get(serverUrl)).login?.tokens;
    },
    async saveTokens(tokens) {
      await MCPAuthStorage.update(serverUrl, (record) => {
        if (record.login) record.login = { ...record.login, tokens, savedAt: Date.now() };
      });
    },
    async clientInformation() {
      return configuredClient(settings)
        ?? (await MCPAuthStorage.get(serverUrl)).login?.clientInformation
        ?? loginRequired();
    },
    saveAuthorizationServerInformation() { /* only a browser login pins this */ },
    saveCodeVerifier() { /* only a browser login stores a verifier */ },
    codeVerifier: loginRequired,
    redirectToAuthorization: loginRequired,
    async invalidateCredentials(scope, context) {
      if (scope !== 'tokens' && scope !== 'all') return;
      await MCPAuthStorage.update(serverUrl, (record) => {
        const stored = record.login?.tokens;
        // A refresh that lost a race to another run sees stale tokens here;
        // only drop the login if nobody has replaced them since.
        if (stored && (!context || (
          stored.access_token === context.tokens.access_token &&
          stored.refresh_token === context.tokens.refresh_token
        ))) {
          delete record.login;
        }
      });
    },
  };
}

function createLoginProvider(
  serverUrl: string,
  settings: MCPOAuthSettings,
  redirectUrl: string,
  state: string,
  pending?: PendingMCPLogin,
) {
  let authorizationServer: OAuthAuthorizationServerInformation | undefined = pending?.authorizationServer;
  let authorizationUrl: URL | undefined;
  const clientInformation = async () =>
    configuredClient(settings) ?? (await MCPAuthStorage.get(serverUrl)).clients?.[redirectUrl];

  const provider: OAuthClientProvider = {
    get redirectUrl() { return redirectUrl; },
    get clientMetadata() { return clientMetadata(settings, redirectUrl); },
    // A login always asks the user again, even if old tokens exist.
    tokens: () => undefined,
    async saveTokens(tokens) {
      const client = await clientInformation();
      if (!client) throw new Error('OAuth client registration is missing. Start the login again.');
      await MCPAuthStorage.update(serverUrl, (record) => {
        record.login = { clientInformation: client, tokens, savedAt: Date.now() };
        delete record.pending?.[state];
      });
    },
    clientInformation,
    async saveClientInformation(info) {
      await MCPAuthStorage.update(serverUrl, (record) => {
        record.clients = { ...record.clients, [redirectUrl]: info };
      });
    },
    authorizationServerInformation: () => authorizationServer,
    saveAuthorizationServerInformation(info) { authorizationServer = info; },
    state: () => state,
    storedState: () => state,
    async saveCodeVerifier(codeVerifier) {
      await MCPAuthStorage.update(serverUrl, (record) => {
        record.pending = {
          ...record.pending,
          [state]: {
            redirectUrl,
            codeVerifier,
            createdAt: Date.now(),
            ...(authorizationServer && { authorizationServer }),
          },
        };
      });
    },
    codeVerifier() {
      if (!pending) throw new Error('No login is in progress for this server.');
      return pending.codeVerifier;
    },
    redirectToAuthorization(url) { authorizationUrl = url; },
  };
  return { provider, authorizationUrl: () => authorizationUrl };
}

/** Begin a browser login. Returns the URL to open and the state to finish it with. */
export async function startMCPLogin(options: {
  serverUrl: string;
  settings: MCPOAuthSettings;
  redirectUrl: string;
}): Promise<{ authorizationUrl: string; state: string }> {
  const state = randomBytes(24).toString('base64url');
  const login = createLoginProvider(options.serverUrl, options.settings, options.redirectUrl, state);
  await auth(login.provider, { serverUrl: options.serverUrl });
  const url = login.authorizationUrl();
  if (!url) throw new Error('The MCP server did not ask for a browser login.');
  return { authorizationUrl: url.href, state };
}

/** Finish a browser login with the code the authorization server sent back. */
export async function finishMCPLogin(options: {
  serverUrl: string;
  settings: MCPOAuthSettings;
  state: string;
  code: string;
  issuer?: string;
}): Promise<void> {
  const pending = (await MCPAuthStorage.get(options.serverUrl)).pending?.[options.state];
  if (!pending) throw new Error('This login is unknown or expired. Start the login again.');
  const login = createLoginProvider(
    options.serverUrl, options.settings, pending.redirectUrl, options.state, pending,
  );
  const result = await auth(login.provider, {
    serverUrl: options.serverUrl,
    authorizationCode: options.code,
    callbackState: options.state,
    ...(options.issuer && { callbackIssuer: options.issuer }),
  });
  if (result !== 'AUTHORIZED') throw new Error('The MCP server did not accept the login.');
}

export type MCPAuthState = 'none' | 'token' | 'logged-in' | 'needs-login';

export async function getMCPAuthState(config: MCPServerConfig): Promise<MCPAuthState> {
  if (!('url' in config)) return 'none';
  if (config.auth?.type === 'oauth') {
    const login = (await MCPAuthStorage.get(config.url)).login;
    if (!login) return 'needs-login';
    const { expires_in, refresh_token } = login.tokens;
    const expired = expires_in !== undefined && login.savedAt + expires_in * 1000 < Date.now();
    return expired && !refresh_token ? 'needs-login' : 'logged-in';
  }
  const hasAuthHeader = Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === 'authorization');
  return config.auth?.token || hasAuthHeader ? 'token' : 'none';
}
