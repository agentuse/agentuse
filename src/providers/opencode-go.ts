import { randomUUID } from 'node:crypto';
import { version } from '../../package.json';

export const OPENCODE_GO_PROVIDER_ID = 'opencode-go';
export const OPENCODE_GO_DISPLAY_NAME = 'OpenCode Go';
export const OPENCODE_GO_API_KEY_ENV = 'OPENCODE_GO_API_KEY';
export const OPENCODE_GO_BASE_URL_ENV = 'OPENCODE_GO_BASE_URL';
export const OPENCODE_GO_BASE_URL = 'https://opencode.ai/zen/go/v1';

export function isOpenCodeGoBaseURL(baseURL: string): boolean {
  try {
    const url = new URL(baseURL);
    return url.hostname === 'opencode.ai' && /^\/zen\/go(?:\/|$)/.test(url.pathname);
  } catch {
    return false;
  }
}

export function createOpenCodeGoHeaders(sessionId?: string): Record<string, string> {
  return {
    // Allocate once per model for standalone helper calls; retries reuse it.
    'x-opencode-session': sessionId || randomUUID(),
    'user-agent': `agentuse/${version}`,
  };
}

export type OpenCodeGoProtocol = 'anthropic' | 'openai-compatible' | 'openai-responses';

export function getOpenCodeGoProtocol(modelName: string): OpenCodeGoProtocol {
  // OpenCode Go exposes these through the native OpenAI Responses API, not
  // its OpenAI-compatible Chat Completions endpoint.
  if (modelName.startsWith('grok-') || /^gpt-\d/.test(modelName)) {
    return 'openai-responses';
  }

  if (modelName.startsWith('minimax-') || /^qwen\d/.test(modelName)) {
    return 'anthropic';
  }

  return 'openai-compatible';
}

function readEnv(name: string | undefined): string | undefined {
  if (!name) return undefined;
  const value = process.env[name];
  return value && value.trim() !== '' ? value : undefined;
}

export function resolveOpenCodeGoBaseURL(config: { envVar?: string; envSuffix?: string }): string {
  if (config.envVar) {
    const envVarBase = readEnv(`${config.envVar}_BASE_URL`);
    if (envVarBase) return envVarBase;
  }

  if (config.envSuffix) {
    const suffixBase = readEnv(`${OPENCODE_GO_BASE_URL_ENV}_${config.envSuffix}`);
    if (suffixBase) return suffixBase;
  }

  return readEnv(OPENCODE_GO_BASE_URL_ENV) || OPENCODE_GO_BASE_URL;
}
