import { expect, it } from 'bun:test';
import { loadEsbuild } from '../src/utils/esbuild';

it('loads one working esbuild module', async () => {
  const [first, second] = await Promise.all([loadEsbuild(), loadEsbuild()]);
  expect(second).toBe(first);

  const output = await first.transform('const answer: number = 42;', {
    loader: 'ts',
    format: 'esm',
  });
  expect(output.code).toContain('const answer = 42;');
});
