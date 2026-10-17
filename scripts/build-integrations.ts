import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';

/**
 * Builds the AgentUse plugins for Claude Code and Codex. Each plugin is only
 * an MCP server entry for AgentUse Cloud: the /automate and /triage workflows
 * are served by the AgentUse MCP server itself, so no plugin carries a copy.
 */

const repoRoot = resolve(import.meta.dir, '..');
const defaultOutputRoot = resolve(repoRoot, 'dist/integrations');
export const AGENTUSE_MCP_URL = 'https://cloud.agentuse.io/mcp';

export interface IntegrationArtifacts {
  outputRoot: string;
  codexMarketplace: string;
  claudeMarketplace: string;
  archives: {
    codex: string;
    claude: string;
  };
}

function sha256(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex');
}

function readText(path: string): string {
  return readFileSync(path, 'utf8');
}

function writeText(path: string, content: string): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content.endsWith('\n') ? content : `${content}\n`);
}

function renderTemplate(relativePath: string, replacements: Record<string, string>): string {
  let content = readText(resolve(repoRoot, 'integrations', relativePath));
  for (const [token, value] of Object.entries(replacements)) {
    content = content.replaceAll(token, value);
  }
  const unresolved = content.match(/__[A-Z0-9_]+__/g);
  if (unresolved) throw new Error(`${relativePath} has unresolved tokens: ${unresolved.join(', ')}`);
  return content;
}

function zipDirectory(cwd: string, entry: string | string[], destination: string): void {
  mkdirSync(dirname(destination), { recursive: true });
  const result = spawnSync('zip', ['-X', '-q', '-r', destination, ...[entry].flat()], {
    cwd,
    encoding: 'utf8',
  });
  if (result.status !== 0) {
    throw new Error(`zip failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
  }
}

export function buildIntegrationArtifacts(outputRoot = defaultOutputRoot): IntegrationArtifacts {
  const output = resolve(outputRoot);
  const packageJson = JSON.parse(readText(resolve(repoRoot, 'package.json'))) as { version: string };
  const sourceVersion = packageJson.version;
  const mcpConfig = renderTemplate('shared/mcp.json', { '__AGENTUSE_MCP_URL__': AGENTUSE_MCP_URL });
  const codexAssets = resolve(repoRoot, 'integrations/codex/assets');
  // Codex keeps an installed plugin per version, so the version changes
  // whenever anything in the plugin does, including its icon.
  const contentId = sha256([
    mcpConfig,
    readText(resolve(repoRoot, 'integrations/codex/plugin.json')),
    readText(resolve(codexAssets, 'icon.svg')),
  ].join('\n')).slice(0, 12);
  const replacements = {
    '__AGENTUSE_VERSION__': sourceVersion,
    '__CODEX_VERSION__': `${sourceVersion}+codex.${contentId}`,
    '__MARKETPLACE_NAME__': 'agentuse-development',
    '__MARKETPLACE_DISPLAY_NAME__': 'AgentUse Development',
    '__PLUGIN_PATH__': './plugins/agentuse',
  };

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  const codexMarketplace = resolve(output, 'codex-marketplace');
  const codexPlugin = resolve(codexMarketplace, 'plugins/agentuse');
  writeText(resolve(codexMarketplace, '.agents/plugins/marketplace.json'), renderTemplate('codex/marketplace.json', replacements));
  writeText(resolve(codexPlugin, '.codex-plugin/plugin.json'), renderTemplate('codex/plugin.json', replacements));
  writeText(resolve(codexPlugin, '.mcp.json'), mcpConfig);
  writeText(resolve(codexPlugin, 'README.md'), renderTemplate('codex/README.md', replacements));
  mkdirSync(resolve(codexPlugin, 'assets'), { recursive: true });
  cpSync(resolve(codexAssets, 'icon.svg'), resolve(codexPlugin, 'assets/icon.svg'));
  cpSync(resolve(repoRoot, 'LICENSE'), resolve(codexPlugin, 'LICENSE'));

  const claudeMarketplace = resolve(output, 'claude-marketplace');
  const claudePlugin = resolve(claudeMarketplace, 'plugins/agentuse');
  writeText(resolve(claudeMarketplace, '.claude-plugin/marketplace.json'), renderTemplate('claude-code/marketplace.json', replacements));
  writeText(resolve(claudePlugin, '.claude-plugin/plugin.json'), renderTemplate('claude-code/plugin.json', replacements));
  writeText(resolve(claudePlugin, '.mcp.json'), mcpConfig);
  writeText(resolve(claudePlugin, 'README.md'), renderTemplate('claude-code/README.md', replacements));
  cpSync(resolve(repoRoot, 'LICENSE'), resolve(claudePlugin, 'LICENSE'));

  const artifactRoot = resolve(output, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  const archives = {
    codex: resolve(artifactRoot, 'agentuse-codex-plugin.zip'),
    claude: resolve(artifactRoot, 'agentuse-claude-plugin.zip'),
  };
  // Keep the existing agentuse/ plugin entry while making each release ZIP
  // directly installable as a local marketplace after extraction.
  const releaseReplacements = {
    ...replacements,
    '__MARKETPLACE_NAME__': 'agentuse-release',
    '__MARKETPLACE_DISPLAY_NAME__': 'AgentUse Release',
    '__PLUGIN_PATH__': './agentuse',
  };
  for (const [host, plugin, metadata, archive] of [
    ['codex', codexPlugin, '.agents/plugins/marketplace.json', archives.codex],
    ['claude-code', claudePlugin, '.claude-plugin/marketplace.json', archives.claude],
  ] as const) {
    const releaseRoot = resolve(output, 'release-marketplaces', host);
    cpSync(plugin, resolve(releaseRoot, 'agentuse'), { recursive: true });
    writeText(resolve(releaseRoot, metadata), renderTemplate(`${host}/marketplace.json`, releaseReplacements));
    zipDirectory(releaseRoot, ['agentuse', metadata.split('/')[0]!], archive);
  }

  return { outputRoot: output, codexMarketplace, claudeMarketplace, archives };
}

function main(): void {
  const outIndex = process.argv.indexOf('--out');
  const output = outIndex >= 0 ? process.argv[outIndex + 1] : undefined;
  if (outIndex >= 0 && !output) throw new Error('--out requires a directory');
  const artifacts = buildIntegrationArtifacts(output ?? defaultOutputRoot);
  console.log(`Built integrations in ${artifacts.outputRoot}`);
  for (const path of Object.values(artifacts.archives)) console.log(`Built ${basename(path)}`);
}

if (import.meta.main) main();
