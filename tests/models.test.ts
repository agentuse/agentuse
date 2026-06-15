import { describe, it, expect } from 'bun:test';
import { createModel, AuthenticationError } from '../src/models';
import { AnthropicAuth } from '../src/auth/anthropic';
import { CodexAuth } from '../src/auth/codex';
import { AuthStorage } from '../src/auth/storage';
import fs from 'fs/promises';
import path from 'path';
import os from 'os';

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
      await withEnv({
        ANTHROPIC_API_KEY: 'anthropic-key',
        ANTHROPIC_BASE_URL: undefined,
      }, async () => {
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

describe('createModel Amazon Bedrock', () => {
  const bedrockEnvKeys = {
    AWS_REGION: undefined as string | undefined,
    AWS_DEFAULT_REGION: undefined as string | undefined,
    AWS_ACCESS_KEY_ID: undefined as string | undefined,
    AWS_SECRET_ACCESS_KEY: undefined as string | undefined,
    AWS_SESSION_TOKEN: undefined as string | undefined,
    AWS_BEARER_TOKEN_BEDROCK: undefined as string | undefined,
    AWS_PROFILE: undefined as string | undefined,
  };

  it('creates a Bedrock model with AWS access keys', async () => {
    await withEnv({
      ...bedrockEnvKeys,
      AWS_REGION: 'us-east-1',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret',
    }, async () => {
      const model = await createModel('bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0');
      expect(model).toBeDefined();
      expect(model.modelId).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
      expect(model.provider).toContain('bedrock');
    });
  });

  it('creates a Bedrock model with AWS_BEARER_TOKEN_BEDROCK', async () => {
    await withEnv({
      ...bedrockEnvKeys,
      AWS_REGION: 'us-east-1',
      AWS_BEARER_TOKEN_BEDROCK: 'bearer-token',
    }, async () => {
      const model = await createModel('bedrock:meta.llama3-70b-instruct-v1:0');
      expect(model).toBeDefined();
      expect(model.modelId).toBe('meta.llama3-70b-instruct-v1:0');
    });
  });

  it('falls back to AWS_DEFAULT_REGION when AWS_REGION is unset', async () => {
    await withEnv({
      ...bedrockEnvKeys,
      AWS_DEFAULT_REGION: 'eu-west-1',
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret',
    }, async () => {
      const model = await createModel('bedrock:anthropic.claude-3-haiku-20240307-v1:0');
      expect(model).toBeDefined();
    });
  });

  it('uses the AWS SDK credential chain when no static credentials are set', async () => {
    // No AWS_ACCESS_KEY_ID/AWS_SECRET_ACCESS_KEY/AWS_BEARER_TOKEN_BEDROCK,
    // only AWS_PROFILE + region — should resolve via fromNodeProviderChain().
    await withEnv({
      ...bedrockEnvKeys,
      AWS_REGION: 'eu-west-1',
      AWS_PROFILE: 'some-profile',
    }, async () => {
      const model = await createModel('bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0');
      expect(model).toBeDefined();
      expect(model.modelId).toBe('anthropic.claude-3-5-sonnet-20241022-v2:0');
    });
  });

  it('throws AuthenticationError when region is missing', async () => {
    await withEnv({
      ...bedrockEnvKeys,
      AWS_ACCESS_KEY_ID: 'AKIAEXAMPLE',
      AWS_SECRET_ACCESS_KEY: 'secret',
    }, async () => {
      await expect(
        createModel('bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0')
      ).rejects.toBeInstanceOf(AuthenticationError);
    });
  });
});

describe('createModel OpenCode Go', () => {
  const opencodeGoEnvKeys = {
    OPENCODE_GO_API_KEY: undefined as string | undefined,
    OPENCODE_GO_API_KEY_DEV: undefined as string | undefined,
    OPENCODE_GO_API_KEY_TEAM: undefined as string | undefined,
    OPENCODE_GO_BASE_URL: undefined as string | undefined,
    OPENCODE_GO_BASE_URL_DEV: undefined as string | undefined,
    OPENCODE_GO_API_KEY_TEAM_BASE_URL: undefined as string | undefined,
  };

  async function withTempAuthStorage(callback: () => Promise<void>) {
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-opencode-go-auth-test-'));
    const originalAuthFile = (AuthStorage as any).AUTH_FILE;
    (AuthStorage as any).AUTH_FILE = path.join(tempDir, 'auth.json');

    try {
      await callback();
    } finally {
      (AuthStorage as any).AUTH_FILE = originalAuthFile;
      await fs.rm(tempDir, { recursive: true, force: true });
    }
  }

  it('throws AuthenticationError when no API key is configured', async () => {
    await withTempAuthStorage(async () => {
      await withEnv(opencodeGoEnvKeys, async () => {
        await expect(createModel('opencode-go:kimi-k2.7-code')).rejects.toMatchObject({
          provider: 'opencode-go',
          envVar: 'OPENCODE_GO_API_KEY',
        });
      });
    });
  });

  it('creates an OpenAI-compatible model with OPENCODE_GO_API_KEY', async () => {
    await withTempAuthStorage(async () => {
      await withEnv({
        ...opencodeGoEnvKeys,
        OPENCODE_GO_API_KEY: 'go-key',
      }, async () => {
        const model = await createModel('opencode-go:kimi-k2.7-code');
        expect(model).toBeDefined();
        expect(model.modelId).toBe('kimi-k2.7-code');
        expect(String(model.provider)).toContain('opencode-go');
      });
    });
  });

  it('uses stored OpenCode Go API key fallback', async () => {
    await withTempAuthStorage(async () => {
      await AuthStorage.setApiKey('opencode-go', { type: 'api', key: 'stored-go-key' });
      await withEnv(opencodeGoEnvKeys, async () => {
        const model = await createModel('opencode-go:glm-5.1');
        expect(model).toBeDefined();
        expect(model.modelId).toBe('glm-5.1');
      });
    });
  });

  it('supports suffix-based API key and base URL', async () => {
    await withTempAuthStorage(async () => {
      await withEnv({
        ...opencodeGoEnvKeys,
        OPENCODE_GO_API_KEY_DEV: 'dev-go-key',
        OPENCODE_GO_BASE_URL_DEV: 'https://dev.opencode.local/v1',
      }, async () => {
        const model = await createModel('opencode-go:kimi-k2.7-code:dev');
        expect(model).toBeDefined();
        expect(model.modelId).toBe('kimi-k2.7-code');
      });
    });
  });

  it('supports explicit API key environment variable', async () => {
    await withTempAuthStorage(async () => {
      await withEnv({
        ...opencodeGoEnvKeys,
        OPENCODE_GO_API_KEY_TEAM: 'team-go-key',
        OPENCODE_GO_API_KEY_TEAM_BASE_URL: 'https://team.opencode.local/v1',
      }, async () => {
        const model = await createModel('opencode-go:deepseek-v4-flash:OPENCODE_GO_API_KEY_TEAM');
        expect(model).toBeDefined();
        expect(model.modelId).toBe('deepseek-v4-flash');
      });
    });
  });

  it('routes MiniMax models through the Anthropic-compatible endpoint', async () => {
    await withTempAuthStorage(async () => {
      await withEnv({
        ...opencodeGoEnvKeys,
        OPENCODE_GO_API_KEY: 'go-key',
      }, async () => {
        const model = await createModel('opencode-go:minimax-m3');
        expect(model).toBeDefined();
        expect(model.modelId).toBe('minimax-m3');
        expect(model.config.baseURL).toBe('https://opencode.ai/zen/go/v1');
      });
    });
  });

  it('routes Qwen models through the Anthropic-compatible endpoint', async () => {
    await withTempAuthStorage(async () => {
      await withEnv({
        ...opencodeGoEnvKeys,
        OPENCODE_GO_API_KEY: 'go-key',
      }, async () => {
        const model = await createModel('opencode-go:qwen3.7-plus');
        expect(model).toBeDefined();
        expect(model.modelId).toBe('qwen3.7-plus');
        expect(model.config.baseURL).toBe('https://opencode.ai/zen/go/v1');
      });
    });
  });
});
