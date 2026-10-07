import { expect, it } from 'bun:test';
import { copyFile, mkdir, mkdtemp, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
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

it('resolves esbuild from the running bundle, not the source path baked in at build time', async () => {
  // Bundle a copy of the loader, then delete the copy: the bundle must still
  // find esbuild beside itself, as it must on any machine but the build host.
  const root = await mkdtemp(join(tmpdir(), 'agentuse-esbuild-bundle-'));
  try {
    const sourceDir = join(root, 'build-host-src');
    const outdir = join(root, 'install');
    await mkdir(sourceDir);
    await copyFile(join(import.meta.dir, '../src/utils/esbuild.ts'), join(sourceDir, 'esbuild.ts'));
    const result = await Bun.build({
      entrypoints: [join(sourceDir, 'esbuild.ts')],
      outdir,
      target: 'node',
      format: 'esm',
      packages: 'external',
    });
    expect(result.success).toBe(true);
    await rm(sourceDir, { recursive: true });
    await mkdir(join(outdir, 'node_modules'));
    await symlink(dirname(require.resolve('esbuild/package.json')), join(outdir, 'node_modules', 'esbuild'));

    const bundled = await import(pathToFileURL(result.outputs[0]!.path).href) as typeof import('../src/utils/esbuild');
    const esbuild = await bundled.loadEsbuild();
    expect(typeof esbuild.transform).toBe('function');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
