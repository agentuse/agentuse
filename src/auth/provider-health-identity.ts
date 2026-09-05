import { providerHealthSubject } from './provider-health';

const DEFAULT_BASE_URLS: Record<string, string> = {
  anthropic: 'https://api.anthropic.com/v1',
  openai: 'https://api.openai.com/v1',
  openrouter: 'https://openrouter.ai/api/v1',
  'opencode-go': 'https://opencode.ai/zen/go/v1',
};

export function apiHealthSubject(provider: string, key: string, baseURL?: string) {
  return providerHealthSubject(provider, 'api', {
    key,
    baseURL: (baseURL ?? DEFAULT_BASE_URLS[provider] ?? '').replace(/\/+$/, ''),
  });
}

export function oauthHealthSubject(provider: string, credential: unknown) {
  return providerHealthSubject(provider, 'oauth', credential);
}
