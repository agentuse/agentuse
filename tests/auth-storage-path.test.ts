import { afterEach, describe, expect, it } from 'bun:test';
import os from 'os';
import path from 'path';
import { resolveAuthFilePath } from '../src/auth/storage';

describe('auth storage path', () => {
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  afterEach(() => {
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
  });

  it('uses XDG_DATA_HOME when provided', () => {
    process.env.XDG_DATA_HOME = '/tmp/isolated-agentuse-data';

    expect(resolveAuthFilePath()).toBe('/tmp/isolated-agentuse-data/agentuse/auth.json');
  });

  it('preserves the existing default credential location', () => {
    delete process.env.XDG_DATA_HOME;

    expect(resolveAuthFilePath()).toBe(path.join(os.homedir(), '.local', 'share', 'agentuse', 'auth.json'));
  });
});
