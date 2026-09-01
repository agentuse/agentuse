import { afterEach, describe, expect, it } from 'bun:test';
import { homedir } from 'os';
import { join, resolve } from 'path';
import { getAgentuseDataDir } from '../src/utils/data-dir';

describe('getAgentuseDataDir', () => {
  const originalDataDir = process.env.AGENTUSE_DATA_DIR;
  const originalXdgDataHome = process.env.XDG_DATA_HOME;

  afterEach(() => {
    if (originalDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
    else process.env.AGENTUSE_DATA_DIR = originalDataDir;
    if (originalXdgDataHome === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdgDataHome;
  });

  it('defaults to ~/.local/share/agentuse', () => {
    delete process.env.AGENTUSE_DATA_DIR;
    delete process.env.XDG_DATA_HOME;

    expect(getAgentuseDataDir()).toBe(join(process.env.HOME || homedir(), '.local', 'share', 'agentuse'));
  });

  it('uses the exact AGENTUSE_DATA_DIR without appending agentuse', () => {
    process.env.AGENTUSE_DATA_DIR = '/tmp/agentuse-profile-data';
    process.env.XDG_DATA_HOME = '/tmp/xdg-data';

    expect(getAgentuseDataDir()).toBe('/tmp/agentuse-profile-data');
  });

  it('resolves a relative AGENTUSE_DATA_DIR to an absolute path', () => {
    process.env.AGENTUSE_DATA_DIR = './agentuse-profile-data';

    expect(getAgentuseDataDir()).toBe(resolve('./agentuse-profile-data'));
  });

  it('falls back to the AgentUse child of XDG_DATA_HOME', () => {
    delete process.env.AGENTUSE_DATA_DIR;
    process.env.XDG_DATA_HOME = '/tmp/xdg-data';

    expect(getAgentuseDataDir()).toBe('/tmp/xdg-data/agentuse');
  });
});
