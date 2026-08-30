import { createHash, randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { promisify } from 'util';
import {
  loadPluginPackageDirectory,
  providerPluginHome,
  providerPluginRegistryPath,
  readInstalledPluginRecords,
  resetProviderPluginCache,
} from './provider-runtime';
import type { InstalledPluginRecord } from './types';
import { findProjectRoot } from '../utils/project';

const exec = promisify(execFile);
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface PluginInstallOptions {
  local?: boolean;
  projectRoot?: string;
}

interface ResolvedSource { url: string; ref?: string }

const FULL_COMMIT_REF = /^[0-9a-f]{40}$/i;

function isLocalPath(source: string): boolean {
  return source.startsWith('./') || source.startsWith('../') || source.startsWith('/');
}

function projectRoot(options?: PluginInstallOptions): string {
  return resolve(options?.projectRoot ?? findProjectRoot(process.cwd()));
}

export function projectPluginHome(options?: PluginInstallOptions): string {
  return join(projectRoot(options), '.agentuse', 'packages');
}

export function projectPluginRegistryPath(options?: PluginInstallOptions): string {
  return join(projectRoot(options), '.agentuse', 'plugins.json');
}

function installHome(options?: PluginInstallOptions): string {
  return options?.local ? projectPluginHome(options) : providerPluginHome();
}

function registryPath(options?: PluginInstallOptions): string {
  return options?.local ? projectPluginRegistryPath(options) : providerPluginRegistryPath();
}

function splitRef(source: string): { source: string; ref?: string } {
  let marker: number;
  if (source.includes('://')) {
    const pathStart = source.indexOf('/', source.indexOf('://') + 3);
    marker = pathStart === -1 ? -1 : source.indexOf('@', pathStart);
  } else if (source.startsWith('git@')) {
    marker = source.indexOf('@', 4);
  } else {
    marker = source.lastIndexOf('@');
  }
  if (marker <= 0) return { source };
  const suffix = source.slice(marker + 1);
  if (!suffix) return { source };
  return { source: source.slice(0, marker), ref: suffix };
}

export function normalizeGitHubPluginSource(source: string): string {
  return resolvePluginSource(source).url;
}

export function resolvePluginSource(source: string): ResolvedSource {
  if (isLocalPath(source)) {
    // Local checkouts may be pinned to a full commit for hermetic tests and
    // project installs. Treat only an unambiguous full SHA as a suffix so paths
    // containing ordinary @ characters remain valid.
    const local = splitRef(source);
    if (local.ref && FULL_COMMIT_REF.test(local.ref) && isLocalPath(local.source)) {
      return { url: resolve(local.source), ref: local.ref };
    }
    return { url: resolve(source) };
  }
  const withoutPrefix = source.startsWith('git:') && !source.startsWith('git://')
    ? source.slice(4)
    : source.startsWith('github:') ? source.slice(7) : source;
  const split = splitRef(withoutPrefix);
  if (split.source.startsWith('github.com/')) {
    const repo = split.source.slice('github.com/'.length);
    if (GITHUB_REPO.test(repo)) return { url: `https://github.com/${repo}.git`, ...(split.ref && { ref: split.ref }) };
  }
  if (GITHUB_REPO.test(split.source)) return { url: `https://github.com/${split.source}.git`, ...(split.ref && { ref: split.ref }) };
  try {
    const url = new URL(split.source);
    const parts = url.pathname.replace(/\.git$/, '').split('/').filter(Boolean);
    // Installed extensions execute with the user's permissions. Refuse
    // unauthenticated plaintext transports so source cannot be replaced in
    // transit before it is imported.
    const validProtocol = url.protocol === 'https:' || url.protocol === 'ssh:';
    const validUsername = !url.username || (url.protocol === 'ssh:' && url.username === 'git');
    if (!validProtocol || url.hostname !== 'github.com' || !validUsername || url.password || url.search || url.hash || parts.length !== 2) throw new Error();
    return { url: split.source, ...(split.ref && { ref: split.ref }) };
  } catch {
    if (/^git@github\.com:[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\.git)?$/.test(split.source)) {
      return { url: split.source, ...(split.ref && { ref: split.ref }) };
    }
    throw new Error('Plugin source must be a local Git checkout, owner/repo, github:owner/repo, or a GitHub Git URL');
  }
}

export async function readProjectPluginRecords(options?: PluginInstallOptions): Promise<InstalledPluginRecord[]> {
  try {
    const value = JSON.parse(await readFile(projectPluginRegistryPath(options), 'utf8')) as unknown;
    return Array.isArray(value) ? value as InstalledPluginRecord[] : [];
  } catch {
    return [];
  }
}

export async function readAllPluginRecords(options?: PluginInstallOptions): Promise<InstalledPluginRecord[]> {
  return [...await readInstalledPluginRecords(), ...await readProjectPluginRecords(options)];
}

function assertManagedDirectory(record: InstalledPluginRecord, options?: PluginInstallOptions): void {
  const home = resolve(record.scope === 'project' ? projectPluginHome({ local: true, projectRoot: record.projectRoot ?? projectRoot(options) }) : providerPluginHome());
  const target = resolve(record.directory);
  if (target === home || dirname(target) !== home) throw new Error(`Refusing to modify unmanaged plugin directory: ${record.directory}`);
}

async function writeRegistry(records: InstalledPluginRecord[], options?: PluginInstallOptions): Promise<void> {
  const file = registryPath(options);
  await mkdir(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
  await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
  await rename(temp, file);
  resetProviderPluginCache();
}

async function installRuntimeDependencies(root: string): Promise<void> {
  try {
    const pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as { dependencies?: Record<string, string> };
    if (Object.keys(pkg.dependencies ?? {}).length === 0) return;
    await exec('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, npm_config_ignore_scripts: 'true' },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
}

async function cloneAndInspect(source: string, options?: PluginInstallOptions): Promise<{
  staging: string;
  record: Omit<InstalledPluginRecord, 'installedAt' | 'updatedAt'>;
}> {
  const home = installHome(options);
  await mkdir(home, { recursive: true });
  const staging = await mkdtemp(join(home, '.install-'));
  const resolvedSource = resolvePluginSource(source);
  try {
    if (resolvedSource.ref && FULL_COMMIT_REF.test(resolvedSource.ref)) {
      // `git clone --branch` accepts branches and tags, not arbitrary commit
      // objects. Initialize explicitly and fetch the requested commit so the
      // documented owner/repo@commit form resolves to that exact revision.
      await exec('git', ['init', staging], { maxBuffer: 10 * 1024 * 1024 });
      await exec('git', ['-C', staging, 'remote', 'add', 'origin', resolvedSource.url], { maxBuffer: 10 * 1024 * 1024 });
      await exec('git', ['-C', staging, 'fetch', '--depth', '1', 'origin', resolvedSource.ref], { maxBuffer: 10 * 1024 * 1024 });
      await exec('git', ['-C', staging, 'checkout', '--detach', 'FETCH_HEAD'], { maxBuffer: 10 * 1024 * 1024 });
    } else {
      const args = ['clone', '--depth', '1'];
      if (resolvedSource.ref) args.push('--branch', resolvedSource.ref);
      args.push(resolvedSource.url, staging);
      await exec('git', args, { maxBuffer: 10 * 1024 * 1024 });
    }
    await installRuntimeDependencies(staging);
    const { manifest, host } = await loadPluginPackageDirectory(staging, options?.local ? 'project' : 'global');
    await host.dispose();
    const { stdout } = await exec('git', ['-C', staging, 'rev-parse', 'HEAD']);
    return {
      staging,
      record: {
        name: manifest.name,
        version: manifest.version,
        source,
        directory: '',
        scope: options?.local ? 'project' : 'global',
        ...(options?.local && { projectRoot: projectRoot(options) }),
        commit: stdout.trim(),
        ...(resolvedSource.ref && { ref: resolvedSource.ref }),
      },
    };
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

async function inspectLinkedPlugin(source: string, options: PluginInstallOptions): Promise<InstalledPluginRecord> {
  const directory = resolve(source);
  const { manifest, host } = await loadPluginPackageDirectory(directory, 'project');
  await host.dispose();
  const now = new Date().toISOString();
  return {
    name: manifest.name,
    version: manifest.version,
    source,
    directory,
    linked: true,
    scope: 'project',
    projectRoot: projectRoot(options),
    installedAt: now,
    updatedAt: now,
  };
}

export async function installPlugin(source: string, options?: PluginInstallOptions): Promise<InstalledPluginRecord> {
  const records = options?.local ? await readProjectPluginRecords(options) : await readInstalledPluginRecords();
  const resolvedLocal = isLocalPath(source) ? resolvePluginSource(source) : undefined;
  if (options?.local && resolvedLocal && !resolvedLocal.ref) {
    const record = await inspectLinkedPlugin(source, options);
    const existing = records.find((item) => item.name === record.name);
    if (existing) throw new Error(`Plugin '${existing.name}' is already installed; run agentuse plugins update ${existing.name}`);
    await writeRegistry([...records, record], options);
    return record;
  }
  const candidate = await cloneAndInspect(source, options);
  const existing = records.find((item) => item.name === candidate.record.name);
  if (existing) {
    await rm(candidate.staging, { recursive: true, force: true });
    throw new Error(`Plugin '${existing.name}' is already installed; run agentuse plugins update ${existing.name}`);
  }
  const slug = candidate.record.name.replace(/[^A-Za-z0-9_.-]/g, '-');
  const directory = join(installHome(options), `${slug}-${createHash('sha256').update(candidate.record.name).digest('hex').slice(0, 8)}`);
  try {
    await rename(candidate.staging, directory);
  } catch (error) {
    await rm(candidate.staging, { recursive: true, force: true });
    throw error;
  }
  const now = new Date().toISOString();
  const record: InstalledPluginRecord = { ...candidate.record, directory, installedAt: now, updatedAt: now };
  try {
    await writeRegistry([...records, record], options);
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
  return record;
}

export async function updatePlugins(name?: string, options?: PluginInstallOptions): Promise<InstalledPluginRecord[]> {
  const records = options?.local ? await readProjectPluginRecords(options) : await readInstalledPluginRecords();
  const targets = name ? records.filter((item) => item.name === name) : records;
  if (name && targets.length === 0) throw new Error(`Plugin '${name}' is not installed`);
  const updated = [...records];
  const results: InstalledPluginRecord[] = [];
  for (const current of targets) {
    if (current.linked) {
      const { manifest, host } = await loadPluginPackageDirectory(current.directory, 'project');
      await host.dispose();
      if (manifest.name !== current.name) {
        throw new Error(`Linked plugin changed name from '${current.name}' to '${manifest.name}'`);
      }
      const next: InstalledPluginRecord = {
        ...current,
        version: manifest.version,
        updatedAt: new Date().toISOString(),
      };
      updated[updated.findIndex((item) => item.name === current.name)] = next;
      await writeRegistry(updated, options);
      results.push(next);
      continue;
    }
    assertManagedDirectory(current, options);
    const candidate = await cloneAndInspect(current.source, options);
    if (candidate.record.name !== current.name) {
      await rm(candidate.staging, { recursive: true, force: true });
      throw new Error(`Update source changed plugin name from '${current.name}' to '${candidate.record.name}'`);
    }
    const backup = `${current.directory}.old-${process.pid}-${randomBytes(3).toString('hex')}`;
    await rename(current.directory, backup);
    try {
      await rename(candidate.staging, current.directory);
      const next: InstalledPluginRecord = {
        ...current,
        version: candidate.record.version,
        ...(candidate.record.commit && { commit: candidate.record.commit }),
        updatedAt: new Date().toISOString(),
      };
      updated[updated.findIndex((item) => item.name === current.name)] = next;
      await writeRegistry(updated, options);
      await rm(backup, { recursive: true, force: true });
      results.push(next);
    } catch (error) {
      await rm(current.directory, { recursive: true, force: true }).catch(() => {});
      await rename(backup, current.directory).catch(() => {});
      throw error;
    }
  }
  return results;
}

export async function removePlugin(name: string, options?: PluginInstallOptions): Promise<InstalledPluginRecord> {
  const records = options?.local ? await readProjectPluginRecords(options) : await readInstalledPluginRecords();
  const record = records.find((item) => item.name === name);
  if (!record) throw new Error(`Plugin '${name}' is not installed`);
  if (record.linked) {
    await writeRegistry(records.filter((item) => item.name !== name), options);
    return record;
  }
  assertManagedDirectory(record, options);
  const staged = `${record.directory}.remove-${process.pid}-${randomBytes(3).toString('hex')}`;
  await rename(record.directory, staged);
  try {
    await writeRegistry(records.filter((item) => item.name !== name), options);
  } catch (error) {
    await rename(staged, record.directory).catch(() => {});
    throw error;
  }
  await rm(staged, { recursive: true, force: true });
  return record;
}

// Compatibility names for the pre-v1 provider-only package commands.
export const installProviderPlugin = installPlugin;
export const updateProviderPlugins = updatePlugins;
export const uninstallProviderPlugin = removePlugin;
