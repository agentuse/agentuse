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

function hasAuthorizationHeader(config: MCPHttpServerConfig): boolean {
  return Object.keys(config.headers ?? {}).some((key) => key.toLowerCase() === 'authorization');
}

/**
 * The OAuth settings for an HTTP server, or undefined when it signs in another
 * way. OAuth is the default: a server with no token and no Authorization
 * header may still need no login at all, and says so by never answering 401.
 * `auth.type: oauth` is only needed for a pre-registered client or scopes.
 */
/** A server that answers 401 but does not offer OAuth: it wants a token. */
export class MCPTokenRequiredError extends Error {
  override name = 'MCPTokenRequiredError';
  constructor(readonly serverName: string) {
    super(
      `MCP server "${serverName}" refused the connection (401) and does not offer an OAuth login. ` +
      'If it needs an API key, set auth.token or an Authorization header for it.',
    );
  }
}

/**
 * Whether a server publishes OAuth protected resource metadata (RFC 9728),
 * which is how an MCP server says "log in with OAuth". Checked at the
 * path-specific location first, then the root, as the MCP spec describes.
 */
async function advertisesOAuth(serverUrl: string, wwwAuthenticate?: string | null): Promise<boolean> {
  if (wwwAuthenticate && /resource_metadata\s*=/.test(wwwAuthenticate)) return true;
  const url = new URL(serverUrl);
  const path = url.pathname === '/' ? '' : url.pathname.replace(/\/$/, '');
  const candidates = [...new Set([
    `${url.origin}/.well-known/oauth-protected-resource${path}`,
    `${url.origin}/.well-known/oauth-protected-resource`,
  ])];
  for (const candidate of candidates) {
    try {
      const response = await fetch(candidate, { signal: AbortSignal.timeout(5_000) });
      if (!response.ok) {
        await response.body?.cancel();
        continue;
      }
      const metadata = await response.json() as { authorization_servers?: unknown };
      if (Array.isArray(metadata.authorization_servers) && metadata.authorization_servers.length > 0) return true;
    } catch {
      // Unreachable or not JSON: try the next location.
    }
  }
  return false;
}

/** OAuth the config did not ask for: the server may want no login, or a token. */
const IMPLICIT_OAUTH: MCPOAuthSettings = Object.freeze({ type: 'oauth' });

export function oauthSettings(config: MCPServerConfig): MCPOAuthSettings | undefined {
  if (!('url' in config)) return undefined;
  if (config.auth?.type === 'oauth') return config.auth;
  if (config.auth?.token || hasAuthorizationHeader(config)) return undefined;
  return IMPLICIT_OAUTH;
}

/**
 * What an unauthenticated request gets: `oauth` for a 401 from a server that
 * offers an OAuth login, `token` for a 401 from one that does not, `open` for
 * anything else (no login needed, or unreachable, which a run reports itself).
 */
async function probeServer(config: MCPHttpServerConfig): Promise<'oauth' | 'token' | 'open'> {
  try {
    const response = await fetch(config.url, {
      method: 'POST',
      headers: {
        ...config.headers,
        'Content-Type': 'application/json',
        Accept: 'application/json, text/event-stream',
      },
      body: JSON.stringify({ jsonrpc: '2.0', id: 0, method: 'ping' }),
      signal: AbortSignal.timeout(5_000),
    });
    await response.body?.cancel();
    if (response.status !== 401) return 'open';
    return await advertisesOAuth(config.url, response.headers.get('www-authenticate')) ? 'oauth' : 'token';
  } catch {
    return 'open';
  }
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
  // Reached only after a 401. A server that never declared OAuth may just
  // want an API key, so say that instead of sending the user to log in.
  const loginRequired = async (): Promise<never> => {
    if (settings === IMPLICIT_OAUTH && !await advertisesOAuth(serverUrl)) {
      throw new MCPTokenRequiredError(serverName);
    }
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

export type MCPAuthState = 'none' | 'token' | 'needs-token' | 'logged-in' | 'needs-login';

export async function getMCPAuthState(config: MCPServerConfig): Promise<MCPAuthState> {
  if (!('url' in config)) return 'none';
  if (!oauthSettings(config)) return 'token';
  const login = (await MCPAuthStorage.get(config.url)).login;
  if (login) {
    const { expires_in, refresh_token } = login.tokens;
    const expired = expires_in !== undefined && login.savedAt + expires_in * 1000 < Date.now();
    if (!expired || refresh_token) return 'logged-in';
  }
  // Declared OAuth always needs a login; otherwise ask the server.
  if (config.auth?.type === 'oauth') return 'needs-login';
  const probe = await probeServer(config);
  return probe === 'oauth' ? 'needs-login' : probe === 'token' ? 'needs-token' : 'none';
}
