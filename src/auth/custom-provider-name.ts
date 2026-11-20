import { BUILTIN_PROVIDERS } from '../providers/registry-sources.js';

/** A name to save a typed-in provider under: Ollama and LM Studio by their port, else the host. */
export function customProviderName(baseURL: string): string {
  let url: URL;
  try { url = new URL(baseURL.trim()); } catch { throw new Error('Enter an address like http://localhost:1234/v1.'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
  if (local && url.port === '11434') return 'ollama';
  if (local && url.port === '1234') return 'lmstudio';
  if (local) return 'local';
  const label = url.hostname.split('.').find((part) => !['api', 'www', 'app'].includes(part)) ?? 'custom';
  const name = label.replace(/[^a-zA-Z0-9_-]/gu, '-').replace(/^[^a-zA-Z]+/u, '') || 'custom';
  return BUILTIN_PROVIDERS.includes(name.toLowerCase()) ? `${name}-custom` : name;
}
