import type { CustomProviderAuth } from './types.js';

const DISCOVERY_TIMEOUT_MS = 3_000;
const COMPLETION_CHECK_TIMEOUT_MS = 30_000;
const DISCOVERY_LIMIT = 200;
export const CUSTOM_PROVIDER_APIS = ['openai-completions', 'openai-responses', 'anthropic-messages'] as const;
export type CustomProviderApi = typeof CUSTOM_PROVIDER_APIS[number];
export type CustomProviderApiSelection = CustomProviderApi | 'auto';

export function normalizeCustomProviderBaseURL(id: string, value: string): string {
  const url = new URL(value);
  const isLMStudio = id.toLowerCase().replace(/[-_]/g, '') === 'lmstudio';
  if (isLMStudio && (url.pathname === '/' || url.pathname === '/api/v1' || url.pathname === '/api/v1/')) {
    url.pathname = '/v1';
  }
  return url.toString().replace(/\/$/, '');
}

export function normalizeCustomProviderModelIds(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return [...new Set(value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter((item) => Boolean(item) && !/\s/.test(item)))]
    .slice(0, DISCOVERY_LIMIT);
}

/** Discover text-generation models from an OpenAI-compatible endpoint. */
export async function discoverCustomProviderModelIds(
  id: string,
  provider: Pick<CustomProviderAuth, 'baseURL' | 'key' | 'api'>,
  timeoutMs = DISCOVERY_TIMEOUT_MS,
): Promise<string[]> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const isLMStudio = id.toLowerCase().replace(/[-_]/g, '') === 'lmstudio';
    // Always verify the same OpenAI-compatible base URL used for execution.
    // LM Studio's native /api/v1/models endpoint can work even when this base
    // is wrong, so it must never be the connection check by itself.
    const response = await fetch(`${provider.baseURL.replace(/\/+$/, '')}/models`, {
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        ...(provider.key && { authorization: `Bearer ${provider.key}` }),
        ...(provider.key && { 'x-api-key': provider.key }),
        'anthropic-version': '2023-06-01',
      },
    });
    if (!response.ok) throw new Error(`Model discovery returned HTTP ${response.status}`);
    const compatiblePayload = await response.json() as {
      data?: Array<{ id?: unknown; type?: unknown }>;
    };
    let candidates = Array.isArray(compatiblePayload.data) ? compatiblePayload.data : [];
    if (isLMStudio) {
      try {
        const nativeResponse = await fetch(new URL('/api/v1/models', provider.baseURL), {
          signal: controller.signal,
          headers: {
            accept: 'application/json',
            ...(provider.key && { authorization: `Bearer ${provider.key}` }),
          },
        });
        if (nativeResponse.ok) {
          const nativePayload = await nativeResponse.json() as { models?: Array<{ key?: unknown; type?: unknown }> };
          if (Array.isArray(nativePayload.models)) {
            const compatibleIds = new Set(candidates.map((model) => model.id));
            candidates = nativePayload.models
              .filter((model) => compatibleIds.has(model.key))
              .map((model) => ({ id: model.key, type: model.type }));
          }
        }
      } catch {
        // The compatible list is authoritative; native metadata only improves filtering.
      }
    }
    return normalizeCustomProviderModelIds(candidates
      .filter((model) => model?.type === undefined || model.type === 'llm')
      .map((model) => model?.id));
  } finally {
    clearTimeout(timer);
  }
}

/** Verify the endpoint can execute the selected API protocol AgentUse will use at runtime. */
export async function checkCustomProviderCompletion(
  provider: Pick<CustomProviderAuth, 'baseURL' | 'key' | 'api'>,
  model: string,
  timeoutMs = COMPLETION_CHECK_TIMEOUT_MS,
): Promise<void> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const api = provider.api ?? 'openai-completions';
    const path = api === 'openai-completions' ? 'chat/completions' : api === 'openai-responses' ? 'responses' : 'messages';
    const endpoint = `${provider.baseURL.replace(/\/+$/, '')}/${path}`;
    const body = api === 'openai-completions'
      ? { model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, max_tokens: 8 }
      : api === 'openai-responses'
        ? { model, input: 'Reply with OK.', stream: false, max_output_tokens: 8 }
        : { model, messages: [{ role: 'user', content: 'Reply with OK.' }], stream: false, max_tokens: 8 };
    const response = await fetch(endpoint, {
      method: 'POST',
      signal: controller.signal,
      headers: {
        accept: 'application/json',
        'content-type': 'application/json',
        ...(provider.key && { authorization: `Bearer ${provider.key}` }),
        ...(api === 'anthropic-messages' && { 'x-api-key': provider.key ?? '', 'anthropic-version': '2023-06-01' }),
      },
      body: JSON.stringify(body),
    });
    const payload = await response.json().catch(() => null) as { choices?: unknown[]; output?: unknown[]; content?: unknown[]; error?: { message?: unknown } } | null;
    if (!response.ok) {
      const detail = typeof payload?.error?.message === 'string' ? `: ${payload.error.message}` : '';
      throw new Error(`${api} check returned HTTP ${response.status}${detail}`);
    }
    const valid = api === 'openai-completions' ? Array.isArray(payload?.choices)
      : api === 'openai-responses' ? Array.isArray(payload?.output)
        : Array.isArray(payload?.content);
    if (!valid) {
      throw new Error(`${api} check returned an incompatible response`);
    }
  } finally {
    clearTimeout(timer);
  }
}

/** Detect the API by requiring a valid minimal generation response, not by guessing from the URL. */
export async function detectCustomProviderApi(
  provider: Pick<CustomProviderAuth, 'baseURL' | 'key'>,
  model: string,
): Promise<CustomProviderApi> {
  const failures: string[] = [];
  for (const api of CUSTOM_PROVIDER_APIS) {
    try {
      await checkCustomProviderCompletion({ ...provider, api }, model);
      return api;
    } catch (error) {
      failures.push(`${api}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  throw new Error(`Could not detect a supported API format. ${failures.join('; ')}`);
}
