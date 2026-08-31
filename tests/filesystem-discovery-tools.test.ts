import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createListTool, createSearchTool } from '../src/tools/filesystem';
import type { FilesystemPathConfig } from '../src/tools/types';

let root: string;
let outside: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'filesystem-discovery-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'filesystem-outside-')));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Searchable project');
  await writeFile(join(root, 'src', 'release.ts'), 'export const releaseReadiness = true;\n');
  await writeFile(join(outside, 'secret.txt'), 'releaseReadiness secret');
});

afterAll(async () => {
  await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
});

function tools() {
  const config: FilesystemPathConfig[] = [{ path: root, permissions: ['read'] }];
  const context = { projectRoot: root };
  return {
    list: createListTool(config, context) as any,
    search: createSearchTool(config, context) as any,
  };
}

describe('bounded filesystem discovery tools', () => {
  it('lists and searches only inside the authorized read root', async () => {
    const { list, search } = tools();
    const listed = JSON.parse((await list.execute({ directory_path: root })).output);
    expect(listed.files).toEqual(['README.md', 'src/release.ts']);

    const found = JSON.parse((await search.execute({ directory_path: root, query: 'releaseReadiness' })).output);
    expect(found.matches).toEqual([{ path: 'src/release.ts', line: 1, text: 'export const releaseReadiness = true;' }]);
  });

  it('rejects listing or searching outside the configured capability', async () => {
    const { list, search } = tools();
    expect(JSON.parse((await list.execute({ directory_path: outside })).output).success).toBe(false);
    expect(JSON.parse((await search.execute({ directory_path: outside, query: 'secret' })).output).success).toBe(false);
  });
});
