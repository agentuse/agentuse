// Deployment brand for the web UI. `agentuse serve` acts as a company's
// internal operating layer, so the header and titles can carry that company's
// name (config.json `serve.brand.name`). The server injects the configured
// name into the HTML shell as `window.__AGENTUSE_BRAND__` (static.ts
// renderShell), making it available synchronously at first render: no fetch,
// no title flash. Unconfigured deployments resolve to "AgentUse".

declare global {
  interface Window {
    __AGENTUSE_BRAND__?: { name?: string };
  }
}

const DEFAULT_NAME = 'AgentUse';

export function brandName(): string {
  const name = typeof window !== 'undefined' ? window.__AGENTUSE_BRAND__?.name : undefined;
  return typeof name === 'string' && name.trim() ? name.trim() : DEFAULT_NAME;
}

/** True when a deployment-specific brand name is configured. */
export function hasCustomBrand(): boolean {
  return brandName() !== DEFAULT_NAME;
}

/**
 * Document title: "AgentUse / Sessions", or "Kettlebase · AgentUse / Sessions"
 * when a brand is configured. No parts yields the bare base for the home page.
 */
export function pageTitle(...parts: string[]): string {
  const base = hasCustomBrand() ? `${brandName()} · ${DEFAULT_NAME}` : DEFAULT_NAME;
  return [base, ...parts.filter(Boolean)].join(' / ');
}
