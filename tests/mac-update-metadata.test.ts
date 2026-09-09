import { describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import {
  mergeMacUpdateMetadata,
  mergeMacUpdateMetadataFiles,
  type MacUpdateMetadata,
} from '../scripts/merge-mac-update-metadata.ts';

function metadata(architecture: 'arm64' | 'x64', releaseDate: string): MacUpdateMetadata {
  return {
    version: '0.22.0',
    files: [
      {
        url: `AgentUse-0.22.0-${architecture}-mac.zip`,
        sha512: `${architecture}-zip-hash`,
        size: 150,
      },
      {
        url: `AgentUse-0.22.0-${architecture}-mac.dmg`,
        sha512: `${architecture}-dmg-hash`,
        size: 151,
      },
    ],
    path: `AgentUse-0.22.0-${architecture}-mac.zip`,
    sha512: `${architecture}-zip-hash`,
    releaseDate,
  };
}

describe('macOS update metadata merge', () => {
  it('combines both architectures and keeps the x64 legacy fallback', () => {
    const merged = mergeMacUpdateMetadata([
      { name: 'arm64/latest-mac.yml', metadata: metadata('arm64', '2026-09-08T10:00:00.000Z') },
      { name: 'x64/latest-mac.yml', metadata: metadata('x64', '2026-09-08T10:02:00.000Z') },
    ]);

    expect(merged.files.map((file) => file.url)).toEqual([
      'AgentUse-0.22.0-x64-mac.zip',
      'AgentUse-0.22.0-arm64-mac.zip',
      'AgentUse-0.22.0-x64-mac.dmg',
      'AgentUse-0.22.0-arm64-mac.dmg',
    ]);
    expect(merged.path).toBe('AgentUse-0.22.0-x64-mac.zip');
    expect(merged.sha512).toBe('x64-zip-hash');
    expect(merged.releaseDate).toBe('2026-09-08T10:02:00.000Z');
    expect(merged.version).toBe('0.22.0');
  });

  it('rejects mismatched versions', () => {
    const x64 = metadata('x64', '2026-09-08T10:02:00.000Z');
    x64.version = '0.22.1';
    expect(() => mergeMacUpdateMetadata([
      { name: 'arm64', metadata: metadata('arm64', '2026-09-08T10:00:00.000Z') },
      { name: 'x64', metadata: x64 },
    ])).toThrow('input versions differ');
  });

  it('requires architecture-explicit ZIP and DMG assets', () => {
    const x64 = metadata('x64', '2026-09-08T10:02:00.000Z');
    x64.files[0]!.url = 'AgentUse-0.22.0-mac.zip';
    expect(() => mergeMacUpdateMetadata([
      { name: 'arm64', metadata: metadata('arm64', '2026-09-08T10:00:00.000Z') },
      { name: 'x64', metadata: x64 },
    ])).toThrow('does not name arm64 or x64 explicitly');
  });

  it('rejects asset paths that escape the artifact directory', () => {
    const x64 = metadata('x64', '2026-09-08T10:02:00.000Z');
    x64.files[0]!.url = '../AgentUse-0.22.0-x64-mac.zip';
    expect(() => mergeMacUpdateMetadata([
      { name: 'arm64', metadata: metadata('arm64', '2026-09-08T10:00:00.000Z') },
      { name: 'x64', metadata: x64 },
    ])).toThrow('non-local asset URL');
  });

  it('merges artifact documents only when every asset and blockmap exists', () => {
    const root = mkdtempSync(join(tmpdir(), 'agentuse-mac-metadata-'));
    try {
      const inputPaths = (['arm64', 'x64'] as const).map((architecture) => {
        const directory = join(root, architecture);
        mkdirSync(directory);
        const document = metadata(architecture, `2026-09-08T10:0${architecture === 'arm64' ? '0' : '2'}:00.000Z`);
        for (const file of document.files) {
          writeFileSync(join(directory, file.url), architecture);
          writeFileSync(join(directory, `${file.url}.blockmap`), architecture);
        }
        const path = join(directory, 'latest-mac.yml');
        writeFileSync(path, stringify(document));
        return path;
      });
      const outputPath = join(root, 'release', 'latest-mac.yml');

      mergeMacUpdateMetadataFiles(inputPaths, outputPath);

      const merged = parse(readFileSync(outputPath, 'utf8')) as MacUpdateMetadata;
      expect(merged.files).toHaveLength(4);
      expect(merged.path).toBe('AgentUse-0.22.0-x64-mac.zip');

      rmSync(join(root, 'arm64', 'AgentUse-0.22.0-arm64-mac.dmg.blockmap'));
      expect(() => mergeMacUpdateMetadataFiles(inputPaths, outputPath)).toThrow('is missing blockmap');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
