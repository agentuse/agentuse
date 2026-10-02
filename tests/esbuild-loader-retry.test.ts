import { expect, it, mock } from 'bun:test';
import * as realFs from 'node:fs/promises';

// One transient failure (for example while an update swaps the app bundle)
// must not keep esbuild unavailable for the life of the daemon.
const realAccess = realFs.access;
let failNext = true;
mock.module('node:fs/promises', () => ({
  ...realFs,
  access: async (...args: Parameters<typeof realAccess>) => {
    if (failNext) {
      failNext = false;
      throw Object.assign(new Error('EBUSY: bundle is being replaced'), { code: 'EBUSY' });
    }
    return realAccess(...args);
  },
}));

it('retries after a failed esbuild load', async () => {
  const { loadEsbuild } = await import('../src/utils/esbuild');

  await expect(loadEsbuild()).rejects.toThrow('The packaged esbuild module is missing');

  const esbuild = await loadEsbuild();
  const output = await esbuild.transform('const answer: number = 42;', { loader: 'ts', format: 'esm' });
  expect(output.code).toContain('const answer = 42;');
});
