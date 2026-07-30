import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  MODEL_DEFAULT_ENV,
  ModelAliasError,
  deriveModelAlias,
  getConfiguredModelDefault,
  getVersionAliasesForProvider,
  resolveAgentModel,
  resolveModelString,
  resetModelAliasCache,
  resumeModelPin,
} from '../src/utils/model-alias';
import { resetModelSettingsCache } from '../src/utils/global-config';
import { parseAgentContent } from '../src/parser';
import { prepareAgentExecution } from '../src/runner';
import { SessionManager } from '../src/session';
import { initStorage } from '../src/storage';
import {
  currentModelsFromRegistry,
  isLiveVersionAlias,
  rewriteAgentFileModels,
  toVersionAlias,
} from '../src/utils/model-bump';

const originalConfig = process.env.AGENTUSE_CONFIG;
const originalDefault = process.env[MODEL_DEFAULT_ENV];

/** Each config gets its own file, so the mtime-keyed settings cache can't leak. */
let configSeq = 0;
function useConfig(models: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentuse-alias-'));
  const file = path.join(dir, `config-${configSeq++}.json`);
  fs.writeFileSync(file, JSON.stringify({ models }, null, 2));
  process.env.AGENTUSE_CONFIG = file;
  resetModelSettingsCache();
  return file;
}

beforeEach(() => {
  delete process.env.AGENTUSE_CONFIG;
  delete process.env[MODEL_DEFAULT_ENV];
  resetModelSettingsCache();
  resetModelAliasCache();
});

afterEach(() => {
  if (originalConfig === undefined) delete process.env.AGENTUSE_CONFIG;
  else process.env.AGENTUSE_CONFIG = originalConfig;
  if (originalDefault === undefined) delete process.env[MODEL_DEFAULT_ENV];
  else process.env[MODEL_DEFAULT_ENV] = originalDefault;
  resetModelSettingsCache();
  resetModelAliasCache();
});

describe('deriveModelAlias', () => {
  it('drops a hyphenated version run', () => {
    expect(deriveModelAlias('claude-sonnet-5')).toBe('claude-sonnet');
    expect(deriveModelAlias('claude-haiku-4-5')).toBe('claude-haiku');
  });

  it('drops a dotted version', () => {
    expect(deriveModelAlias('gpt-5.6')).toBe('gpt');
    expect(deriveModelAlias('gpt-5.4-mini')).toBe('gpt-mini');
    expect(deriveModelAlias('gpt-5.1-codex-max')).toBe('gpt-codex-max');
  });

  it('keeps the vendor path on OpenRouter ids', () => {
    expect(deriveModelAlias('z-ai/glm-5.2')).toBe('z-ai/glm');
    expect(deriveModelAlias('google/gemini-3.6-flash')).toBe('google/gemini-flash');
  });

  it('drops version markers glued to a letter', () => {
    expect(deriveModelAlias('z-ai/glm-5v-turbo')).toBe('z-ai/glm-turbo');
    expect(deriveModelAlias('deepseek/deepseek-v4-pro')).toBe('deepseek/deepseek-pro');
    expect(deriveModelAlias('minimax/minimax-m3')).toBe('minimax/minimax');
    expect(deriveModelAlias('moonshotai/kimi-k3')).toBe('moonshotai/kimi');
  });

  it('drops a version glued to the end of a word', () => {
    expect(deriveModelAlias('qwen/qwen3.7-max')).toBe('qwen/qwen-max');
  });

  it('strips a release-date suffix along with the version', () => {
    expect(deriveModelAlias('claude-haiku-4-5-20251001')).toBe('claude-haiku');
    expect(deriveModelAlias('gpt-4o-2024-11-20')).toBe('gpt');
  });

  it('returns undefined when there is no version to drop', () => {
    expect(deriveModelAlias('claude-sonnet')).toBeUndefined();
    expect(deriveModelAlias('some-model')).toBeUndefined();
  });
});

describe('version aliases', () => {
  it('resolves a version-less id to the newest model in that line', () => {
    const resolved = resolveModelString('anthropic:claude-sonnet');
    expect(resolved.source).toBe('version-alias');
    expect(resolved.alias).toBe('anthropic:claude-sonnet');
    expect(resolved.model.startsWith('anthropic:claude-sonnet-')).toBe(true);
  });

  it('leaves a concrete model id untouched', () => {
    const aliases = getVersionAliasesForProvider('anthropic');
    const concrete = `anthropic:${aliases['claude-sonnet']}`;
    expect(resolveModelString(concrete)).toEqual({ model: concrete, source: 'literal' });
  });

  it('is idempotent: resolving twice changes nothing', () => {
    const once = resolveModelString('openai:gpt').model;
    expect(resolveModelString(once).model).toBe(once);
  });

  it('passes an unknown model through unchanged', () => {
    // Stale pins must still reach the provider (with the registry's warning),
    // never be silently retargeted.
    expect(resolveModelString('anthropic:claude-sonnet-4-0')).toEqual({
      model: 'anthropic:claude-sonnet-4-0',
      source: 'literal',
    });
  });

  it('never shadows a real model that shares the alias name', () => {
    // openrouter:qwen/qwen-plus is a real rolling id, so it must resolve to
    // itself rather than to qwen/qwen<version>-plus.
    expect(resolveModelString('openrouter:qwen/qwen-plus').model).toBe('openrouter:qwen/qwen-plus');
    expect('qwen/qwen-plus' in getVersionAliasesForProvider('openrouter')).toBe(false);
  });

  it('preserves the :env auth suffix', () => {
    const resolved = resolveModelString('anthropic:claude-sonnet:dev');
    expect(resolved.model.endsWith(':dev')).toBe(true);
    expect(resolved.model.startsWith('anthropic:claude-sonnet-')).toBe(true);
  });

  it('treats a bare alias as an OpenAI id, like a bare model id', () => {
    expect(resolveModelString('gpt').model.startsWith('openai:gpt-')).toBe(true);
  });

  it('leaves custom-provider models alone', () => {
    expect(resolveModelString('ollama:qwen3.5:0.8b').model).toBe('ollama:qwen3.5:0.8b');
  });

  it('leaves bedrock ids alone, colons and all', () => {
    const id = 'bedrock:us.anthropic.claude-sonnet-4-5-20250929-v1:0';
    expect(resolveModelString(id).model).toBe(id);
  });
});

describe('user aliases', () => {
  it('resolves @name from the config', () => {
    useConfig({ aliases: { fast: 'anthropic:claude-haiku' } });
    const resolved = resolveModelString('@fast');
    expect(resolved.source).toBe('user-alias');
    expect(resolved.alias).toBe('@fast');
    expect(resolved.model.startsWith('anthropic:claude-haiku-')).toBe(true);
  });

  it('resolves an alias that points at another alias', () => {
    useConfig({ aliases: { smart: 'anthropic:claude-opus', best: '@smart' } });
    expect(resolveModelString('@best').model.startsWith('anthropic:claude-opus-')).toBe(true);
  });

  it('accepts a concrete id as the target', () => {
    useConfig({ aliases: { pinned: 'anthropic:claude-sonnet-4-0' } });
    expect(resolveModelString('@pinned').model).toBe('anthropic:claude-sonnet-4-0');
  });

  it('matches the name case-insensitively', () => {
    useConfig({ aliases: { Fast: 'openai:gpt-mini' } });
    expect(resolveModelString('@fast').model.startsWith('openai:gpt-')).toBe(true);
  });

  it('reports an unknown alias with the names that do exist', () => {
    useConfig({ aliases: { fast: 'openai:gpt-mini' } });
    expect(() => resolveModelString('@nope')).toThrow(ModelAliasError);
    expect(() => resolveModelString('@nope')).toThrow('@fast');
  });

  it('rejects an alias cycle instead of recursing forever', () => {
    useConfig({ aliases: { a: '@b', b: '@a' } });
    expect(() => resolveModelString('@a')).toThrow('points at itself');
  });

  it('rejects a bare sigil', () => {
    useConfig({ aliases: { fast: 'openai:gpt-mini' } });
    expect(() => resolveModelString('@')).toThrow('missing a name');
  });

  it('reports unknown aliases when no config exists at all', () => {
    expect(() => resolveModelString('@fast')).toThrow('(none defined)');
  });
});

describe('configured default model', () => {
  it('reads models.default from the config', () => {
    useConfig({ default: 'anthropic:claude-haiku' });
    expect(getConfiguredModelDefault()).toBe('anthropic:claude-haiku');
  });

  it('lets AGENTUSE_MODEL win over the config', () => {
    useConfig({ default: 'anthropic:claude-haiku' });
    process.env[MODEL_DEFAULT_ENV] = 'openai:gpt';
    expect(getConfiguredModelDefault()).toBe('openai:gpt');
  });

  it('is undefined when nothing is configured', () => {
    expect(getConfiguredModelDefault()).toBeUndefined();
    expect(resolveAgentModel(undefined)).toBeUndefined();
  });

  it('resolves the default through the alias table', () => {
    useConfig({ default: 'anthropic:claude-haiku' });
    const resolved = resolveAgentModel(undefined);
    expect(resolved?.source).toBe('default');
    expect(resolved?.model.startsWith('anthropic:claude-haiku-')).toBe(true);
  });
});

describe('parseAgentContent model resolution', () => {
  const body = 'Do the thing.';

  it('records the alias alongside the resolved model', () => {
    const parsed = parseAgentContent(`---\nmodel: anthropic:claude-sonnet\n---\n${body}`, 'test');
    expect(parsed.config.model.startsWith('anthropic:claude-sonnet-')).toBe(true);
    expect(parsed.config.modelAlias).toBe('anthropic:claude-sonnet');
    expect(parsed.config.modelSource).toBe('version-alias');
  });

  it('leaves a concrete model as written, with no alias metadata', () => {
    const parsed = parseAgentContent(`---\nmodel: anthropic:claude-sonnet-4-0\n---\n${body}`, 'test');
    expect(parsed.config.model).toBe('anthropic:claude-sonnet-4-0');
    expect(parsed.config.modelAlias).toBeUndefined();
    expect(parsed.config.modelSource).toBeUndefined();
  });

  it('falls back to the configured default when model is omitted', () => {
    useConfig({ default: 'anthropic:claude-haiku' });
    const parsed = parseAgentContent(`---\nname: defaulted\n---\n${body}`, 'test');
    expect(parsed.config.model.startsWith('anthropic:claude-haiku-')).toBe(true);
    expect(parsed.config.modelSource).toBe('default');
  });

  it('fails with actionable guidance when no model and no default', () => {
    expect(() => parseAgentContent(`---\nname: nomodel\n---\n${body}`, 'test')).toThrow(
      'Invalid agent configuration'
    );
    expect(() => parseAgentContent(`---\nname: nomodel\n---\n${body}`, 'test')).toThrow(
      MODEL_DEFAULT_ENV
    );
  });

  it('reports an unknown @alias as a config error', () => {
    expect(() => parseAgentContent(`---\nmodel: "@nope"\n---\n${body}`, 'test')).toThrow(
      'Unknown model alias @nope'
    );
  });
});

describe('resumeModelPin', () => {
  it('pins a resumed run to the model the session started with', () => {
    expect(
      resumeModelPin(
        { model: 'anthropic:claude-sonnet-5', modelSource: 'version-alias' },
        'anthropic:claude-sonnet-4-6'
      )
    ).toBe('anthropic:claude-sonnet-4-6');
  });

  it('pins a run whose model came from the configured default', () => {
    expect(
      resumeModelPin({ model: 'openai:gpt-5.6', modelSource: 'default' }, 'openai:gpt-5.4')
    ).toBe('openai:gpt-5.4');
  });

  it('leaves a hand-written concrete model alone', () => {
    // Editing the pin between suspend and resume is deliberate.
    expect(
      resumeModelPin({ model: 'anthropic:claude-opus-4-8' }, 'anthropic:claude-sonnet-5')
    ).toBeUndefined();
  });

  it('does nothing when the alias still resolves to the same model', () => {
    expect(
      resumeModelPin(
        { model: 'anthropic:claude-sonnet-5', modelSource: 'version-alias' },
        'anthropic:claude-sonnet-5'
      )
    ).toBeUndefined();
  });

  it('does nothing when the session recorded no model', () => {
    expect(
      resumeModelPin({ model: 'anthropic:claude-sonnet-5', modelSource: 'user-alias' }, undefined)
    ).toBeUndefined();
  });
});

describe('rewriting model references in agent files', () => {
  const currentModels = currentModelsFromRegistry();
  const providers = Object.keys(currentModels);

  it('rewrites frontmatter only, leaving instructions untouched', () => {
    const file = [
      '---',
      'model: anthropic:claude-sonnet-4-0',
      '---',
      'Compare anthropic:claude-sonnet-4-0 with its predecessor.',
      '',
    ].join('\n');
    const { content, changes } = rewriteAgentFileModels(file, providers, toVersionAlias);
    expect(changes).toHaveLength(1);
    expect(content).toContain('model: anthropic:claude-sonnet\n');
    expect(content).toContain('Compare anthropic:claude-sonnet-4-0 with its predecessor.');
  });

  it('converts a pin to its alias and is then a no-op', () => {
    const file = '---\nmodel: anthropic:claude-haiku-4-5\n---\nHi.\n';
    const once = rewriteAgentFileModels(file, providers, toVersionAlias);
    expect(once.content).toContain('model: anthropic:claude-haiku\n');
    const twice = rewriteAgentFileModels(once.content, providers, toVersionAlias);
    expect(twice.changes).toHaveLength(0);
  });

  it('leaves a file with no frontmatter alone', () => {
    const file = 'Just prose mentioning anthropic:claude-sonnet-4-0.\n';
    expect(rewriteAgentFileModels(file, providers, toVersionAlias).changes).toHaveLength(0);
  });

  it('recognizes a live version alias, so bump never re-pins it', () => {
    expect(isLiveVersionAlias('anthropic', 'claude-sonnet')).toBe(true);
    expect(isLiveVersionAlias('anthropic', 'claude-sonnet-4-0')).toBe(false);
  });

  it('does not alias a model line the registry no longer carries', () => {
    expect(toVersionAlias('anthropic', 'claude-instant-1-2')).toBeNull();
  });
});

describe('resume pins the model at the prepare step', () => {
  // The decision itself is covered above; this exercises the wiring, i.e. that
  // prepareAgentExecution really does consult the session record on resume.
  it('rewrites agent.config.model from the session record', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentuse-resume-pin-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();
      const agentId = 'agents/pinned';
      const startedOn = 'anthropic:claude-sonnet-4-6';
      const sessionID = await sessionManager.createSession({
        agent: { id: agentId, name: 'pinned', isSubAgent: false },
        model: startedOn,
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });
      await sessionManager.createMessage(sessionID, agentId, {
        user: { prompt: { task: 'do work' } },
        assistant: {
          system: ['system'],
          modelID: startedOn,
          providerID: 'anthropic',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });

      // A resume rebinds the tool set recorded at first run, so the snapshot
      // has to exist for preparation to get past the resume branch.
      await sessionManager.writeToolsSnapshot(sessionID, agentId, { tools: [] });

      // The agent names its model by alias, which resolves to a different
      // release than the one this session started on.
      const agent = parseAgentContent('---\nmodel: anthropic:claude-sonnet\n---\nWork.', 'pinned');
      expect(agent.config.model).not.toBe(startedOn);

      await prepareAgentExecution({
        agent,
        mcpClients: [],
        sessionManager,
        existingSessionId: sessionID,
        projectContext: { projectRoot, stateRoot: projectRoot, cwd: projectRoot },
      });

      expect(agent.config.model).toBe(startedOn);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});
