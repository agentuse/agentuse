import { describe, expect, it } from 'bun:test';
import {
  getProviderPluginRegistryEntry,
  PROVIDER_PLUGIN_REGISTRY,
} from '../src/plugin/provider-registry';
import { resolvePluginSource } from '../src/plugin/provider-installer';

describe('curated provider plugin registry', () => {
  it('retains the subscription migration provider independently of shortlist ordering', () => {
    expect(getProviderPluginRegistryEntry('claude-code-subscription')).toMatchObject({
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
      const source = resolvePluginSource(entry.source);
      expect(source.url).toBe(`${entry.repository}.git`);
      expect([`v${entry.version}`, entry.commit]).toContain(source.ref);
      expect(entry.commit).toMatch(/^[a-f0-9]{40}$/);
      expect(getProviderPluginRegistryEntry(entry.id)).toBe(entry);
    }
  });

  it('supports externally managed credentials without inventing an OAuth slot', () => {
    expect(getProviderPluginRegistryEntry('pi-cli')).toMatchObject({
      provider: 'pi',
      authMethods: [],
      authMethodId: '',
    });
    expect(getProviderPluginRegistryEntry('not-in-the-registry')).toBeUndefined();
  });
});
