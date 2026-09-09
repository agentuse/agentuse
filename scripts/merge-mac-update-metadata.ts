#!/usr/bin/env bun

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { basename, dirname, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

type MacArchitecture = 'arm64' | 'x64';

export interface MacUpdateFile {
  url: string;
  sha512: string;
  size?: number;
  blockMapSize?: number;
  [key: string]: unknown;
}

export interface MacUpdateMetadata {
  version: string;
  files: MacUpdateFile[];
  path?: string;
  sha512?: string;
  releaseDate?: string;
  [key: string]: unknown;
}

function fail(message: string): never {
  throw new Error(`Cannot merge macOS update metadata: ${message}`);
}

function architectureFor(url: string): MacArchitecture | null {
  const match = /(?:^|[-_.])(arm64|x64)(?:[-_.]|$)/.exec(url);
  return (match?.[1] as MacArchitecture | undefined) ?? null;
}

function validateFile(file: MacUpdateFile, source: string): MacArchitecture {
  if (!file || typeof file.url !== 'string' || typeof file.sha512 !== 'string') {
    fail(`${source} contains a file without url and sha512 strings.`);
  }
  if (file.url !== basename(file.url) || file.url.includes('..')) {
    fail(`${source} contains a non-local asset URL: ${file.url}`);
  }
  const architecture = architectureFor(file.url);
  if (!architecture) {
    fail(`${source} asset ${file.url} does not name arm64 or x64 explicitly.`);
  }
  return architecture;
}

function fileRank(file: MacUpdateFile): string {
  const extensionRank = file.url.endsWith('-mac.zip') ? '0' : file.url.endsWith('.dmg') ? '1' : '2';
  const architectureRank = architectureFor(file.url) === 'x64' ? '0' : '1';
  return `${extensionRank}:${architectureRank}:${file.url}`;
}

/**
 * Combine the per-architecture electron-builder documents into the single
 * latest-mac.yml consumed by electron-updater. Asset names must carry their
 * architecture because electron-updater selects the ZIP containing process.arch.
 */
export function mergeMacUpdateMetadata(
  sources: Array<{ name: string; metadata: MacUpdateMetadata }>,
): MacUpdateMetadata {
  if (sources.length !== 2) fail(`expected two architecture documents, received ${sources.length}.`);

  const versions = new Set(sources.map(({ metadata }) => metadata?.version));
  if (versions.size !== 1 || [...versions][0] == null) {
    fail(`input versions differ: ${[...versions].join(', ') || '(missing)'}.`);
  }

  const filesByUrl = new Map<string, MacUpdateFile>();
  for (const { name, metadata } of sources) {
    if (!Array.isArray(metadata?.files) || metadata.files.length === 0) {
      fail(`${name} has no files.`);
    }
    for (const file of metadata.files) {
      validateFile(file, name);
      const existing = filesByUrl.get(file.url);
      if (existing && JSON.stringify(existing) !== JSON.stringify(file)) {
        fail(`asset ${file.url} has conflicting metadata.`);
      }
      filesByUrl.set(file.url, file);
    }
  }

  const files = [...filesByUrl.values()].sort((left, right) => fileRank(left).localeCompare(fileRank(right)));
  for (const architecture of ['arm64', 'x64'] as const) {
    if (!files.some((file) => architectureFor(file.url) === architecture && file.url.endsWith('-mac.zip'))) {
      fail(`missing ${architecture} Mac ZIP.`);
    }
    if (!files.some((file) => architectureFor(file.url) === architecture && file.url.endsWith('.dmg'))) {
      fail(`missing ${architecture} DMG.`);
    }
  }

  // Keep the legacy path/sha512 fields pointed at x64 for older clients that
  // do not inspect files. Current clients select the matching files entry.
  const primary = files.find((file) => architectureFor(file.url) === 'x64' && file.url.endsWith('-mac.zip'))!;
  const releaseDates = sources
    .map(({ metadata }) => metadata.releaseDate)
    .filter((value): value is string => typeof value === 'string')
    .sort();

  const merged: MacUpdateMetadata = {
    version: [...versions][0]!,
    files,
    path: primary.url,
    sha512: primary.sha512,
  };
  if (releaseDates.length > 0) merged.releaseDate = releaseDates[releaseDates.length - 1]!;
  return merged;
}

function readMetadata(path: string): MacUpdateMetadata {
  try {
    return parse(readFileSync(path, 'utf8')) as MacUpdateMetadata;
  } catch (error) {
    fail(`could not read ${path}: ${(error as Error).message}`);
  }
}

function assertReferencedAssetsExist(metadataPath: string, metadata: MacUpdateMetadata): void {
  for (const file of metadata.files ?? []) {
    validateFile(file, metadataPath);
    const assetPath = resolve(dirname(metadataPath), file.url);
    if (!existsSync(assetPath)) fail(`${metadataPath} references missing asset ${file.url}.`);
    if (!existsSync(`${assetPath}.blockmap`)) fail(`${metadataPath} is missing blockmap ${file.url}.blockmap.`);
  }
}

export function mergeMacUpdateMetadataFiles(inputPaths: string[], outputPath: string): void {
  const sources = inputPaths.map((path) => ({ name: path, metadata: readMetadata(path) }));
  for (const source of sources) assertReferencedAssetsExist(source.name, source.metadata);
  const merged = mergeMacUpdateMetadata(sources);
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, stringify(merged, { lineWidth: 0 }));
}

if (import.meta.main) {
  const [arm64Path, x64Path, outputPath] = process.argv.slice(2);
  if (!arm64Path || !x64Path || !outputPath) {
    console.error('Usage: bun scripts/merge-mac-update-metadata.ts <arm64-yml> <x64-yml> <output-yml>');
    process.exit(1);
  }
  mergeMacUpdateMetadataFiles([arm64Path, x64Path], outputPath);
  console.log(`Merged macOS update metadata: ${outputPath}`);
}
