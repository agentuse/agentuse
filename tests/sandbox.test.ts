import { describe, expect, it } from 'bun:test';
import { homedir } from 'os';
import { dirname } from 'path';
import { PassThrough } from 'stream';
import { createSandbox, createSandboxTools } from '../src/sandbox';

describe('createSandbox $HOME guard', () => {
  it('refuses to mount $HOME as projectRoot', async () => {
    await expect(
      createSandbox({
        config: { provider: 'docker' },
        projectRoot: homedir(),
      })
    ).rejects.toThrow(/\$HOME or an ancestor/);
  });

  it('refuses to mount an ancestor of $HOME as projectRoot', async () => {
    await expect(
      createSandbox({
        config: { provider: 'docker' },
        projectRoot: dirname(homedir()),
      })
    ).rejects.toThrow(/\$HOME or an ancestor/);
  });
});

describe('sandbox__exec timeout', () => {
  it('returns a timeout result and removes the container when docker exec never finishes', async () => {
    let stopped = 0;
    let removed = 0;
    const stream = new PassThrough();
    const container = {
      id: 'fake-container',
      modem: {
        demuxStream: () => {},
      },
      exec: async () => ({
        start: async () => stream,
        inspect: async () => ({ ExitCode: 0 }),
      }),
      stop: async () => {
        stopped++;
      },
      remove: async () => {
        removed++;
      },
    };

    const tools = createSandboxTools(container as any, '/project', 300);
    const result = await (tools.sandbox__exec.execute as any)({
      command: 'sleep infinity',
      timeout: 0.01,
    });

    expect(result.exitCode).toBe(124);
    expect(result.stderr).toContain('Command timed out');
    expect(stopped).toBe(1);
    expect(removed).toBe(1);
  });
});
