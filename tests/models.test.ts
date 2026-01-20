import { describe, it, expect } from 'bun:test';
import { createModel } from '../src/models';
import { AnthropicAuth } from '../src/auth/anthropic';
import { CodexAuth } from '../src/auth/codex';

async function withEnv(env: Record<string, string | undefined>, callback: () => Promise<void>) {
  const snapshot = new Map<string, string | undefined>();
  for (const [key, value] of Object.entries(env)) {
    if (!snapshot.has(key)) {
      snapshot.set(key, process.env[key]);
    }
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  try {
    await callback();
  } finally {
    for (const [key, value] of snapshot.entries()) {
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
  }
}

describe('createModel base URL configuration', () => {
  describe('OpenAI', () => {
    it('uses default base URL when not configured', async () => {
      const originalAccess = CodexAuth.access;
      CodexAuth.access = async () => undefined;

      try {
        await withEnv({ OPENAI_API_KEY: 'test-key' }, async () => {
          const model = await createModel('openai:gpt-4o-mini');
          expect(model.config.url({ path: '' })).toBe('https://api.openai.com/v1');
        });
      } finally {
        CodexAuth.access = originalAccess;
      }
    });

    it('respects OPENAI_BASE_URL', async () => {
      const originalAccess = CodexAuth.access;
      CodexAuth.access = async () => undefined;

      try {
        await withEnv({
          OPENAI_API_KEY: 'test-key',
          OPENAI_BASE_URL: 'https://openai.example.com',
        }, async () => {
          const model = await createModel('openai:gpt-4o');
          expect(model.config.url({ path: '' })).toBe('https://openai.example.com');
        });
      } finally {
        CodexAuth.access = originalAccess;
      }
    });

    it('supports suffix-based base URL', async () => {
      await withEnv({
        OPENAI_API_KEY_DEV: 'dev-key',
        OPENAI_BASE_URL_DEV: 'https://dev.openai.local',
      }, async () => {
        const model = await createModel('openai:gpt-4o:dev');
        expect(model.config.url({ path: '' })).toBe('https://dev.openai.local');
      });
    });

    it('supports explicit env var base URL', async () => {
      await withEnv({
        OPENAI_API_KEY_PERSONAL: 'personal-key',
        OPENAI_API_KEY_PERSONAL_BASE_URL: 'https://personal.openai.local',
      }, async () => {
        const model = await createModel('openai:gpt-4o:OPENAI_API_KEY_PERSONAL');
        expect(model.config.url({ path: '' })).toBe('https://personal.openai.local');
      });
    });
  });

  describe('Anthropic', () => {
    it('uses default base URL when not configured', async () => {
      await withEnv({ ANTHROPIC_API_KEY: 'anthropic-key' }, async () => {
        const model = await createModel('anthropic:claude-3-opus');
        expect(model.config.baseURL).toBe('https://api.anthropic.com/v1');
      });
    });

    it('respects ANTHROPIC_BASE_URL', async () => {
      await withEnv({
        ANTHROPIC_API_KEY: 'anthropic-key',
        ANTHROPIC_BASE_URL: 'https://anthropic.example.com',
      }, async () => {
        const model = await createModel('anthropic:claude-3-5-sonnet');
        expect(model.config.baseURL).toBe('https://anthropic.example.com');
      });
    });

    it('supports suffix-based base URL', async () => {
      await withEnv({
        ANTHROPIC_API_KEY_DEV: 'dev-anthropic',
        ANTHROPIC_BASE_URL_DEV: 'https://dev.anthropic.local',
      }, async () => {
        const model = await createModel('anthropic:claude-3-haiku:dev');
        expect(model.config.baseURL).toBe('https://dev.anthropic.local');
      });
    });

    it('supports explicit env var base URL', async () => {
      await withEnv({
        ANTHROPIC_API_KEY_CUSTOM: 'custom-anthropic',
        ANTHROPIC_API_KEY_CUSTOM_BASE_URL: 'https://custom.anthropic.local',
      }, async () => {
        const model = await createModel('anthropic:claude-3-haiku:ANTHROPIC_API_KEY_CUSTOM');
        expect(model.config.baseURL).toBe('https://custom.anthropic.local');
      });
    });

    it('applies base URL for OAuth authentication', async () => {
      const originalAccess = AnthropicAuth.access;
      AnthropicAuth.access = async () => 'oauth-token';

      try {
        await withEnv({ ANTHROPIC_BASE_URL: 'https://oauth.anthropic.local' }, async () => {
          const model = await createModel('anthropic:claude-3-opus');
          expect(model.config.baseURL).toBe('https://oauth.anthropic.local');
        });
      } finally {
        AnthropicAuth.access = originalAccess;
      }
    });
  });
});
