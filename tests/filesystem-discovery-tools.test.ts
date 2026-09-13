import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createListTool, createSearchTool } from '../src/tools/filesystem';
import type { FilesystemPathConfig } from '../src/tools/types';
import { injectIntentParam } from '../src/runner/tool-intent';
import { createCodeExecTool } from '../src/runner/code-mode';
import { ToolDispatcher } from '../src/runner/tool-dispatcher';

let root: string;
let outside: string;

beforeAll(async () => {
  root = await realpath(await mkdtemp(join(tmpdir(), 'filesystem-discovery-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'filesystem-outside-')));
  await mkdir(join(root, 'src'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Searchable project');
  await writeFile(join(root, 'guide.md'), 'First line\nBefore target\nImportant target rule\nAfter target\nLast line\n');
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
    expect(listed.files).toEqual(['README.md', 'guide.md', 'src/release.ts']);

    const found = JSON.parse((await search.execute({ directory_path: root, query: 'releaseReadiness' })).output);
    expect(found.matches).toEqual([{ path: 'src/release.ts', line: 1, text: 'export const releaseReadiness = true;' }]);
  });

  it('targets one exact file and returns bounded surrounding context', async () => {
    const { search } = tools();
    const file = join(root, 'guide.md');
    const found = JSON.parse((await search.execute({
      file_path: file,
      query: 'target rule',
      context_lines: 1,
    })).output);

    expect(found.file).toBe(file);
    expect(found.matches).toEqual([{
      path: 'guide.md',
      line: 3,
      text: 'Important target rule',
      excerpt: '2\tBefore target\n3\tImportant target rule\n4\tAfter target',
    }]);
    expect(found.truncated).toBe(false);
  });

  it('requires exactly one file or directory search target', async () => {
    const { search } = tools();
    const neither = JSON.parse((await search.execute({ query: 'target' })).output);
    expect(neither).toEqual({ success: false, error: 'Provide exactly one of directory_path or file_path' });

    const both = JSON.parse((await search.execute({
      directory_path: root,
      file_path: join(root, 'guide.md'),
      query: 'target',
    })).output);
    expect(both).toEqual({ success: false, error: 'Provide exactly one of directory_path or file_path' });
  });

  it('retains the standard intent label on the expanded search schema', async () => {
    const search = injectIntentParam('tools__filesystem_search', tools().search) as any;
    expect(Object.keys(search.inputSchema.shape)[0]).toBe('intent');
    const found = JSON.parse((await search.execute({
      intent: 'Finding the target rule',
      file_path: join(root, 'guide.md'),
      query: 'target rule',
      context_lines: 1,
    })).output);
    expect(found.matches).toHaveLength(1);
  });

  it('supports exact-file contextual search through Code Mode', async () => {
    const search = tools().search;
    const dispatcher = new ToolDispatcher({ tools__filesystem_search: search });
    const definitions = dispatcher.codeModeTools();
    dispatcher.register('code_exec', createCodeExecTool({
      dispatcher,
      toolNames: Object.keys(definitions),
      toolDefinitions: definitions,
    }));
    const code = `
      const result = await tools.tools__filesystem_search({
        file_path: ${JSON.stringify(join(root, 'guide.md'))},
        query: "target rule",
        context_lines: 1,
      });
      const parsed = JSON.parse((result as any).output);
      return parsed.matches[0];
    `;

    await expect(dispatcher.dispatch('code_exec', { code }, { toolCallId: 'contextual-search' }))
      .resolves.toEqual(expect.objectContaining({
        status: 'completed',
        value: expect.objectContaining({
          path: 'guide.md',
          line: 3,
          excerpt: '2\tBefore target\n3\tImportant target rule\n4\tAfter target',
        }),
      }));
  });

  it('rejects listing or searching outside the configured capability', async () => {
    const { list, search } = tools();
    expect(JSON.parse((await list.execute({ directory_path: outside })).output).success).toBe(false);
    expect(JSON.parse((await search.execute({ directory_path: outside, query: 'secret' })).output).success).toBe(false);
    expect(JSON.parse((await search.execute({ file_path: join(outside, 'secret.txt'), query: 'secret' })).output).success).toBe(false);
  });
});
