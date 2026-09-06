import { createHash, randomBytes } from 'crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import { pathToFileURL } from 'url';
import * as esbuild from 'esbuild';
import type { AgentUsePackageManifest } from './types';

export interface ResolvedPackageManifest {
  name: string;
  version: string;
  agentuse: AgentUsePackageManifest;
}

/**
 * One compiled module per (file, mtime). A serve daemon loads project plugins
 * on every run; without this each run would rebundle and import a fresh module
 * URL that the ESM cache never releases.
 */
const compiledExtensions = new Map<string, { mtimeMs: number; module: Promise<unknown> }>();

export async function importExtensionModule(entry: string): Promise<unknown> {
  if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
    const { mtimeMs } = await stat(entry);
    const cached = compiledExtensions.get(entry);
    if (cached && cached.mtimeMs === mtimeMs) return cached.module;
    const module = bundleExtensionModule(entry);
    compiledExtensions.set(entry, { mtimeMs, module });
    module.catch(() => {
      if (compiledExtensions.get(entry)?.module === module) compiledExtensions.delete(entry);
    });
    return module;
  }
  const info = await stat(entry);
  return (await import(`${pathToFileURL(entry).href}?v=${info.mtimeMs}`)).default;
}

async function bundleExtensionModule(entry: string): Promise<unknown> {
  const result = await esbuild.build({
    entryPoints: [entry], bundle: true, platform: 'node', format: 'esm', target: 'node22',
    sourcemap: 'inline', write: false, absWorkingDir: dirname(entry), external: ['node:*'],
  });
  const tempDir = await mkdtemp(join(tmpdir(), 'agentuse-plugin-'));
  const file = join(tempDir, `${createHash('sha256').update(entry).digest('hex').slice(0, 12)}-${randomBytes(4).toString('hex')}.mjs`);
  try {
    await writeFile(file, result.outputFiles[0]!.text, { flag: 'wx' });
    return (await import(`${pathToFileURL(file).href}?v=${Date.now()}`)).default;
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

function validateEntries(root: string, entries: unknown): string[] {
  if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== 'string')) {
    throw new Error('package.json agentuse.extensions must be a non-empty string array');
  }
  return entries.map((entry) => {
    const absolute = resolve(root, entry);
    const fromRoot = relative(root, absolute);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error(`Extension entry must stay inside the package: ${entry}`);
    return entry;
  });
}

function validateProviderMetadata(providers: unknown): AgentUsePackageManifest['providers'] {
  if (providers === undefined) return undefined;
  if (!Array.isArray(providers)) throw new Error('package.json agentuse.providers must be an array');
  return providers.map((provider) => {
    if (!provider || typeof provider !== 'object') {
      throw new Error('package.json agentuse.providers entries must be objects');
    }
    const value = provider as { id?: unknown; auth?: unknown };
    if (typeof value.id !== 'string' || !value.id.trim()) {
      throw new Error('package.json agentuse.providers entries must define a non-empty id');
    }
    if (value.auth !== undefined && (!Array.isArray(value.auth)
      || value.auth.some((method) => method !== 'oauth' && method !== 'api_key'))) {
      throw new Error('package.json agentuse.providers auth must contain only oauth or api_key');
    }
    return {
      id: value.id.trim(),
      ...(value.auth !== undefined && { auth: value.auth as Array<'oauth' | 'api_key'> }),
    };
  });
}

export async function readPackageManifest(root: string): Promise<ResolvedPackageManifest> {
  const value = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  const agentuse = value.agentuse as Partial<AgentUsePackageManifest> | undefined;
  if (typeof value.name !== 'string' || typeof value.version !== 'string' || agentuse?.apiVersion !== 1) {
    throw new Error('package.json must define name, version, and agentuse.apiVersion: 1');
  }
  const extensions = validateEntries(root, agentuse.extensions);
  const providers = validateProviderMetadata(agentuse.providers);
  await Promise.all(extensions.map((entry) => stat(resolve(root, entry))));
  return {
    name: value.name,
    version: value.version,
    agentuse: { ...agentuse, apiVersion: 1, extensions, ...(providers && { providers }) } as AgentUsePackageManifest,
  };
}
