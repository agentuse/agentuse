import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { codingAgentStatuses, codingAgentTarget, setUpCodingAgent } from '../src/onboarding/coding-agents';


const target = { url: 'http://127.0.0.1:12233/mcp' };

describe('coding agents', () => {
  let home: string;
  beforeEach(() => { home = mkdtempSync(path.join(tmpdir(), 'agentuse-coding-agents-')); });
  afterEach(() => { rmSync(home, { recursive: true, force: true }); });

  it('reports apps that are not installed', async () => {
    const statuses = await codingAgentStatuses(target, home, []);
    expect(statuses.map((s) => [s.id, s.state])).toEqual([['claude-code', 'not-installed'], ['codex', 'not-installed']]);
    await expect(setUpCodingAgent('codex', target, home, [])).rejects.toThrow('not installed');
  });

  it('counts Claude Code as installed when only the Claude app is there', async () => {
    const apps = path.join(home, 'Applications');
    mkdirSync(path.join(apps, 'Claude.app'), { recursive: true });
    expect((await codingAgentStatuses(target, home, [apps])).map((s) => s.state)).toEqual(['not-set-up', 'not-installed']);
    expect((await setUpCodingAgent('claude-code', target, home, [apps])).state).toBe('set-up');
    expect(JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8')).mcpServers.agentuse.url).toBe(target.url);
  });

  it('adds AgentUse to Claude Code and keeps the rest of ~/.claude.json', async () => {
    const file = path.join(home, '.claude.json');
    writeFileSync(file, JSON.stringify({ numStartups: 3, mcpServers: { other: { type: 'stdio', command: 'x' } } }), { mode: 0o600 });
    expect((await codingAgentStatuses(target, home))[0]).toMatchObject({ configPath: '~/.claude.json', state: 'not-set-up' });

    const status = await setUpCodingAgent('claude-code', target, home);
    expect(status.state).toBe('set-up');
    const config = JSON.parse(readFileSync(file, 'utf8'));
    expect(config.numStartups).toBe(3);
    expect(config.mcpServers.other).toEqual({ type: 'stdio', command: 'x' });
    expect(config.mcpServers.agentuse).toEqual({ type: 'http', url: target.url });
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // The server moved: the entry is outdated until set up again.
    expect((await codingAgentStatuses({ url: 'http://127.0.0.1:5000/mcp' }, home))[0].state).toBe('outdated');
  });

  it('sends the operator key to Claude Code when the server has one', async () => {
    mkdirSync(path.join(home, '.claude'));
    await setUpCodingAgent('claude-code', { ...target, apiKey: 'k' }, home);
    const config = JSON.parse(readFileSync(path.join(home, '.claude.json'), 'utf8'));
    expect(config.mcpServers.agentuse.headers).toEqual({ Authorization: 'Bearer k' });
    expect((await codingAgentStatuses(target, home))[0].state).toBe('outdated');
  });

  it('refuses to overwrite a ~/.claude.json it cannot read', async () => {
    writeFileSync(path.join(home, '.claude.json'), '{ not json');
    await expect(setUpCodingAgent('claude-code', target, home)).rejects.toThrow();
    expect(readFileSync(path.join(home, '.claude.json'), 'utf8')).toBe('{ not json');
  });

  it('writes through a symlinked config', async () => {
    const real = path.join(home, 'dotfiles.json');
    writeFileSync(real, '{}');
    symlinkSync(real, path.join(home, '.claude.json'));
    await setUpCodingAgent('claude-code', target, home);
    expect(JSON.parse(readFileSync(real, 'utf8')).mcpServers.agentuse.url).toBe(target.url);
  });

  it('replaces only the agentuse table in Codex config.toml', async () => {
    mkdirSync(path.join(home, '.codex'));
    const file = path.join(home, '.codex', 'config.toml');
    writeFileSync(file, [
      'model = "gpt-5"',
      '',
      '[mcp_servers.agentuse]',
      'url = "http://127.0.0.1:9999/mcp"',
      '',
      '[mcp_servers.agentuse.env]',
      'X = "1"',
      '',
      '[mcp_servers.other]',
      'url = "https://example.com/mcp"',
      '',
    ].join('\n'));
    expect((await codingAgentStatuses(target, home))[1]).toMatchObject({ configPath: '~/.codex/config.toml', state: 'outdated' });

    await setUpCodingAgent('codex', { ...target, apiKey: 'k' }, home);
    const text = readFileSync(file, 'utf8');
    expect(text).toContain('model = "gpt-5"');
    expect(text).toContain('[mcp_servers.other]\nurl = "https://example.com/mcp"');
    expect(text).not.toContain('9999');
    expect(text).not.toContain('[mcp_servers.agentuse.env]');
    expect(text.endsWith('[mcp_servers.agentuse]\nurl = "http://127.0.0.1:12233/mcp"\nhttp_headers = { Authorization = "Bearer k" }\n')).toBe(true);
    expect((await codingAgentStatuses({ ...target, apiKey: 'k' }, home))[1].state).toBe('set-up');
  });

  it('creates Codex config.toml when only ~/.codex exists', async () => {
    mkdirSync(path.join(home, '.codex'));
    await setUpCodingAgent('codex', target, home);
    expect(readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8')).toBe('[mcp_servers.agentuse]\nurl = "http://127.0.0.1:12233/mcp"\n');
  });

  it('writes no skills, and names a command only where the app has one', async () => {
    writeFileSync(path.join(home, '.claude.json'), '{}');
    mkdirSync(path.join(home, '.codex'));
    await setUpCodingAgent('claude-code', target, home);
    await setUpCodingAgent('codex', target, home);
    expect(existsSync(path.join(home, '.claude', 'skills'))).toBe(false);
    expect(existsSync(path.join(home, '.agents', 'skills'))).toBe(false);
    const statuses = await codingAgentStatuses(target, home);
    expect(statuses.map((s) => [s.command, s.state])).toEqual([['/agentuse', 'set-up'], [undefined, 'set-up']]);
  });

  it("never touches a person's own automate or triage skill", async () => {
    const skills = ['automate', 'triage'].map((name) => path.join(home, '.claude', 'skills', name, 'SKILL.md'));
    for (const skill of skills) {
      mkdirSync(path.dirname(skill), { recursive: true });
      writeFileSync(skill, 'mine');
    }
    expect((await setUpCodingAgent('claude-code', target, home)).state).toBe('set-up');
    for (const skill of skills) expect(readFileSync(skill, 'utf8')).toBe('mine');
  });

  it('offers Update for a skill an earlier version wrote, and removes it', async () => {
    writeFileSync(path.join(home, '.claude.json'), '{}');
    await setUpCodingAgent('claude-code', target, home);
    const folder = path.join(home, '.claude', 'skills', 'automate');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'SKILL.md'), '---\nname: automate\n---\n<!-- agentuse:automate -->\n\nThe whole workflow, copied.\n');
    expect((await codingAgentStatuses(target, home))[0]).toMatchObject({ state: 'outdated', outdatedBecause: 'skills' });
    expect((await setUpCodingAgent('claude-code', target, home)).state).toBe('set-up');
    expect(existsSync(folder)).toBe(false);
  });

  it('keeps anything else the person added next to an old skill', async () => {
    writeFileSync(path.join(home, '.claude.json'), '{}');
    const folder = path.join(home, '.claude', 'skills', 'automate');
    mkdirSync(folder, { recursive: true });
    writeFileSync(path.join(folder, 'SKILL.md'), '<!-- agentuse:automate -->\n');
    writeFileSync(path.join(folder, 'notes.md'), 'mine');
    await setUpCodingAgent('claude-code', target, home);
    expect(existsSync(path.join(folder, 'SKILL.md'))).toBe(false);
    expect(readFileSync(path.join(folder, 'notes.md'), 'utf8')).toBe('mine');
  });

  it('says the address is why when it changed', async () => {
    writeFileSync(path.join(home, '.claude.json'), '{}');
    await setUpCodingAgent('claude-code', target, home);
    expect((await codingAgentStatuses({ url: 'http://127.0.0.1:5000/mcp' }, home))[0].outdatedBecause).toBe('address');
  });

  it('points coding agents at AgentUse Cloud once this computer is connected, with no key', async () => {
    const local = { url: target.url, apiKey: 'k' };
    expect(codingAgentTarget(local)).toEqual(local);
    const cloud = codingAgentTarget(local, { mcpUrl: 'https://cloud.agentuse.io/mcp' });
    expect(cloud).toEqual({ url: 'https://cloud.agentuse.io/mcp' });

    // Set up locally, then connected: the entry is outdated until set up again.
    mkdirSync(path.join(home, '.codex'));
    await setUpCodingAgent('codex', local, home, []);
    expect((await codingAgentStatuses(cloud, home, []))[1].state).toBe('outdated');
    await setUpCodingAgent('codex', cloud, home, []);
    const toml = readFileSync(path.join(home, '.codex', 'config.toml'), 'utf8');
    expect(toml).toContain('url = "https://cloud.agentuse.io/mcp"');
    expect(toml).not.toContain('Authorization');
  });
});
