import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'bun:test';
import { createHash, randomBytes } from 'crypto';
import { mkdtemp, rm, stat } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { MCPAuthStorage, resolveMCPAuthFilePath } from '../src/auth/mcp-oauth-storage';
import { connectMCP } from '../src/mcp';
import {
  MCPLoginRequiredError,
  createRunAuthProvider,
  finishMCPLogin,
  getMCPAuthState,
  startMCPLogin,
} from '../src/mcp-oauth';
import { parseAgentContent } from '../src/parser';

const tokens = (access: string, refresh = 'r1') =>
  ({ access_token: access, token_type: 'Bearer', expires_in: 3600, refresh_token: refresh });
const client = { client_id: 'c1' };

let dataDir: string;
const previousDataDir = process.env.AGENTUSE_DATA_DIR;
beforeEach(async () => {
  dataDir = await mkdtemp(join(tmpdir(), 'mcp-oauth-'));
  process.env.AGENTUSE_DATA_DIR = dataDir;
});
afterEach(async () => {
  if (previousDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = previousDataDir;
  await rm(dataDir, { recursive: true, force: true });
});

const agentWith = (auth: string) => `---
model: anthropic:claude-sonnet-4-0
mcpServers:
  remote:
    url: https://mcp.example.com/mcp
    auth:
${auth}
---
Test`;

describe('MCP auth config', () => {
  it('accepts oauth with optional client settings', () => {
    const agent = parseAgentContent(agentWith('      type: oauth\n      clientId: abc\n      scopes: [read, write]'), 'test');
    expect(agent.config.mcpServers?.remote).toMatchObject({ auth: { type: 'oauth', clientId: 'abc', scopes: ['read', 'write'] } });
  });

  it('rejects an unknown auth type', () => {
    expect(() => parseAgentContent(agentWith('      type: basic'), 'test')).toThrow();
  });
});

describe('MCP login storage', () => {
  it('keys logins by normalized URL and writes the file owner-only', async () => {
    await MCPAuthStorage.update('https://MCP.example.com/mcp', (record) => {
      record.login = { clientInformation: client, tokens: tokens('a1'), savedAt: Date.now() };
    });
    expect((await MCPAuthStorage.get('https://mcp.example.com/mcp')).login?.tokens.access_token).toBe('a1');
    expect((await stat(resolveMCPAuthFilePath())).mode & 0o777).toBe(0o600);

    expect(await MCPAuthStorage.logout('https://mcp.example.com/mcp')).toBe(true);
    expect((await MCPAuthStorage.get('https://mcp.example.com/mcp')).login).toBeUndefined();
  });
});

describe('run auth provider', () => {
  const url = 'https://mcp.example.com/mcp';

  it('asks for a login instead of starting one when nothing is stored', async () => {
    const provider = createRunAuthProvider('remote', url, { type: 'oauth' });
    await expect(Promise.resolve().then(() => provider.clientInformation())).rejects.toBeInstanceOf(MCPLoginRequiredError);
    expect(() => provider.redirectToAuthorization(new URL('https://as.example.com/authorize'))).toThrow(MCPLoginRequiredError);
    expect(await getMCPAuthState({ url, auth: { type: 'oauth' } })).toBe('needs-login');
  });

  it('sends stored tokens and keeps refreshed ones', async () => {
    await MCPAuthStorage.update(url, (record) => {
      record.login = { clientInformation: client, tokens: tokens('a1'), savedAt: Date.now() };
    });
    const provider = createRunAuthProvider('remote', url, { type: 'oauth' });
    expect((await provider.tokens())?.access_token).toBe('a1');
    await provider.saveTokens(tokens('a2', 'r2'));
    expect((await MCPAuthStorage.get(url)).login).toMatchObject({ clientInformation: client, tokens: { access_token: 'a2' } });
    expect(await getMCPAuthState({ url, auth: { type: 'oauth' } })).toBe('logged-in');
  });

  it('keeps tokens another run already replaced when a stale refresh is rejected', async () => {
    await MCPAuthStorage.update(url, (record) => {
      record.login = { clientInformation: client, tokens: tokens('a2', 'r2'), savedAt: Date.now() };
    });
    const provider = createRunAuthProvider('remote', url, { type: 'oauth' });
    await provider.invalidateCredentials!('tokens', { tokens: tokens('a1', 'r1') });
    expect((await MCPAuthStorage.get(url)).login?.tokens.access_token).toBe('a2');

    await provider.invalidateCredentials!('tokens', { tokens: tokens('a2', 'r2') });
    expect((await MCPAuthStorage.get(url)).login).toBeUndefined();
  });

  it('fails a run before any network call when the server was never logged in', async () => {
    await expect(connectMCP({ remote: { url: 'http://127.0.0.1:1/mcp', auth: { type: 'oauth' } } }))
      .rejects.toThrow('All MCP servers failed to connect');
  });
});

describe('MCP over HTTP', () => {
  let server: ReturnType<typeof Bun.serve>;
  const seen: { version: string | null; authorization: string | null }[] = [];
  const codes = new Map<string, { challenge: string; redirect: string }>();
  let base = '';

  beforeAll(() => {
    server = Bun.serve({ port: 0, hostname: '127.0.0.1', async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname.startsWith('/.well-known/oauth-protected-resource')) {
        return Response.json({ resource: `${base}/oauth-mcp`, authorization_servers: [base] });
      }
      if (url.pathname === '/.well-known/oauth-authorization-server') {
        return Response.json({
          issuer: base, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`,
          registration_endpoint: `${base}/register`, response_types_supported: ['code'],
          code_challenge_methods_supported: ['S256'],
        });
      }
      if (url.pathname === '/register') {
        return Response.json({ ...(await req.json() as object), client_id: 'registered' }, { status: 201 });
      }
      if (url.pathname === '/token') {
        const form = new URLSearchParams(await req.text());
        const issued = codes.get(form.get('code') ?? '');
        const hashed = createHash('sha256').update(form.get('code_verifier') ?? '').digest('base64url');
        if (!issued || issued.challenge !== hashed || issued.redirect !== form.get('redirect_uri')) {
          return Response.json({ error: 'invalid_grant' }, { status: 400 });
        }
        return Response.json(tokens('from-login'));
      }
      seen.push({ version: req.headers.get('mcp-protocol-version'), authorization: req.headers.get('authorization') });
      if (req.headers.get('authorization') !== 'Bearer s3cret') return new Response('no', { status: 401 });
      const mcp = new McpServer({ name: 'legacy', version: '1' });
      mcp.registerTool('ping', { description: 'ping' }, async () => ({ content: [{ type: 'text', text: 'pong' }] }));
      const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
      await mcp.connect(transport);
      return transport.handleRequest(req);
    } });
    base = `http://127.0.0.1:${server.port}`;
  });
  afterAll(() => server.stop(true));

  it('sends a bearer token from the env and falls back to an older protocol', async () => {
    process.env.MCP_OAUTH_TEST_TOKEN = 's3cret';
    const [connection] = await connectMCP({
      legacy: { url: `${base}/mcp`, auth: { type: 'bearer', token: '${env:MCP_OAUTH_TEST_TOKEN}' } },
    });
    const output = await (connection!.preloadedTools!.ping as any).execute({}, { toolCallId: 't', messages: [] });
    await connection!.client.close();

    expect(output.content).toEqual([{ type: 'text', text: 'pong' }]);
    expect(seen.every((request) => request.authorization === 'Bearer s3cret')).toBe(true);
    expect(seen.map((request) => request.version)).toContain('2025-11-25');
  });

  it('logs in through the browser flow and saves the tokens', async () => {
    const serverUrl = `${base}/oauth-mcp`;
    const redirectUrl = 'http://127.0.0.1:9/callback';
    const started = await startMCPLogin({ serverUrl, settings: { type: 'oauth' }, redirectUrl });
    const authorize = new URL(started.authorizationUrl);
    expect(authorize.searchParams.get('state')).toBe(started.state);

    const code = randomBytes(8).toString('hex');
    codes.set(code, { challenge: authorize.searchParams.get('code_challenge')!, redirect: redirectUrl });
    await expect(finishMCPLogin({ serverUrl, settings: { type: 'oauth' }, state: 'forged', code }))
      .rejects.toThrow('unknown or expired');
    await finishMCPLogin({ serverUrl, settings: { type: 'oauth' }, state: started.state, code, issuer: base });

    const record = await MCPAuthStorage.get(serverUrl);
    expect(record.login).toMatchObject({ clientInformation: { client_id: 'registered' }, tokens: { access_token: 'from-login' } });
    expect(record.pending).toBeUndefined();
  });
});
