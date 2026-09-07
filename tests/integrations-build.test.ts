import { afterEach, describe, expect, test } from 'bun:test';
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildIntegrationArtifacts } from '../scripts/build-integrations';

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
  test('builds self-contained, version-matched packages from canonical skills', () => {
    const output = mkdtempSync(join(tmpdir(), 'agentuse-integrations-'));
    created.push(output);
    const artifacts = buildIntegrationArtifacts(output);
    const sourceVersion = JSON.parse(readFileSync(resolve(import.meta.dir, '..', 'package.json'), 'utf8')).version;

    expect(artifacts.archives.codex).toEndWith('/agentuse-codex-plugin.zip');
    expect(artifacts.archives.claude).toEndWith('/agentuse-claude-plugin.zip');
    expect(artifacts.archives.pi).toEndWith('/agentuse-pi-package.tgz');
    expect(artifacts.archives.skill).toEndWith('/agentuse-skill.zip');

    const codexEntries = archiveEntries('unzip', ['-Z1', artifacts.archives.codex]);
    expect(codexEntries).toContain('agentuse/.codex-plugin/plugin.json');
    expect(codexEntries).toContain('agentuse/skills/automate/SKILL.md');
    expect(codexEntries).toContain('agentuse/skills/automate/references/core.md');
    expect(codexEntries).toContain('.agents/plugins/marketplace.json');
    const codexRelease = JSON.parse(archiveEntries('unzip', ['-p', artifacts.archives.codex, '.agents/plugins/marketplace.json']).join('\n'));
    expect(codexRelease.name).toBe('agentuse-release');
    expect(codexRelease.plugins[0].source).toEqual({ source: 'local', path: './agentuse' });

    const claudeEntries = archiveEntries('unzip', ['-Z1', artifacts.archives.claude]);
    expect(claudeEntries).toContain('agentuse/.claude-plugin/plugin.json');
    expect(claudeEntries).toContain('agentuse/skills/automate/references/creator.md');
    expect(claudeEntries).toContain('.claude-plugin/marketplace.json');
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

    const piEntries = archiveEntries('tar', ['-tzf', artifacts.archives.pi]);
    expect(piEntries).toContain('package/package.json');
    expect(piEntries).toContain('package/prompts/automate.md');
    expect(piEntries).toContain('package/skills/automate/references/tester.md');

    const skillEntries = archiveEntries('unzip', ['-Z1', artifacts.archives.skill]);
    expect(skillEntries).toContain('automate/SKILL.md');
    expect(skillEntries).toContain('automate/VERSION');
    expect(skillEntries).toContain('automate/references/automate.md');

    const codexManifest = JSON.parse(readFileSync(resolve(
      artifacts.codexMarketplace,
      'plugins/agentuse/.codex-plugin/plugin.json',
    ), 'utf8'));
    const claudeManifest = JSON.parse(readFileSync(resolve(
      artifacts.claudeMarketplace,
      'plugins/agentuse/.claude-plugin/plugin.json',
    ), 'utf8'));
    const piManifest = JSON.parse(readFileSync(resolve(artifacts.piPackage, 'package.json'), 'utf8'));
    expect(codexManifest.version).toStartWith(`${sourceVersion}+codex.`);
    expect(claudeManifest.version).toBe(sourceVersion);
    expect(piManifest.version).toBe(sourceVersion);

    const bundlePaths = [
      resolve(artifacts.portableSkill, 'bundle.json'),
      resolve(artifacts.codexMarketplace, 'plugins/agentuse/skills/automate/bundle.json'),
      resolve(artifacts.claudeMarketplace, 'plugins/agentuse/skills/automate/bundle.json'),
      resolve(artifacts.piPackage, 'skills/automate/bundle.json'),
    ];
    const bundles = bundlePaths.map((path) => readFileSync(path, 'utf8'));
    expect(new Set(bundles).size).toBe(1);
    const bundle = JSON.parse(bundles[0]!);
    expect(bundle.sourceVersion).toBe(sourceVersion);
    expect(Object.keys(bundle.skills)).toEqual(['automate', 'core', 'creator', 'tester']);

    const commonFiles = [
      'SKILL.md',
      'bundle.json',
      'references/automate.md',
      'references/core.md',
      'references/creator.md',
      'references/tester.md',
    ];
    const packageSkillRoots = [
      resolve(artifacts.codexMarketplace, 'plugins/agentuse/skills/automate'),
      resolve(artifacts.claudeMarketplace, 'plugins/agentuse/skills/automate'),
      resolve(artifacts.piPackage, 'skills/automate'),
    ];
    for (const file of commonFiles) {
      const canonical = readFileSync(resolve(artifacts.portableSkill, file));
      for (const packageRoot of packageSkillRoots) {
        expect(readFileSync(resolve(packageRoot, file)).equals(canonical)).toBe(true);
      }
    }
    for (const skill of ['automate', 'core', 'creator', 'tester']) {
      const reference = readFileSync(resolve(artifacts.portableSkill, `references/${skill}.md`));
      const digest = createHash('sha256').update(reference).digest('hex');
      expect(bundle.skills[skill].sha256).toBe(digest);
    }
  });
});
