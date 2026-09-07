import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, resolve } from 'node:path';

const repoRoot = resolve(import.meta.dir, '..');
const defaultOutputRoot = resolve(repoRoot, 'dist/integrations');
const skills = ['automate', 'core', 'creator', 'tester'] as const;
type SkillName = (typeof skills)[number];

export interface IntegrationArtifacts {
  outputRoot: string;
  codexMarketplace: string;
  claudeMarketplace: string;
  piPackage: string;
  portableSkill: string;
  archives: {
    codex: string;
    claude: string;
    pi: string;
    skill: string;
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

function skillContents(): Record<SkillName, string> {
  return Object.fromEntries(skills.map((name) => [
    name,
    readText(resolve(repoRoot, 'skill-data', name, 'SKILL.md')),
  ])) as Record<SkillName, string>;
}

function buildFreshnessAdapter(automate: string): string {
  const frontmatter = automate.match(/^---\n[\s\S]*?\n---\n/)?.[0];
  if (!frontmatter) throw new Error('automate skill is missing YAML frontmatter');
  return `${frontmatter}\n${readText(resolve(repoRoot, 'integrations/shared/automate-adapter.md'))}`;
}

function bundleFiles(contents: Record<SkillName, string>, sourceVersion: string): Record<string, string> {
  const manifest = {
    generatedBy: 'bun scripts/build-integrations.ts',
    sourcePackage: 'agentuse',
    sourceVersion,
    skills: Object.fromEntries(skills.map((name) => [name, { sha256: sha256(contents[name]) }])),
  };
  return {
    'SKILL.md': buildFreshnessAdapter(contents.automate),
    'references/automate.md': contents.automate,
    'references/core.md': contents.core,
    'references/creator.md': contents.creator,
    'references/tester.md': contents.tester,
    'bundle.json': `${JSON.stringify(manifest, null, 2)}\n`,
  };
}

function writeBundle(destination: string, files: Record<string, string>): void {
  for (const [relativePath, content] of Object.entries(files)) {
    writeText(resolve(destination, relativePath), content);
  }
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

function packPi(piRoot: string, artifactRoot: string): string {
  const npmCache = mkdtempSync(resolve(tmpdir(), 'agentuse-integration-npm-cache-'));
  try {
    const result = spawnSync('npm', ['pack', '--json', '--pack-destination', artifactRoot], {
      cwd: piRoot,
      encoding: 'utf8',
      env: { ...process.env, npm_config_cache: npmCache },
    });
    if (result.status !== 0) {
      throw new Error(`npm pack failed: ${(result.stderr || result.stdout || 'unknown error').trim()}`);
    }
    const output = JSON.parse(result.stdout) as Array<{ filename?: string }>;
    const filename = output[0]?.filename;
    if (!filename) throw new Error('npm pack did not return an artifact filename');
    const packed = resolve(artifactRoot, filename);
    const stable = resolve(artifactRoot, 'agentuse-pi-package.tgz');
    renameSync(packed, stable);
    return stable;
  } finally {
    rmSync(npmCache, { recursive: true, force: true });
  }
}

export function buildIntegrationArtifacts(outputRoot = defaultOutputRoot): IntegrationArtifacts {
  const output = resolve(outputRoot);
  const packageJson = JSON.parse(readText(resolve(repoRoot, 'package.json'))) as { version: string };
  const sourceVersion = packageJson.version;
  const contents = skillContents();
  const files = bundleFiles(contents, sourceVersion);
  const contentId = sha256(Object.values(files).join('\0')).slice(0, 12);
  const replacements = {
    '__AGENTUSE_VERSION__': sourceVersion,
    '__CODEX_VERSION__': `${sourceVersion}+codex.${contentId}`,
    '__MARKETPLACE_NAME__': 'agentuse-development',
    '__MARKETPLACE_DISPLAY_NAME__': 'AgentUse Development',
    '__PLUGIN_PATH__': './plugins/agentuse',
  };

  rmSync(output, { recursive: true, force: true });
  mkdirSync(output, { recursive: true });

  const portableSkill = resolve(output, 'skill/automate');
  writeBundle(portableSkill, files);
  writeText(resolve(portableSkill, 'VERSION'), sourceVersion);

  const codexMarketplace = resolve(output, 'codex-marketplace');
  const codexPlugin = resolve(codexMarketplace, 'plugins/agentuse');
  writeText(resolve(codexMarketplace, '.agents/plugins/marketplace.json'), renderTemplate('codex/marketplace.json', replacements));
  writeText(resolve(codexPlugin, '.codex-plugin/plugin.json'), renderTemplate('codex/plugin.json', replacements));
  writeText(resolve(codexPlugin, 'README.md'), renderTemplate('codex/README.md', replacements));
  cpSync(resolve(repoRoot, 'LICENSE'), resolve(codexPlugin, 'LICENSE'));
  writeBundle(resolve(codexPlugin, 'skills/automate'), files);

  const claudeMarketplace = resolve(output, 'claude-marketplace');
  const claudePlugin = resolve(claudeMarketplace, 'plugins/agentuse');
  writeText(resolve(claudeMarketplace, '.claude-plugin/marketplace.json'), renderTemplate('claude-code/marketplace.json', replacements));
  writeText(resolve(claudePlugin, '.claude-plugin/plugin.json'), renderTemplate('claude-code/plugin.json', replacements));
  writeText(resolve(claudePlugin, 'README.md'), renderTemplate('claude-code/README.md', replacements));
  cpSync(resolve(repoRoot, 'LICENSE'), resolve(claudePlugin, 'LICENSE'));
  writeBundle(resolve(claudePlugin, 'skills/automate'), files);

  const piPackage = resolve(output, 'pi');
  writeText(resolve(piPackage, 'package.json'), renderTemplate('pi/package.json', replacements));
  writeText(resolve(piPackage, 'README.md'), renderTemplate('pi/README.md', replacements));
  writeText(resolve(piPackage, 'prompts/automate.md'), renderTemplate('pi/prompts/automate.md', replacements));
  cpSync(resolve(repoRoot, 'LICENSE'), resolve(piPackage, 'LICENSE'));
  writeBundle(resolve(piPackage, 'skills/automate'), files);

  const artifactRoot = resolve(output, 'artifacts');
  mkdirSync(artifactRoot, { recursive: true });
  const archives = {
    codex: resolve(artifactRoot, 'agentuse-codex-plugin.zip'),
    claude: resolve(artifactRoot, 'agentuse-claude-plugin.zip'),
    pi: '',
    skill: resolve(artifactRoot, 'agentuse-skill.zip'),
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
  zipDirectory(dirname(portableSkill), basename(portableSkill), archives.skill);
  archives.pi = packPi(piPackage, artifactRoot);

  return {
    outputRoot: output,
    codexMarketplace,
    claudeMarketplace,
    piPackage,
    portableSkill,
    archives,
  };
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
