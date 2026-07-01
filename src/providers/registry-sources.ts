/**
 * Single source of truth for the built-in providers whose model catalog and
 * context limits come from models.dev.
 *
 * Maps our provider prefix (how a model is addressed: `<prefix>:<model-id>`) to
 * the models.dev provider key it is generated from. The registry generator
 * (`scripts/generate-models.ts`) builds one full MODELS bucket per entry, and
 * the generated `Provider` type is derived from these keys — so coverage is
 * driven by this list, not hardcoded in the generator. Add a provider here and
 * re-run `pnpm generate:models` to give it real context limits.
 *
 * Note: `demo` and user-added custom providers are intentionally absent — they
 * have no models.dev catalog and fall back to the default context limit.
 */
export const REGISTRY_PROVIDER_SOURCES = {
  anthropic: 'anthropic',
  openai: 'openai',
  openrouter: 'openrouter',
  'opencode-go': 'opencode-go',
  bedrock: 'amazon-bedrock',
} as const;

/** Provider prefixes backed by the generated registry (limits + catalog). */
export type RegistryProvider = keyof typeof REGISTRY_PROVIDER_SOURCES;

/** All registry-backed provider prefixes, as a flat list. */
export const REGISTRY_PROVIDERS = Object.keys(REGISTRY_PROVIDER_SOURCES) as RegistryProvider[];

/**
 * The demo provider: a built-in, deterministic stub with no models.dev catalog
 * (so it is not registry-backed) and no authentication.
 */
export const DEMO_PROVIDER = 'demo';

/**
 * Every built-in provider prefix `createModel` resolves natively — the
 * registry-backed set plus `demo`. Use for "is this a known provider" checks
 * and reserved custom-provider names. Anything not here is a custom provider.
 */
export const BUILTIN_PROVIDERS: readonly string[] = [...REGISTRY_PROVIDERS, DEMO_PROVIDER];

/**
 * Built-in providers you authenticate to with an API key / OAuth (i.e. that
 * `agentuse auth login`/`logout` manage). Excludes `bedrock` (uses AWS
 * credentials, not our auth store) and `demo` (needs no auth).
 */
export const AUTH_PROVIDERS: readonly string[] = ['anthropic', 'openai', 'openrouter', 'opencode-go'];
