/**
 * Provider plugins reviewed for presentation inside AgentUse's provider setup.
 *
 * This is deliberately a small, release-owned shortlist rather than a remote
 * marketplace. Adding an entry makes third-party executable code discoverable
 * from a trusted product surface, so every source and description is reviewed
 * alongside an AgentUse release.
 */
export interface ProviderPluginRegistryEntry {
  /** Stable AgentUse identifier. It does not depend on the package name. */
  id: string;
  /** Package name declared by the plugin manifest. */
  packageName: string;
  version: string;
  name: string;
  description: string;
  /** GitHub source accepted by `agentuse plugins install`. Shown to users. */
  source: string;
  /**
   * Full commit the tag pointed at when this entry was reviewed. Installs use
   * this so a moved tag can never change the code that runs.
   */
  commit: string;
  repository: string;
  publisher: string;
  provenance: 'community';
  /** Built-in provider namespace adapted by this plugin. */
  provider: string;
  authMethods: readonly ('oauth' | 'api_key')[];
  /** Credential slot used for migration and missing-package recovery. */
  authMethodId: string;
  apiVersion: 1;
}

export const PROVIDER_PLUGIN_REGISTRY: readonly ProviderPluginRegistryEntry[] = [
  {
    id: 'claude-code-subscription',
    packageName: 'agentuse-claude-code-provider',
    version: '0.1.0',
    name: 'Claude Code Subscription',
    description: 'Use Anthropic models through an eligible Claude Pro or Max subscription.',
    source: 'cb7337/agentuse-claude-code-provider@v0.1.0',
    commit: 'b3240daac509f0512321cb4677b2e9ee39651a8d',
    repository: 'https://github.com/cb7337/agentuse-claude-code-provider',
    publisher: 'cb7337',
    provenance: 'community',
    provider: 'anthropic',
    authMethods: ['oauth'],
    authMethodId: 'subscription',
    apiVersion: 1,
  },
];

/** Immutable install source: the reviewed commit, not the movable tag. */
export function providerPluginInstallSource(entry: ProviderPluginRegistryEntry): string {
  return `${entry.repository}@${entry.commit}`;
}

export function getProviderPluginRegistryEntry(id: string): ProviderPluginRegistryEntry | undefined {
  return PROVIDER_PLUGIN_REGISTRY.find((entry) => entry.id === id);
}
