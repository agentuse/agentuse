import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile, rm, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hasExecutable } from '../src/plugin/executable-discovery';

let directory: string | undefined;
afterEach(async () => { if (directory) await rm(directory, { recursive: true, force: true }); });

describe('host CLI detection', () => {
  it('finds an executable without running it', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agentuse-cli-detection-'));
    const marker = join(directory, 'executed');
    await writeFile(join(directory, 'pi'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 });
    expect(await hasExecutable('pi', { PATH: directory })).toBe(true);
    await expect(access(marker)).rejects.toThrow();
  });

  it('rejects absent, non-executable, and directory candidates', async () => {
    directory = await mkdtemp(join(tmpdir(), 'agentuse-cli-detection-'));
    expect(await hasExecutable('pi', { PATH: directory })).toBe(false);
    await writeFile(join(directory, 'pi'), 'not executable', { mode: 0o644 });
    expect(await hasExecutable('pi', { PATH: directory })).toBe(false);
    await rm(join(directory, 'pi'));
    await mkdir(join(directory, 'pi'));
    expect(await hasExecutable('pi', { PATH: directory })).toBe(false);
    expect(await hasExecutable('pi', { PATH: '' })).toBe(false);
  });
});
