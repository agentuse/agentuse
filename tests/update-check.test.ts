import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  UPDATE_REMINDER_INTERVAL_MS,
  __testing,
  detectPackageManager,
  isNewerVersion,
  shouldRefreshUpdateCache,
  updateCommand,
  getCachedAvailableUpdate,
} from '../src/update-check';
import { loadGlobalDefaults } from '../src/utils/global-config';

describe('update check', () => {
  let root: string;
  let originalXdgDataHome: string | undefined;
  let originalAgentuseEnv: string | undefined;
  let originalAgentuseConfig: string | undefined;
  let originalUpdateDisabled: string | undefined;

  beforeEach(async () => {
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    originalAgentuseEnv = process.env.AGENTUSE_ENV;
    originalAgentuseConfig = process.env.AGENTUSE_CONFIG;
    originalUpdateDisabled = process.env.AGENTUSE_UPDATE_CHECK_DISABLED;
    root = await mkdtemp(join(tmpdir(), 'agentuse-update-'));
    process.env.XDG_DATA_HOME = root;
    delete process.env.AGENTUSE_UPDATE_CHECK_DISABLED;
  });

  afterEach(async () => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    if (originalAgentuseEnv === undefined) delete process.env.AGENTUSE_ENV;
    else process.env.AGENTUSE_ENV = originalAgentuseEnv;
    if (originalAgentuseConfig === undefined) delete process.env.AGENTUSE_CONFIG;
    else process.env.AGENTUSE_CONFIG = originalAgentuseConfig;
    if (originalUpdateDisabled === undefined) delete process.env.AGENTUSE_UPDATE_CHECK_DISABLED;
    else process.env.AGENTUSE_UPDATE_CHECK_DISABLED = originalUpdateDisabled;
    await rm(root, { recursive: true, force: true });
  });

  it('compares stable and prerelease semantic versions', () => {
    expect(isNewerVersion('0.18.0', '0.17.0')).toBe(true);
    expect(isNewerVersion('0.18.0', '0.18.0-beta.2')).toBe(true);
    expect(isNewerVersion('0.18.0-beta.1', '0.18.0')).toBe(false);
    expect(isNewerVersion('0.16.9', '0.17.0')).toBe(false);
    expect(isNewerVersion('latest', '0.17.0')).toBe(false);
    expect(isNewerVersion('1.0.0-alpha.10', '1.0.0-alpha.2')).toBe(true);
    expect(isNewerVersion('1.0.0-alpha', '1.0.0-ALPHA')).toBe(true);
    expect(isNewerVersion('1.0.0-alpha..1', '1.0.0-alpha.1')).toBe(false);
    expect(isNewerVersion('1.0.0-alpha.01', '1.0.0-alpha.1')).toBe(false);
  });

  it('detects common global package managers and gives an exact command', () => {
    expect(detectPackageManager({ npm_config_user_agent: 'pnpm/10.0 node/v22' }, '/bin/agentuse')).toBe('pnpm');
    expect(detectPackageManager({}, '/Users/me/.bun/bin/agentuse')).toBe('bun');
    expect(detectPackageManager({}, '/usr/local/lib/node_modules/agentuse/bin/cli.js')).toBe('npm');
    expect(updateCommand('pnpm')).toBe('pnpm add -g agentuse@latest');
    expect(updateCommand('npm')).toBe('npm install -g agentuse@latest');
  });

  it('reads a newer version from the cache without consulting the registry', async () => {
    const cachePath = __testing.updateCachePath();
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ checkedAt: Date.now(), latestVersion: '0.18.0' }));

    expect(__testing.cachedUpdate('0.17.0')).toMatchObject({
      currentVersion: '0.17.0',
      latestVersion: '0.18.0',
    });
    expect(__testing.cachedUpdate('0.18.0')).toBeNull();
  });

  it('shows each release immediately and reminds only after seven days', () => {
    const shownAt = 10_000;
    const notice = { latestVersion: '0.18.0', shownAt };
    expect(__testing.shouldRemind('0.18.0', notice, shownAt + UPDATE_REMINDER_INTERVAL_MS - 1)).toBe(false);
    expect(__testing.shouldRemind('0.18.0', notice, shownAt + UPDATE_REMINDER_INTERVAL_MS)).toBe(true);
    expect(__testing.shouldRemind('0.19.0', notice, shownAt + 1)).toBe(true);
  });

  it('refreshes a long-lived daemon cache at the daily boundary', () => {
    const checkedAt = 10_000;
    expect(shouldRefreshUpdateCache(checkedAt, checkedAt + 24 * 60 * 60 * 1000 - 1)).toBe(false);
    expect(shouldRefreshUpdateCache(checkedAt, checkedAt + 24 * 60 * 60 * 1000)).toBe(true);
  });

  it('honors update opt-out loaded from the supported global env file', async () => {
    const cachePath = __testing.updateCachePath();
    const envPath = join(root, 'agentuse.env');
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ checkedAt: Date.now(), latestVersion: '0.18.0' }));
    await writeFile(envPath, 'AGENTUSE_UPDATE_CHECK_DISABLED=true\n');
    process.env.AGENTUSE_ENV = envPath;

    loadGlobalDefaults();
    expect(getCachedAvailableUpdate('0.17.0')).toBeNull();
  });

  it('honors update opt-out loaded from global config env', async () => {
    const cachePath = __testing.updateCachePath();
    const configPath = join(root, 'config.json');
    await mkdir(dirname(cachePath), { recursive: true });
    await writeFile(cachePath, JSON.stringify({ checkedAt: Date.now(), latestVersion: '0.18.0' }));
    await writeFile(configPath, JSON.stringify({ env: { AGENTUSE_UPDATE_CHECK_DISABLED: 'true' } }));
    process.env.AGENTUSE_CONFIG = configPath;

    loadGlobalDefaults();
    expect(getCachedAvailableUpdate('0.17.0')).toBeNull();
  });

  it('does not let malformed global config break an unrelated command', async () => {
    const configPath = join(root, 'invalid-config.json');
    await writeFile(configPath, 'not json');
    const child = Bun.spawn(
      [process.execPath, 'src/index.ts', 'sessions', 'list', '--json'],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          AGENTUSE_CONFIG: configPath,
          AGENTUSE_ENV: join(root, 'missing.env'),
        },
        stdout: 'pipe',
        stderr: 'pipe',
      },
    );
    const [exitCode, stderr] = await Promise.all([
      child.exited,
      new Response(child.stderr).text(),
    ]);

    expect(exitCode, stderr).toBe(0);
    expect(stderr).not.toContain('SyntaxError');
  });
});
