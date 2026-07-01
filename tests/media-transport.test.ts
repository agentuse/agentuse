import { describe, it, expect, afterEach } from 'bun:test';
import { resolveMediaToolResultSupport } from '../src/models.js';

/**
 * resolveMediaToolResultSupport maps a model string to whether its transport can
 * carry image/PDF inside a tool result. These cases avoid the OpenAI-OAuth path
 * (which depends on ambient Codex auth); they use provider prefixes and the
 * envVar form so the result is deterministic.
 */
describe('resolveMediaToolResultSupport', () => {
  const savedBaseUrl = process.env.OPENAI_BASE_URL;

  afterEach(() => {
    if (savedBaseUrl === undefined) delete process.env.OPENAI_BASE_URL;
    else process.env.OPENAI_BASE_URL = savedBaseUrl;
    delete process.env.OPENAI_API_KEY_BASE_URL;
  });

  it('Anthropic supports image and pdf', async () => {
    expect(await resolveMediaToolResultSupport('anthropic:claude-sonnet-5')).toEqual({ image: true, pdf: true });
  });

  it('Bedrock supports image only (PDF/file-data throws)', async () => {
    expect(await resolveMediaToolResultSupport('bedrock:anthropic.claude-3-5-sonnet-20241022-v2:0')).toEqual({ image: true, pdf: false });
  });

  it('OpenRouter supports neither', async () => {
    expect(await resolveMediaToolResultSupport('openrouter:openai/gpt-4o')).toEqual({ image: false, pdf: false });
  });

  it('custom/OpenAI-compatible providers support neither', async () => {
    expect(await resolveMediaToolResultSupport('ollama:qwen3.5:0.8b')).toEqual({ image: false, pdf: false });
  });

  it('OpenAI via a custom base URL (compatible proxy) supports neither', async () => {
    process.env.OPENAI_BASE_URL = 'https://proxy.example.com/v1';
    // envVar form (`:OPENAI_API_KEY`) bypasses the OAuth branch deterministically.
    expect(await resolveMediaToolResultSupport('openai:gpt-4o:OPENAI_API_KEY')).toEqual({ image: false, pdf: false });
  });
});
