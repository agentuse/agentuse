import { describe, expect, it } from 'bun:test';
import { homedir } from 'os';
import { dirname } from 'path';
import { createSandbox } from '../src/sandbox';

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
