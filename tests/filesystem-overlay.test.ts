import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createOverlayFilesystemTools } from '../src/tools/filesystem-overlay';
import { redactProjectDiscoveryText } from '../src/agents/discover';

interface ExecutableTool {
  description: string;
  execute: (args: Record<string, unknown>, options?: { abortSignal?: AbortSignal }) => Promise<{ output: string }>;
}

let scopeRoot: string;
let stateRoot: string;
let editRoot: string;
let basePath: string;
let outside: string;

function overlay(): Record<string, ExecutableTool> {
  return createOverlayFilesystemTools({
    scopeRoot,
    editRoot,
    basePath,
    redact: redactProjectDiscoveryText,
    context: { projectRoot: scopeRoot },
  }) as unknown as Record<string, ExecutableTool>;
}

async function run(name: string, args: Record<string, unknown>): Promise<Record<string, unknown> | string> {
  const result = await overlay()[name]!.execute(args);
  try {
    return JSON.parse(result.output) as Record<string, unknown>;
  } catch {
    return result.output;
  }
}

beforeEach(async () => {
  scopeRoot = await realpath(await mkdtemp(join(tmpdir(), 'overlay-scope-')));
  stateRoot = await realpath(await mkdtemp(join(tmpdir(), 'overlay-state-')));
  outside = await realpath(await mkdtemp(join(tmpdir(), 'overlay-outside-')));
  editRoot = join(stateRoot, 'edit');
  basePath = join(stateRoot, 'base.json');
  await mkdir(editRoot, { recursive: true });
  await mkdir(join(scopeRoot, 'agents'), { recursive: true });
  await mkdir(join(scopeRoot, 'node_modules'), { recursive: true });
  await writeFile(join(scopeRoot, 'README.md'), '# Project\nsentinel-real\n');
  await writeFile(join(scopeRoot, 'agents', 'daily.agentuse'), 'model: anthropic:claude\n');
  await writeFile(join(scopeRoot, '.env'), 'API_KEY=abcdef123456\n');
  await writeFile(join(scopeRoot, 'node_modules', 'x.js'), 'module.exports = 1;\n');
  await writeFile(join(scopeRoot, 'config.ts'), 'export const OPENAI_API_KEY = "sk-abcdefghijklmnopqrstuvwx";\n');
  await writeFile(join(outside, 'secret.txt'), 'outside-secret\n');
});

afterEach(async () => {
  await Promise.all([
    rm(scopeRoot, { recursive: true, force: true }),
    rm(stateRoot, { recursive: true, force: true }),
    rm(outside, { recursive: true, force: true }),
  ]);
});

describe('overlay filesystem tools', () => {
  it('exposes the same tool names as the plain filesystem tools', () => {
    expect(Object.keys(overlay()).sort()).toEqual([
      'tools__filesystem_edit',
      'tools__filesystem_list',
      'tools__filesystem_read',
      'tools__filesystem_search',
      'tools__filesystem_write',
    ]);
  });

  it('never names the edit folder in a tool description', () => {
    for (const tool of Object.values(overlay())) {
      expect(tool.description).not.toContain(editRoot);
      expect(tool.description.toLowerCase()).not.toContain('changeset');
      expect(tool.description).toContain(scopeRoot);
    }
  });

  it('reads through to the real project and redacts secrets', async () => {
    const plain = await run('tools__filesystem_read', { file_path: join(scopeRoot, 'README.md') });
    expect(String(plain)).toContain('sentinel-real');

    const redacted = await run('tools__filesystem_read', { file_path: join(scopeRoot, 'config.ts') });
    expect(String(redacted)).toContain('[REDACTED');
    expect(String(redacted)).not.toContain('sk-abcdefghijklmnopqrstuvwx');
  });

  it('serves the staged copy after a write and leaves the real file untouched', async () => {
    const target = join(scopeRoot, 'README.md');
    const before = await stat(target);
    const originalBytes = await readFile(target);

    const written = await run('tools__filesystem_write', { file_path: target, content: '# Staged\n' });
    expect((written as Record<string, unknown>).success).toBe(true);
    expect((written as Record<string, unknown>).path).toBe(target);
    expect((written as Record<string, unknown>).created).toBe(false);

    const read = await run('tools__filesystem_read', { file_path: target });
    expect(String(read)).toContain('# Staged');
    expect(String(read)).not.toContain('sentinel-real');

    expect(await readFile(join(editRoot, 'README.md'), 'utf8')).toBe('# Staged\n');
    const after = await stat(target);
    expect(await readFile(target)).toEqual(originalBytes);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it('edits a real file into the edit folder and never opens the real file for writing', async () => {
    const target = join(scopeRoot, 'agents', 'daily.agentuse');
    const before = await stat(target);
    const originalBytes = await readFile(target);

    const edited = await run('tools__filesystem_edit', {
      file_path: target,
      old_string: 'anthropic:claude',
      new_string: 'anthropic:claude-opus-5',
    });
    expect((edited as Record<string, unknown>).success).toBe(true);
    expect((edited as Record<string, unknown>).path).toBe(target);

    expect(await readFile(join(editRoot, 'agents', 'daily.agentuse'), 'utf8')).toContain('claude-opus-5');
    expect(await readFile(target)).toEqual(originalBytes);
    expect((await stat(target)).mtimeMs).toBe(before.mtimeMs);
  });

  it('records the base hash on the first write only', async () => {
    const target = join(scopeRoot, 'README.md');
    await run('tools__filesystem_write', { file_path: target, content: 'first\n' });
    const first = JSON.parse(await readFile(basePath, 'utf8')) as Record<string, string>;
    expect(Object.keys(first)).toEqual(['README.md']);
    expect(first['README.md']).toMatch(/^[0-9a-f]{64}$/);

    await run('tools__filesystem_write', { file_path: target, content: 'second\n' });
    const second = JSON.parse(await readFile(basePath, 'utf8')) as Record<string, string>;
    expect(second).toEqual(first);
  });

  it('records no base hash for a brand new file', async () => {
    const created = await run('tools__filesystem_write', {
      file_path: join(scopeRoot, 'agents', 'new.agentuse'),
      content: 'model: anthropic:claude\n',
    });
    expect((created as Record<string, unknown>).created).toBe(true);
    await expect(readFile(basePath, 'utf8')).rejects.toThrow();
  });

  it('refuses denied paths', async () => {
    for (const denied of ['.env', 'node_modules/x.js', '.agentuse/state.json']) {
      const result = await run('tools__filesystem_write', {
        file_path: join(scopeRoot, denied),
        content: 'nope\n',
      }) as Record<string, unknown>;
      expect(result.success).toBe(false);
      expect(String(result.error)).not.toContain(editRoot);
    }
    const read = await run('tools__filesystem_read', { file_path: join(scopeRoot, '.env') }) as Record<string, unknown>;
    expect(read.success).toBe(false);
  });

  it('refuses to write a file the redactor changed', async () => {
    const target = join(scopeRoot, 'config.ts');
    const result = await run('tools__filesystem_write', { file_path: target, content: 'nope\n' }) as Record<string, unknown>;
    expect(result.success).toBe(false);
    expect(String(result.error)).toContain('contains secrets, read-only');

    const edited = await run('tools__filesystem_edit', {
      file_path: target,
      old_string: 'export',
      new_string: 'const',
    }) as Record<string, unknown>;
    expect(edited.success).toBe(false);
    expect(String(edited.error)).toContain('contains secrets, read-only');
  });

  it('refuses NUL content and oversized files', async () => {
    const nul = await run('tools__filesystem_write', {
      file_path: join(scopeRoot, 'bin.txt'),
      content: 'a\u0000b',
    }) as Record<string, unknown>;
    expect(nul.success).toBe(false);
    expect(String(nul.error)).toContain('text files only');

    const big = await run('tools__filesystem_write', {
      file_path: join(scopeRoot, 'big.txt'),
      content: 'x'.repeat(70_000),
    }) as Record<string, unknown>;
    expect(big.success).toBe(false);
    expect(String(big.error)).toContain('per-file limit');
  });

  it('lists the union of the project and staged files, hiding denied paths', async () => {
    await run('tools__filesystem_write', {
      file_path: join(scopeRoot, 'agents', 'new.agentuse'),
      content: 'model: anthropic:claude\n',
    });
    const listed = await run('tools__filesystem_list', { directory_path: scopeRoot }) as Record<string, unknown>;
    const files = listed.files as string[];
    expect(files).toContain('agents/new.agentuse');
    expect(files).toContain('agents/daily.agentuse');
    expect(files).toContain('README.md');
    expect(files).not.toContain('.env');
    expect(files.some((file) => file.startsWith('node_modules/'))).toBe(false);
  });

  it('searches the staged copy instead of the real content', async () => {
    await run('tools__filesystem_write', { file_path: join(scopeRoot, 'README.md'), content: 'sentinel-staged\n' });

    const staged = await run('tools__filesystem_search', { directory_path: scopeRoot, query: 'sentinel-staged' }) as Record<string, unknown>;
    expect((staged.matches as Array<{ path: string }>).map((match) => match.path)).toEqual(['README.md']);

    const real = await run('tools__filesystem_search', { directory_path: scopeRoot, query: 'sentinel-real' }) as Record<string, unknown>;
    expect(real.matches).toEqual([]);
  });

  it('search results come from the redacted view', async () => {
    const found = await run('tools__filesystem_search', { directory_path: scopeRoot, query: 'sk-abcdefghijklmnopqrstuvwx' }) as Record<string, unknown>;
    expect(found.matches).toEqual([]);
  });

  it('refuses a symlink that escapes the scope', async () => {
    await symlink(outside, join(scopeRoot, 'link'));
    const read = await run('tools__filesystem_read', { file_path: join(scopeRoot, 'link', 'secret.txt') }) as Record<string, unknown>;
    expect(read.success).toBe(false);
    expect(String(read.error)).toContain('outside the project');

    const write = await run('tools__filesystem_write', {
      file_path: join(scopeRoot, 'link', 'planted.txt'),
      content: 'nope\n',
    }) as Record<string, unknown>;
    expect(write.success).toBe(false);
    await expect(stat(join(outside, 'planted.txt'))).rejects.toThrow();
  });

  it('refuses absolute paths outside the scope and traversal', async () => {
    const absolute = await run('tools__filesystem_read', { file_path: join(outside, 'secret.txt') }) as Record<string, unknown>;
    expect(absolute.success).toBe(false);

    const traversal = await run('tools__filesystem_read', { file_path: join(scopeRoot, '..', 'etc', 'passwd') }) as Record<string, unknown>;
    expect(traversal.success).toBe(false);
  });

  it('leaves no staged copy behind when an edit fails to match', async () => {
    const target = join(scopeRoot, 'agents', 'daily.agentuse');
    const failed = await run('tools__filesystem_edit', {
      file_path: target,
      old_string: 'this string is not in the file',
      new_string: 'x',
    }) as Record<string, unknown>;
    expect(failed.success).toBe(false);
    await expect(stat(join(editRoot, 'agents', 'daily.agentuse'))).rejects.toThrow();
  });
});
