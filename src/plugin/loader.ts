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

export async function importPluginModule(entry: string): Promise<unknown> {
  if (entry.endsWith('.ts') || entry.endsWith('.tsx')) {
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
  const info = await stat(entry);
  return (await import(`${pathToFileURL(entry).href}?v=${info.mtimeMs}`)).default;
}

function validateEntries(root: string, entries: unknown): string[] {
  if (!Array.isArray(entries) || entries.length === 0 || entries.some((entry) => typeof entry !== 'string')) {
    throw new Error('package.json agentuse.plugins must be a non-empty string array');
  }
  return entries.map((entry) => {
    const absolute = resolve(root, entry);
    const fromRoot = relative(root, absolute);
    if (fromRoot.startsWith('..') || isAbsolute(fromRoot)) throw new Error(`Plugin entry must stay inside the package: ${entry}`);
    return entry;
  });
}

export async function readPackageManifest(root: string): Promise<ResolvedPackageManifest> {
  const value = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as Record<string, unknown>;
  const agentuse = value.agentuse as Partial<AgentUsePackageManifest> | undefined;
  if (typeof value.name !== 'string' || typeof value.version !== 'string' || agentuse?.apiVersion !== 1) {
    throw new Error('package.json must define name, version, and agentuse.apiVersion: 1');
  }
  const plugins = validateEntries(root, agentuse.plugins);
  await Promise.all(plugins.map((entry) => stat(resolve(root, entry))));
  return { name: value.name, version: value.version, agentuse: { ...agentuse, apiVersion: 1, plugins } as AgentUsePackageManifest };
}
