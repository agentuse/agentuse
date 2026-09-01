import { afterEach, describe, expect, it } from 'bun:test';
import os from 'os';
import path from 'path';
import { resolveAuthFilePath } from '../src/auth/storage';

describe('auth storage path', () => {
  const originalDataDir = process.env.AGENTUSE_DATA_DIR;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
    else process.env.AGENTUSE_DATA_DIR = originalDataDir;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
  });

  it('uses XDG_DATA_HOME when provided', () => {
    delete process.env.AGENTUSE_DATA_DIR;
    process.env.XDG_DATA_HOME = '/tmp/isolated-agentuse-data';

    expect(resolveAuthFilePath()).toBe('/tmp/isolated-agentuse-data/agentuse/auth.json');
  });

  it('prefers the exact AGENTUSE_DATA_DIR', () => {
    process.env.AGENTUSE_DATA_DIR = '/tmp/direct-agentuse-data';
    process.env.XDG_DATA_HOME = '/tmp/isolated-agentuse-data';

    expect(resolveAuthFilePath()).toBe('/tmp/direct-agentuse-data/auth.json');
  });

  it('preserves the existing default credential location', () => {
    delete process.env.AGENTUSE_DATA_DIR;
    delete process.env.XDG_DATA_HOME;

    expect(resolveAuthFilePath()).toBe(path.join(os.homedir(), '.local', 'share', 'agentuse', 'auth.json'));
  });
});
