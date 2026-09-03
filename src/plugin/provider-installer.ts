import { createHash, randomBytes } from 'crypto';
import { execFile } from 'child_process';
import { mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'fs/promises';
import { dirname, join, resolve } from 'path';
import { tmpdir } from 'os';
import { promisify } from 'util';
import {
  loadPluginPackageDirectory,
  providerPluginHome,
  providerPluginRegistryPath,
  readInstalledPluginRecords,
  resetProviderPluginCache,
} from './provider-runtime';
import type { InstalledPluginRecord } from './types';
import { readPackageManifest } from './loader';
import { findProjectRoot } from '../utils/project';
import { AuthStorage } from '../auth/storage';

const exec = promisify(execFile);
const GITHUB_REPO = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;

export interface PluginInstallOptions {
  local?: boolean;
  projectRoot?: string;
}

interface ResolvedSource { url: string; ref?: string }

const FULL_COMMIT_REF = /^[0-9a-f]{40}$/i;

export interface PluginSourceInspection {
  source: string;
  repository: string;
  publisher: string;
  ref: string;
  commit: string;
  name: string;
  version: string;
  apiVersion: 1;
  providers: Array<{ id: string; auth: Array<'oauth' | 'api_key'> }>;
}

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
    throw new Error('Plugin source must be a local directory path, owner/repo, github:owner/repo, or a GitHub Git URL');
  }
}

function assertPinnedRemoteSource(source: string): ResolvedSource & { ref: string } {
  if (isLocalPath(source)) throw new Error('Provider plugin source must be a pinned GitHub repository');
  const resolved = resolvePluginSource(source);
  if (!resolved.ref) throw new Error('Provider plugin source must include a tag or full commit');
  if (/^(?:head|main|master)$/i.test(resolved.ref)) throw new Error('Provider plugin source must use a release tag or full commit, not a moving branch');
  return { ...resolved, ref: resolved.ref };
}

async function cloneResolvedSource(staging: string, resolvedSource: ResolvedSource): Promise<void> {
  try {
    await cloneResolvedSourceRaw(staging, resolvedSource);
  } catch (error) {
    // git prints the full command and the temp path; users need the source.
    const label = `${resolvedSource.url}${resolvedSource.ref ? `@${resolvedSource.ref}` : ''}`;
    const stderr = (error as { stderr?: string }).stderr?.trim().split(/\r?\n/).at(-1);
    throw new Error(`Could not fetch plugin ${label}. Check that the repository exists and the ref is published.${stderr ? ` (${stderr})` : ''}`);
  }
}

async function cloneResolvedSourceRaw(staging: string, resolvedSource: ResolvedSource): Promise<void> {
  if (resolvedSource.ref && FULL_COMMIT_REF.test(resolvedSource.ref)) {
    await exec('git', ['init', staging], { maxBuffer: 10 * 1024 * 1024 });
    await exec('git', ['-C', staging, 'remote', 'add', 'origin', resolvedSource.url], { maxBuffer: 10 * 1024 * 1024 });
    await exec('git', ['-C', staging, 'fetch', '--depth', '1', 'origin', resolvedSource.ref], { maxBuffer: 10 * 1024 * 1024 });
    await exec('git', ['-C', staging, 'checkout', '--detach', 'FETCH_HEAD'], { maxBuffer: 10 * 1024 * 1024 });
    return;
  }
  const args = ['clone', '--depth', '1'];
  if (resolvedSource.ref) args.push('--branch', resolvedSource.ref);
  args.push(resolvedSource.url, staging);
  await exec('git', args, { maxBuffer: 10 * 1024 * 1024 });
}

/** Read static package metadata without importing or executing plugin code. */
export async function inspectPluginSource(source: string): Promise<PluginSourceInspection> {
  const resolvedSource = assertPinnedRemoteSource(source);
  const staging = await mkdtemp(join(tmpdir(), 'agentuse-plugin-inspect-'));
  try {
    await cloneResolvedSource(staging, resolvedSource);
    if (!FULL_COMMIT_REF.test(resolvedSource.ref)) {
      const { stdout } = await exec('git', ['-C', staging, 'tag', '--points-at', 'HEAD']);
      if (!stdout.split(/\r?\n/).includes(resolvedSource.ref)) {
        throw new Error(`Provider plugin ref must resolve to a Git tag: ${resolvedSource.ref}`);
      }
    }
    const manifest = await readPackageManifest(staging);
    const { stdout: commitOutput } = await exec('git', ['-C', staging, 'rev-parse', 'HEAD']);
    const repository = resolvedSource.url
      .replace(/^git@github\.com:/, 'https://github.com/')
      .replace(/^ssh:\/\/git@github\.com\//, 'https://github.com/')
      .replace(/\.git$/, '');
    const publisher = new URL(repository).pathname.split('/').filter(Boolean)[0] ?? 'unknown';
    const providers = (manifest.agentuse.providers ?? []).flatMap((provider) => {
      if (!provider || typeof provider.id !== 'string' || !provider.id) return [];
      const auth = Array.isArray(provider.auth)
        ? provider.auth.filter((method): method is 'oauth' | 'api_key' => method === 'oauth' || method === 'api_key')
        : [];
      return [{ id: provider.id, auth }];
    });
    return {
      source,
      repository,
      publisher,
      ref: resolvedSource.ref,
      commit: commitOutput.trim(),
      name: manifest.name,
      version: manifest.version,
      apiVersion: 1,
      providers,
    };
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {});
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

async function readRecords(options?: PluginInstallOptions): Promise<InstalledPluginRecord[]> {
  return options?.local ? readProjectPluginRecords(options) : readInstalledPluginRecords();
}

/**
 * Re-read the registry under the shared auth lock and apply `mutate` to the
 * latest records, so concurrent installs cannot overwrite each other's entry.
 */
async function mutateRegistry(
  options: PluginInstallOptions | undefined,
  mutate: (records: InstalledPluginRecord[]) => InstalledPluginRecord[],
): Promise<void> {
  await AuthStorage.withAuthLock(async () => {
    const records = mutate(await readRecords(options));
    const file = registryPath(options);
    await mkdir(dirname(file), { recursive: true });
    const temp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(temp, `${JSON.stringify(records, null, 2)}\n`, { mode: 0o600 });
    await rename(temp, file);
  });
  resetProviderPluginCache();
}

function upsert(record: InstalledPluginRecord): (records: InstalledPluginRecord[]) => InstalledPluginRecord[] {
  return (records) => [...records.filter((item) => item.name !== record.name), record];
}

function without(name: string): (records: InstalledPluginRecord[]) => InstalledPluginRecord[] {
  return (records) => records.filter((item) => item.name !== name);
}

async function installRuntimeDependencies(root: string): Promise<void> {
  let pkg: { dependencies?: Record<string, string> };
  try {
    pkg = JSON.parse(await readFile(join(root, 'package.json'), 'utf8')) as typeof pkg;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (Object.keys(pkg.dependencies ?? {}).length === 0) return;
  try {
    await exec('npm', ['install', '--omit=dev', '--ignore-scripts', '--no-audit', '--no-fund'], {
      cwd: root,
      maxBuffer: 10 * 1024 * 1024,
      env: { ...process.env, npm_config_ignore_scripts: 'true' },
    });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new Error('This plugin has dependencies but npm was not found on PATH. Install Node.js/npm and retry.');
    }
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
    await cloneResolvedSource(staging, resolvedSource);
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

async function inspectLinkedPlugin(source: string, options?: PluginInstallOptions): Promise<InstalledPluginRecord> {
  const directory = resolve(source);
  const scope = options?.local ? 'project' : 'global';
  const { manifest, host } = await loadPluginPackageDirectory(directory, scope);
  await host.dispose();
  const now = new Date().toISOString();
  return {
    name: manifest.name,
    version: manifest.version,
    source,
    directory,
    linked: true,
    scope,
    ...(options?.local && { projectRoot: projectRoot(options) }),
    installedAt: now,
    updatedAt: now,
  };
}

export async function installPlugin(source: string, options?: PluginInstallOptions): Promise<InstalledPluginRecord> {
  const records = options?.local ? await readProjectPluginRecords(options) : await readInstalledPluginRecords();
  // A path on disk always links (edits are live); only a path pinned to a full
  // commit, or a remote source, is cloned into the managed plugin home.
  const resolvedLocal = isLocalPath(source) ? resolvePluginSource(source) : undefined;
  if (resolvedLocal && !resolvedLocal.ref) {
    const record = await inspectLinkedPlugin(source, options);
    const existing = records.find((item) => item.name === record.name);
    if (existing) throw new Error(`Plugin '${existing.name}' is already installed; run agentuse plugins update ${existing.name}`);
    await mutateRegistry(options, upsert(record));
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
    await mutateRegistry(options, upsert(record));
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
  const results: InstalledPluginRecord[] = [];
  for (const current of targets) {
    if (current.linked) {
      const { manifest, host } = await loadPluginPackageDirectory(current.directory, current.scope);
      await host.dispose();
      if (manifest.name !== current.name) {
        throw new Error(`Linked plugin changed name from '${current.name}' to '${manifest.name}'`);
      }
      const next: InstalledPluginRecord = {
        ...current,
        version: manifest.version,
        updatedAt: new Date().toISOString(),
      };
      await mutateRegistry(options, upsert(next));
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
      await mutateRegistry(options, upsert(next));
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
    await mutateRegistry(options, without(name));
    return record;
  }
  assertManagedDirectory(record, options);
  const staged = `${record.directory}.remove-${process.pid}-${randomBytes(3).toString('hex')}`;
  await rename(record.directory, staged);
  try {
    await mutateRegistry(options, without(name));
  } catch (error) {
    await rename(staged, record.directory).catch(() => {});
    throw error;
  }
  await rm(staged, { recursive: true, force: true });
  return record;
}

