import { afterEach, describe, expect, it } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { agentCreationProviders, createAgentFile, deriveAgentName } from '../src/agents/create';
import { parseAgent } from '../src/parser';
import type { ProviderStatus } from '../src/auth/provider-status';

describe('persistent dashboard agent creation', () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  async function project(scope = false) {
    const root = await mkdtemp(join(tmpdir(), 'agentuse-create-agent-'));
    roots.push(root);
    const scopeRoot = scope ? join(root, 'served-agents') : root;
    if (scope) await mkdir(scopeRoot);
    return { id: 'test-project', root, scopeRoot };
  }

  it('creates a minimal parser-valid agent in the project agents directory', async () => {
    const target = await project();
    const created = await createAgentFile(target, {
      objective: 'Summarize new support tickets every morning and highlight urgent replies.',
      model: 'openai:gpt-5.6-terra',
    }, ['openai']);

    expect(created.path).toBe('agents/summarize-new-support-tickets-every-morning.agentuse');
    expect(created.runPath).toBe('agents/summarize-new-support-tickets-every-morning.agentuse');
    expect((await lstat(created.absolutePath)).mode & 0o777).toBe(0o600);
    const source = await readFile(created.absolutePath, 'utf8');
    expect(source).toContain('name: Summarize New Support Tickets Every Morning');
    expect(source).toContain('model: openai:gpt-5.6-terra');
    expect(source).toContain('Summarize new support tickets every morning');
    const parsed = await parseAgent(created.absolutePath);
    expect(parsed.name).toBe('Summarize New Support Tickets Every Morning');
    expect(parsed.config.model).toBe('openai:gpt-5.6-terra');
  });

  it('derives concise stable names from the first useful task clause', () => {
    expect(deriveAgentName('Review yesterday’s work and identify the most important follow-up.'))
      .toBe('Review Yesterday Work');
    expect(deriveAgentName('监控每日销售变化')).toMatch(/^Agent [a-f0-9]{8}$/);
  });

  it('persists validated model-authored source instead of replacing it with a template', async () => {
    const target = await project();
    const authored = `---
name: Ticket Triage
model: openai:gpt-5.6-terra
description: Triage incoming support tickets
reasoning: low
---

## Task

Review the tickets supplied in the run prompt and prioritize urgent replies.
`;
    const created = await createAgentFile(target, {
      objective: 'Triage support tickets.',
      model: 'openai:gpt-5.6-terra',
      source: authored,
    }, ['openai']);

    expect(created.name).toBe('Ticket Triage');
    expect(created.path).toBe('agents/ticket-triage.agentuse');
    expect(await readFile(created.absolutePath, 'utf8')).toBe(`${authored.trim()}\n`);
  });

  it('writes directly into an explicitly served scope', async () => {
    const target = await project(true);
    const created = await createAgentFile(target, {
      name: 'Scoped Agent',
      objective: 'Review changes in the served directory.',
      model: 'anthropic:claude-sonnet-5',
    }, ['anthropic']);

    expect(created.path).toBe('served-agents/scoped-agent.agentuse');
    expect(created.runPath).toBe('scoped-agent.agentuse');
  });

  it('never overwrites an existing agent with the same slug', async () => {
    const target = await project();
    const input = { name: 'Daily Brief', objective: 'Write a daily brief.', model: 'openai:gpt-5.6' };
    const first = await createAgentFile(target, input, ['openai']);
    await expect(createAgentFile(target, { ...input, objective: 'Replace the first agent.' }, ['openai']))
      .rejects.toMatchObject({ code: 'AGENT_EXISTS' });
    expect(await readFile(first.absolutePath, 'utf8')).toContain('Write a daily brief.');
    expect(await readFile(first.absolutePath, 'utf8')).not.toContain('Replace the first agent.');
  });

  it('rejects invalid input and models whose provider is not configured', async () => {
    const target = await project();
    await expect(createAgentFile(target, {
      name: '../escape', objective: 'Do something.', model: 'openai:gpt-5.6',
    }, ['openai'])).rejects.toMatchObject({ code: 'INVALID_AGENT' });
    await expect(createAgentFile(target, {
      name: 'Wrong Provider', objective: 'Do something.', model: 'anthropic:claude-sonnet-5',
    }, ['openai'])).rejects.toMatchObject({ code: 'MODEL_NOT_CONFIGURED' });
    await expect(createAgentFile(target, {
      name: 'Missing Model', objective: 'Do something.', model: 'local:',
    }, ['local'])).rejects.toMatchObject({ code: 'INVALID_AGENT' });
  });

  it('refuses a symlinked agents directory', async () => {
    const target = await project();
    const outside = await mkdtemp(join(tmpdir(), 'agentuse-create-agent-outside-'));
    roots.push(outside);
    await symlink(outside, join(target.root, 'agents'));
    await expect(createAgentFile(target, {
      name: 'Stay Inside', objective: 'Do something.', model: 'openai:gpt-5.6',
    }, ['openai'])).rejects.toMatchObject({ code: 'CREATE_FAILED' });
  });

  it('offers curated models only for configured providers', () => {
    const status: ProviderStatus = {
      credentialStore: '/redacted/path',
      providers: [
        { id: 'anthropic', name: 'Anthropic', configured: false, sources: [] },
        { id: 'openai', name: 'OpenAI', configured: true, sources: [] },
        { id: 'openrouter', name: 'OpenRouter', configured: false, sources: [] },
        { id: 'opencode-go', name: 'OpenCode Go', configured: true, sources: [] },
      ],
      customProviders: [{ id: 'local', baseURL: 'http://localhost:11434/v1', hasApiKey: true }],
    };

    const options = agentCreationProviders(status);
    expect(options.map((provider) => provider.id)).toEqual(['openai', 'opencode-go', 'local']);
    expect(options[0]?.models).toContain('openai:gpt-5.6-terra');
    expect(options[1]?.models).toContain('opencode-go:kimi-k2.7-code');
    expect(options[2]).toMatchObject({ custom: true, models: [] });
  });
});
