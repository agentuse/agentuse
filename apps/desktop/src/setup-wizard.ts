import type { ProviderStatus } from "../../../src/auth/provider-status";
export { customProviderName } from "../../../src/auth/custom-provider-name";
import type { CloudApiState } from "./cloud-settings";

/**
 * The first-run window's four steps: where you'll use AgentUse, sign in (Cloud
 * only), pick the AI, ready. Main gathers the facts; these shape them for the page.
 */

export interface SetupCloudState {
  status: "none" | "connecting" | "connected";
  code?: string;
  account?: string;
  mcpUrl?: string;
  error?: string;
}

export interface SetupAiState {
  ready: boolean;
  label?: string;
}

export function setupCloudState(input: {
  api?: CloudApiState;
  saved?: { account?: string; name: string; mcpUrl: string };
  connecting?: { code?: string };
  error?: string;
}): SetupCloudState {
  if (input.connecting) return { status: "connecting", ...(input.connecting.code && { code: input.connecting.code }) };
  // Disconnected from the account page leaves a dead connection on disk.
  if (input.saved && input.api?.status !== "disconnected from the cloud") {
    const account = input.api?.account ?? input.saved.account;
    return {
      status: "connected",
      ...(account && { account }),
      mcpUrl: input.api?.mcpUrl ?? input.saved.mcpUrl,
    };
  }
  return { status: "none", ...(input.error && { error: input.error }) };
}

/** Whether an AI can run agents, and how to name it on the Ready step. */
export function setupAiState(status: Pick<ProviderStatus, "providers" | "customProviders">): SetupAiState {
  for (const provider of status.providers) {
    if (!provider.configured) continue;
    const source = provider.sources.find((candidate) => candidate.active) ?? provider.sources[0];
    if (provider.id === "openai" && source?.kind === "oauth") return { ready: true, label: "your ChatGPT plan" };
    return { ready: true, label: provider.name };
  }
  // A model on this Mac (Ollama, LM Studio) needs no key; it was checked when saved.
  const custom = status.customProviders.find((provider) => provider.hasApiKey || (provider.models?.length ?? 0) > 0);
  if (!custom) return { ready: false };
  const model = custom.models?.[0];
  const where = LOCAL_MODEL_SERVERS.find((server) => server.id === custom.id)?.name ?? custom.id;
  return { ready: true, label: model ? `${model} on ${where}` : where };
}

/** Apps that serve models on this Mac, at their default addresses. */
export const LOCAL_MODEL_SERVERS = [
  { id: "ollama", name: "Ollama", baseURL: "http://127.0.0.1:11434/v1" },
  { id: "lmstudio", name: "LM Studio", baseURL: "http://127.0.0.1:1234/v1" },
] as const;

export interface LocalModelServer {
  id: string;
  name: string;
  baseURL: string;
  models: { id: string; size?: number }[];
}

type Fetch = (url: string, init?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Ollama or LM Studio, if running, with the chat models each has downloaded. */
export async function detectLocalModels(fetchImpl: Fetch = fetch, timeoutMs = 1_500): Promise<LocalModelServer[]> {
  const found = await Promise.all(LOCAL_MODEL_SERVERS.map(async (server): Promise<LocalModelServer | undefined> => {
    try {
      const response = await fetchImpl(`${server.baseURL}/models`, { signal: AbortSignal.timeout(timeoutMs) });
      if (!response.ok) return undefined;
      const listed = (await response.json() as { data?: { id?: unknown }[] }).data ?? [];
      const ids = listed.map((model) => model.id).filter((id): id is string => typeof id === "string" && !/embed/iu.test(id));
      // Ollama's own list has sizes; the OpenAI-style list doesn't.
      const sizes = new Map<string, number>();
      if (server.id === "ollama") {
        const tags = await fetchImpl(new URL("/api/tags", server.baseURL).toString(), { signal: AbortSignal.timeout(timeoutMs) })
          .then((res) => res.ok ? res.json() as Promise<{ models?: { name?: unknown; size?: unknown }[] }> : {})
          .catch(() => ({})) as { models?: { name?: unknown; size?: unknown }[] };
        for (const tag of tags.models ?? []) {
          if (typeof tag.name === "string" && typeof tag.size === "number") sizes.set(tag.name, tag.size);
        }
      }
      return { ...server, models: ids.map((id) => ({ id, ...(sizes.has(id) && { size: sizes.get(id) }) })) };
    } catch {
      return undefined;
    }
  }));
  return found.filter((server): server is LocalModelServer => Boolean(server && server.models.length > 0));
}


/**
 * The page where the person types the code. Like `gh auth login`, the code is
 * never in the link, so a link someone sends can't add their computer instead.
 */
export function connectPageUrl(cloud: string): string {
  return `${cloud.replace(/\/+$/u, "")}/connect`;
}

export const SETUP_API_KEY_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type SetupApiKeyProvider = typeof SETUP_API_KEY_PROVIDERS[number];

export function isSetupApiKeyProvider(value: unknown): value is SetupApiKeyProvider {
  return typeof value === "string" && (SETUP_API_KEY_PROVIDERS as readonly string[]).includes(value);
}
