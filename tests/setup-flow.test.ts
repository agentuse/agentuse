import { describe, expect, it } from 'bun:test';
import { aiStep, readyText, resolveRoute } from '../src/cli/setup';
import { launchdPlist, serviceProgram, systemdUnit } from '../src/cli/service';
import type { ProviderAuthStatus } from '../src/auth/provider-status';

const strip = (text: string): string => text.replace(/\u001b\[[0-9;]*m/g, '');

describe('setup route', () => {
  it('asks only when nothing decides it', () => {
    expect(resolveRoute({}, false, true)).toBe('prompt');
    expect(resolveRoute({}, false, false)).toBe('local');
    expect(resolveRoute({ yes: true }, false, true)).toBe('local');
  });

  it('goes to Cloud for --cloud or an existing connection', () => {
    expect(resolveRoute({ cloud: true }, false, true)).toBe('cloud');
    expect(resolveRoute({}, true, true)).toBe('cloud');
    expect(resolveRoute({ local: true }, false, true)).toBe('local');
  });

  it('refuses choices that contradict each other', () => {
    expect(() => resolveRoute({ cloud: true, local: true }, false, true)).toThrow('not both');
    expect(() => resolveRoute({ local: true }, true, true)).toThrow('agentuse disconnect');
  });
});

const provider = (id: string, sources: ProviderAuthStatus['sources']): ProviderAuthStatus => ({
  id, name: id === 'anthropic' ? 'Anthropic' : 'OpenAI', configured: sources.length > 0, sources,
});

describe('AI step', () => {
  it('is done when a provider has a saved login or key', () => {
    const step = aiStep({
      providers: [provider('openai', [{ priority: 1, kind: 'oauth', name: 'ChatGPT OAuth', stored: true, active: true }])],
      customProviders: [],
    });
    expect(step).toEqual({ kind: 'ready', label: 'OpenAI (ChatGPT OAuth)' });
  });

  it('offers to save a key that only lives in the shell, since the background service will not see it', () => {
    const step = aiStep({
      providers: [provider('anthropic', [{ priority: 2, kind: 'environment', name: 'ANTHROPIC_API_KEY', stored: false, active: true }])],
      customProviders: [],
    });
    expect(step).toEqual({ kind: 'save-env', provider: 'anthropic', providerName: 'Anthropic', envVar: 'ANTHROPIC_API_KEY' });
  });

  it('asks when there is nothing', () => {
    expect(aiStep({ providers: [provider('anthropic', [])], customProviders: [] })).toEqual({ kind: 'ask' });
  });
});

describe('ready screen', () => {
  it('sends plugin people back to their chat and gives everyone else the address', () => {
    const text = strip(readyText('cloud', 'https://cloud.agentuse.io/mcp', undefined, 'agentuse'));
    expect(text).toContain('Came from the Claude or ChatGPT plugin? Go back and ask again.');
    expect(text).toContain('https://cloud.agentuse.io/mcp');
  });

  it('shows the dashboard and the local MCP address on the local route', () => {
    const text = strip(readyText('local', undefined, 'http://127.0.0.1:14000', 'agentuse'));
    expect(text).toContain('http://127.0.0.1:14000');
    expect(text).toContain('claude mcp add --transport http agentuse http://127.0.0.1:14000/mcp');
    expect(text).toContain('agentuse connect');
  });
});

describe('background service', () => {
  const program = { node: '/opt/node/bin/node', cli: '/usr/lib/node_modules/agentuse/bin/cli.js' };

  it('will not point a service at an npx copy, which npm may delete', () => {
    expect(serviceProgram('/Users/me/.npm/_npx/abc/node_modules/agentuse/bin/cli.js', '/n', 'darwin')).toEqual({ ok: false, reason: 'npx' });
    expect(serviceProgram('/x/cli.js', '/n', 'win32')).toEqual({ ok: false, reason: 'unsupported' });
    expect(serviceProgram('/no/such/cli.js', '/n', 'linux')).toEqual({ ok: true, program: { node: '/n', cli: '/no/such/cli.js' } });
  });

  it('writes a launchd agent that starts serve at login and restarts it', () => {
    const plist = launchdPlist(program, '/usr/bin:/a&b', '/Users/me/.agentuse/logs/serve.log');
    expect(plist).toContain('<string>io.agentuse.serve</string>');
    expect(plist).toContain('<string>/opt/node/bin/node</string>\n    <string>/usr/lib/node_modules/agentuse/bin/cli.js</string>\n    <string>serve</string>');
    expect(plist).toContain('<key>RunAtLoad</key>\n  <true/>');
    expect(plist).toContain('<key>KeepAlive</key>\n  <true/>');
    expect(plist).toContain('/usr/bin:/a&amp;b');
  });

  it('writes a systemd user unit with quoted arguments', () => {
    const unit = systemdUnit({ node: '/opt/my node/node', cli: '/x/cli.js' }, '/usr/bin');
    expect(unit).toContain('ExecStart="/opt/my node/node" "/x/cli.js" "serve"');
    expect(unit).toContain('Environment="PATH=/usr/bin"');
    expect(unit).toContain('WantedBy=default.target');
  });
});
