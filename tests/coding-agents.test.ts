import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { GET_WORKFLOW } from '../src/mcp-server/workflow-text';
import { codingAgentStatuses, codingAgentTarget, setUpCodingAgent, skillText } from '../src/onboarding/coding-agents';


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

  it('writes tiny automate and triage skills that point at get_workflow, and says Update when one is missing', async () => {
    writeFileSync(path.join(home, '.claude.json'), '{}');
    mkdirSync(path.join(home, '.codex'));
    await setUpCodingAgent('claude-code', target, home);
    await setUpCodingAgent('codex', target, home);
    const claudeSkill = path.join(home, '.claude', 'skills', 'automate', 'SKILL.md');
    const codexSkill = path.join(home, '.agents', 'skills', 'automate', 'SKILL.md');
    expect(readFileSync(claudeSkill, 'utf8')).toContain('name: automate');
    expect(readFileSync(codexSkill, 'utf8')).toContain('`get_workflow`');
    expect(readFileSync(codexSkill, 'utf8').length).toBeLessThan(1_000);
    expect(readFileSync(path.join(home, '.claude', 'skills', 'triage', 'SKILL.md'), 'utf8')).toContain('`workflow` set to `triage`');
    expect(readFileSync(path.join(home, '.agents', 'skills', 'triage', 'SKILL.md'), 'utf8')).toContain('name: triage');
    expect((await codingAgentStatuses(target, home)).map((s) => s.triageCommand)).toEqual(['/triage', '$triage']);
    expect((await codingAgentStatuses(target, home)).map((s) => [s.command, s.state])).toEqual([['/automate', 'set-up'], ['$automate', 'set-up']]);

    rmSync(codexSkill);
    expect(existsSync(codexSkill)).toBe(false);
    expect((await codingAgentStatuses(target, home))[1].state).toBe('outdated');
  });

  it("never replaces a person's own automate skill", async () => {
    const skill = path.join(home, '.claude', 'skills', 'automate', 'SKILL.md');
    mkdirSync(path.dirname(skill), { recursive: true });
    writeFileSync(skill, 'mine');
    await setUpCodingAgent('claude-code', target, home);
    expect(readFileSync(skill, 'utf8')).toBe('mine');
  });

  it('shows what works instead when the name is taken, and still counts as set up', async () => {
    for (const dir of [path.join(home, '.claude', 'skills', 'triage'), path.join(home, '.agents', 'skills', 'automate')]) {
      mkdirSync(dir, { recursive: true });
      writeFileSync(path.join(dir, 'SKILL.md'), 'mine');
    }
    mkdirSync(path.join(home, '.codex'));
    expect((await setUpCodingAgent('claude-code', target, home))).toMatchObject({ state: 'set-up', command: '/automate', triageCommand: '/mcp__agentuse__triage' });
    expect((await setUpCodingAgent('codex', target, home))).toMatchObject({ state: 'set-up', command: 'Use AgentUse to automate this', triageCommand: '$triage' });
  });

  it('offers Update for an old copy of the skill, and replaces it', async () => {
    const skill = path.join(home, '.claude', 'skills', 'automate', 'SKILL.md');
    writeFileSync(path.join(home, '.claude.json'), '{}');
    await setUpCodingAgent('claude-code', target, home);
    writeFileSync(skill, '---\nname: automate\n---\n<!-- agentuse:automate -->\n\nThe whole workflow, copied.\n');
    expect((await codingAgentStatuses(target, home))[0]).toMatchObject({ state: 'outdated', outdatedBecause: 'skills', command: '/automate' });
    await setUpCodingAgent('claude-code', target, home);
    expect(readFileSync(skill, 'utf8')).toBe(skillText('automate'));
    expect((await codingAgentStatuses(target, home))[0].state).toBe('set-up');
  });

  it('says the address is why when it changed', async () => {
    writeFileSync(path.join(home, '.claude.json'), '{}');
    await setUpCodingAgent('claude-code', target, home);
    expect((await codingAgentStatuses({ url: 'http://127.0.0.1:5000/mcp' }, home))[0].outdatedBecause).toBe('address');
  });

  it('points only at workflows get_workflow serves', () => {
    for (const workflow of GET_WORKFLOW.workflows) expect(skillText(workflow)).toContain(`\`workflow\` set to \`${workflow}\``);
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
