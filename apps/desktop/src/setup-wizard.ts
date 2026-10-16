import type { ProviderStatus } from "../../../src/auth/provider-status";
import type { CloudApiState } from "./cloud-settings";

/**
 * The first-run window's four steps: where you'll use AgentUse, sign in (Cloud
 * only), pick the AI, ready. Main gathers the facts; these shape them for the page.
 */

export interface SetupCloudState {
  status: "none" | "connecting" | "joining" | "connected";
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
  connecting?: { code?: string; joining?: boolean };
  error?: string;
}): SetupCloudState {
  if (input.connecting?.joining) return { status: "joining" };
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
  const custom = status.customProviders.find((provider) => provider.hasApiKey);
  return custom ? { ready: true, label: custom.id } : { ready: false };
}

/** The address in the browser for a pairing code, for "Open browser again". */
export function connectPageUrl(cloud: string, code: string): string {
  return `${cloud.replace(/\/+$/u, "")}/connect?code=${encodeURIComponent(code)}`;
}

export const SETUP_API_KEY_PROVIDERS = ["anthropic", "openai", "openrouter"] as const;
export type SetupApiKeyProvider = typeof SETUP_API_KEY_PROVIDERS[number];

export function isSetupApiKeyProvider(value: unknown): value is SetupApiKeyProvider {
  return typeof value === "string" && (SETUP_API_KEY_PROVIDERS as readonly string[]).includes(value);
}
