import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdtemp, realpath, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSessionsCommand } from '../src/cli/sessions';

describe('agentuse sessions list --json', () => {
  let root: string;
  let originalCwd: string;
  const originalEnv = { HOME: process.env.HOME, XDG_DATA_HOME: process.env.XDG_DATA_HOME };

  beforeEach(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'sessions-list-json-')));
    originalCwd = process.cwd();
    process.env.HOME = root;
    process.env.XDG_DATA_HOME = join(root, 'data');
    process.chdir(root);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    await rm(root, { recursive: true, force: true });
  });

  async function runList(args: string[]): Promise<string> {
    let output = '';
    const writeSpy = spyOn(process.stdout, 'write').mockImplementation(((chunk: string | Uint8Array) => {
      output += String(chunk);
      return true;
    }) as typeof process.stdout.write);
    try {
      await createSessionsCommand().parseAsync(['list', ...args], { from: 'user' });
    } finally {
      writeSpy.mockRestore();
    }
    return output;
  }

  it('prints an empty JSON array for a project with no sessions', async () => {
    expect(JSON.parse(await runList(['--json', '--project', root]))).toEqual([]);
  });

  it('prints an empty JSON array across all projects when there are none', async () => {
    expect(JSON.parse(await runList(['--json', '--all']))).toEqual([]);
  });
});
