import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { AGENTUSE_MCP_URL, buildIntegrationArtifacts } from '../scripts/build-integrations';

const created: string[] = [];

afterEach(() => {
  for (const path of created.splice(0)) rmSync(path, { recursive: true, force: true });
});

function archiveEntries(command: string, args: string[]): string[] {
  const result = spawnSync(command, args, { encoding: 'utf8' });
  if (result.status !== 0) throw new Error(result.stderr || result.stdout);
  return result.stdout.trim().split('\n').filter(Boolean);
}

describe('AgentUse integration artifacts', () => {
  test('builds MCP-only plugins for Claude Code and Codex that point at AgentUse Cloud', () => {
    const output = mkdtempSync(join(tmpdir(), 'agentuse-integrations-'));
    created.push(output);
    const artifacts = buildIntegrationArtifacts(output);
    const sourceVersion = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'package.json'), 'utf8')).version;
    const expectedMcp = { mcpServers: { agentuse: { type: 'http', url: AGENTUSE_MCP_URL } } };

    expect(artifacts.archives.codex).toEndWith('/agentuse-codex-plugin.zip');
    expect(artifacts.archives.claude).toEndWith('/agentuse-claude-plugin.zip');

    const codexEntries = archiveEntries('unzip', ['-Z1', artifacts.archives.codex]);
    expect(codexEntries).toContain('agentuse/.codex-plugin/plugin.json');
    expect(codexEntries).toContain('agentuse/.mcp.json');
    expect(codexEntries).toContain('agentuse/assets/icon.svg');
    expect(codexEntries).toContain('.agents/plugins/marketplace.json');
    expect(codexEntries.some((entry) => entry.includes('skills/'))).toBe(false);
    const codexRelease = JSON.parse(archiveEntries('unzip', ['-p', artifacts.archives.codex, '.agents/plugins/marketplace.json']).join('\n'));
    expect(codexRelease.name).toBe('agentuse-release');
    expect(codexRelease.plugins[0].source).toEqual({ source: 'local', path: './agentuse' });

    const claudeEntries = archiveEntries('unzip', ['-Z1', artifacts.archives.claude]);
    expect(claudeEntries).toContain('agentuse/.claude-plugin/plugin.json');
    expect(claudeEntries).toContain('agentuse/.mcp.json');
    expect(claudeEntries).toContain('.claude-plugin/marketplace.json');
    expect(claudeEntries.some((entry) => entry.includes('skills/'))).toBe(false);
    const claudeRelease = JSON.parse(archiveEntries('unzip', ['-p', artifacts.archives.claude, '.claude-plugin/marketplace.json']).join('\n'));
    expect(claudeRelease.name).toBe('agentuse-release');
    expect(claudeRelease.plugins[0].source).toBe('./agentuse');
    expect(claudeRelease.plugins[0].version).toBe(sourceVersion);

    // Public install instructions must not depend on a source checkout or a
    // development marketplace; dev installs keep their separate identity.
    for (const [marketplace, manifest] of [
      [artifacts.codexMarketplace, '.agents/plugins/marketplace.json'],
      [artifacts.claudeMarketplace, '.claude-plugin/marketplace.json'],
    ]) {
      expect(JSON.parse(readFileSync(resolve(marketplace!, manifest!), 'utf8')).name).toBe('agentuse-development');
    }

    // Both plugins carry the same AgentUse Cloud entry; Codex names it from
    // its manifest, Claude Code reads .mcp.json at the plugin root.
    const codexManifest = JSON.parse(readFileSync(resolve(artifacts.codexMarketplace, 'plugins/agentuse/.codex-plugin/plugin.json'), 'utf8'));
    const claudeManifest = JSON.parse(readFileSync(resolve(artifacts.claudeMarketplace, 'plugins/agentuse/.claude-plugin/plugin.json'), 'utf8'));
    expect(codexManifest.mcpServers).toBe('./.mcp.json');
    expect(codexManifest.skills).toBeUndefined();
    expect(codexManifest.interface.composerIcon).toBe('./assets/icon.svg');
    expect(existsSync(resolve(artifacts.codexMarketplace, 'plugins/agentuse/assets/icon.svg'))).toBe(true);
    expect(codexManifest.version).toStartWith(`${sourceVersion}+codex.`);
    expect(claudeManifest.version).toBe(sourceVersion);
    for (const plugin of [
      resolve(artifacts.codexMarketplace, 'plugins/agentuse/.mcp.json'),
      resolve(artifacts.claudeMarketplace, 'plugins/agentuse/.mcp.json'),
    ]) {
      expect(JSON.parse(readFileSync(plugin, 'utf8'))).toEqual(expectedMcp);
    }
  });
});
