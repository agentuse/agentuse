import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import { lstat, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  agentCreationProviders,
  createAgentFile,
  deriveAgentName,
  listAgentFileNames,
  validateAgentCreationRequest,
} from '../src/agents/create';
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

  it('lists taken agent filenames from the agent directory, or none when it is missing', async () => {
    const target = await project();
    expect(await listAgentFileNames(target)).toEqual([]);
    await mkdir(join(target.root, 'agents', 'nested'), { recursive: true });
    await writeFile(join(target.root, 'agents', 'zeta.agentuse'), '---\nname: Zeta\n---\nbody\n');
    await writeFile(join(target.root, 'agents', 'alpha.agentuse'), '---\nname: Alpha\n---\nbody\n');
    await writeFile(join(target.root, 'agents', 'notes.md'), 'ignored');
    expect(await listAgentFileNames(target)).toEqual(['alpha.agentuse', 'zeta.agentuse']);

    const scoped = await project(true);
    await writeFile(join(scoped.scopeRoot, 'scoped.agentuse'), '---\nname: Scoped\n---\nbody\n');
    expect(await listAgentFileNames(scoped)).toEqual(['scoped.agentuse']);
  });

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

  it('persists a model-authored friendly name under its separately submitted filename', async () => {
    const target = await project();
    const authored = `---
name: Weekly Support Triage
model: openai:gpt-5.6-terra
description: Triage incoming support tickets every week
---

Review new support tickets and prioritize urgent replies.
`;
    const created = await createAgentFile(target, {
      name: 'Weekly Support Triage',
      fileName: 'support-inbox-review.agentuse',
      objective: 'Triage support tickets.',
      model: 'openai:gpt-5.6-terra',
      source: authored,
    }, ['openai']);

    expect(created.name).toBe('Weekly Support Triage');
    expect(created.path).toBe('agents/support-inbox-review.agentuse');
    expect((await parseAgent(created.absolutePath)).name).toBe('Weekly Support Triage');
  });

  it('enforces an explicit name on model-authored source', async () => {
    const target = await project();
    const authored = `---
name: A Different Name
model: openai:gpt-5.6-terra
description: Triage incoming support tickets
---

Triage support tickets.
`;
    await expect(createAgentFile(target, {
      name: 'Support Triage',
      objective: 'Triage support tickets.',
      model: 'openai:gpt-5.6-terra',
      source: authored,
    }, ['openai'])).rejects.toThrow('must use the requested name Support Triage');
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
    await expect(createAgentFile(target, {
      name: 'Unsafe Filename', fileName: '../escape.agentuse', objective: 'Do something.', model: 'openai:gpt-5.6',
    }, ['openai'])).rejects.toThrow('lowercase kebab-case');
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

  it('offers recommended models, ignores stale defaults, and accepts keyless custom providers', async () => {
    const status: ProviderStatus = {
      credentialStore: '/redacted/path',
      providers: [
        { id: 'anthropic', name: 'Anthropic', configured: false, sources: [] },
        { id: 'openai', name: 'OpenAI', configured: true, sources: [] },
        { id: 'openrouter', name: 'OpenRouter', configured: false, sources: [] },
        { id: 'opencode-go', name: 'OpenCode Go', configured: true, sources: [] },
      ],
      customProviders: [{ id: 'local', baseURL: 'http://localhost:11434/v1', hasApiKey: false }],
    };

    const options = await agentCreationProviders(status, 'openai:o3-mini');
    expect(options.map((provider) => provider.id)).toEqual(['openai', 'opencode-go', 'local']);
    expect(options[0]?.defaultModel).toBe('openai:gpt-5.6-terra');
    expect(options[0]?.models[0]).toBe('openai:gpt-5.6-terra');
    expect(options[0]?.models).not.toContain('openai:o3-mini');
    expect(options[0]?.models).not.toContain('openai:gpt-4.1-nano');
    expect(options[0]?.models).toContain('openai:gpt-5.6-terra');
    expect(options[1]?.defaultModel).toBe('opencode-go:glm-5.3');
    expect(options[1]?.models[0]).toBe('opencode-go:glm-5.3');
    expect(options[1]?.models).not.toContain('opencode-go:glm-5.1');
    expect(options[1]?.models).toContain('opencode-go:kimi-k2.7-code');
    expect(options[2]).toMatchObject({ custom: true, models: [] });
  });

  it('starts first-class providers on a balanced creator model without a configured default', async () => {
    const options = await agentCreationProviders({
      credentialStore: '/redacted/path',
      providers: [
        { id: 'anthropic', name: 'Anthropic', configured: true, sources: [] },
        { id: 'openai', name: 'OpenAI', configured: true, sources: [] },
      ],
      customProviders: [],
    });

    expect(options[0]?.defaultModel).toBe('anthropic:claude-sonnet-5');
    expect(options[1]?.defaultModel).toBe('openai:gpt-5.6-terra');
  });

  it('lists a plugin provider catalog from the plugin runtime', async () => {
    const pluginRuntime = await import('../src/plugin/provider-runtime');
    const spy = spyOn(pluginRuntime, 'getProviderPlugin').mockImplementation(async (id: string) => id === 'pi'
      ? {
          id: 'pi',
          name: 'Pi CLI',
          models: [
            { id: 'openai-codex/gpt-5.6-luna', name: 'GPT-5.6 Luna', input: ['text'], reasoning: true, contextWindow: 1, maxOutputTokens: 1 },
            { id: 'default', name: 'Default', input: ['text'], reasoning: true, contextWindow: 1, maxOutputTokens: 1 },
          ],
          transport: { protocol: 'openai', baseURL: 'http://localhost' },
        } as never
      : undefined);
    try {
      const options = await agentCreationProviders({
        credentialStore: '/redacted/path',
        providers: [{ id: 'pi', name: 'Pi CLI', configured: true, sources: [] }],
        customProviders: [],
      }, 'pi:default');
      expect(options[0]?.models).toEqual(['pi:default', 'pi:openai-codex/gpt-5.6-luna']);
      expect(options[0]?.defaultModel).toBe('pi:default');
    } finally {
      spy.mockRestore();
    }
  });

  it('rejects a stale creator model even when its provider is configured', () => {
    expect(() => validateAgentCreationRequest({
      objective: 'Say bye world.',
      model: 'openai:gpt-4.1-nano',
    }, ['openai'], ['openai:gpt-5.6-terra'])).toThrow('Choose a currently supported model');
  });

  it('starts on the preferred provider but falls back from its stale default', async () => {
    const options = await agentCreationProviders({
      credentialStore: '/redacted/path',
      providers: [
        { id: 'anthropic', name: 'Anthropic', configured: true, sources: [] },
        { id: 'openai', name: 'OpenAI', configured: true, sources: [] },
      ],
      customProviders: [],
    }, 'openai:gpt-4.1');

    expect(options.map((provider) => provider.id)).toEqual(['openai', 'anthropic']);
    expect(options[0]?.defaultModel).toBe('openai:gpt-5.6-terra');
    expect(options[0]?.models).not.toContain('openai:gpt-4.1');
  });
});
