import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { dirname, join } from 'path';
import {
  UPDATE_REMINDER_INTERVAL_MS,
  __testing,
  detectPackageManager,
  isNewerVersion,
  updateCommand,
} from '../src/update-check';

describe('update check', () => {
  let root: string;
  let originalXdgDataHome: string | undefined;

  beforeEach(async () => {
    originalXdgDataHome = process.env.XDG_DATA_HOME;
    root = await mkdtemp(join(tmpdir(), 'agentuse-update-'));
    process.env.XDG_DATA_HOME = root;
  });

  afterEach(async () => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
    await rm(root, { recursive: true, force: true });
  });

  it('compares stable and prerelease semantic versions', () => {
    expect(isNewerVersion('0.18.0', '0.17.0')).toBe(true);
    expect(isNewerVersion('0.18.0', '0.18.0-beta.2')).toBe(true);
    expect(isNewerVersion('0.18.0-beta.1', '0.18.0')).toBe(false);
    expect(isNewerVersion('0.16.9', '0.17.0')).toBe(false);
    expect(isNewerVersion('latest', '0.17.0')).toBe(false);
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
});
