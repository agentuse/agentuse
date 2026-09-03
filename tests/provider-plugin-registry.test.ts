import { describe, expect, it } from 'bun:test';
import {
  getProviderPluginRegistryEntry,
  PROVIDER_PLUGIN_REGISTRY,
} from '../src/plugin/provider-registry';
import { resolvePluginSource } from '../src/plugin/provider-installer';

describe('curated provider plugin registry', () => {
  it('lists the community Claude Code subscription provider first', () => {
    expect(PROVIDER_PLUGIN_REGISTRY[0]).toMatchObject({
      id: 'claude-code-subscription',
      packageName: 'agentuse-claude-code-provider',
      version: '0.1.0',
      source: 'cb7337/agentuse-claude-code-provider@v0.1.0',
      repository: 'https://github.com/cb7337/agentuse-claude-code-provider',
      provenance: 'community',
      provider: 'anthropic',
      authMethods: ['oauth'],
      authMethodId: 'subscription',
      apiVersion: 1,
    });
  });

  it('keeps registry identities unique and every source installable', () => {
    expect(new Set(PROVIDER_PLUGIN_REGISTRY.map((entry) => entry.id)).size)
      .toBe(PROVIDER_PLUGIN_REGISTRY.length);
    expect(new Set(PROVIDER_PLUGIN_REGISTRY.map((entry) => entry.packageName)).size)
      .toBe(PROVIDER_PLUGIN_REGISTRY.length);
    for (const entry of PROVIDER_PLUGIN_REGISTRY) {
      expect(resolvePluginSource(entry.source)).toEqual({
        url: `${entry.repository}.git`,
        ref: `v${entry.version}`,
      });
      expect(getProviderPluginRegistryEntry(entry.id)).toBe(entry);
    }
  });
});
