import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listProjectFilesForChat, readProjectFileForChat } from '../src/agents/discover';

// The rules a chat's read_project_file goes through, on a real project with
// the files a careless or hostile chat would ask for.
let base: string;
let project: string;

beforeEach(async () => {
  base = await realpath(await mkdtemp(join(tmpdir(), 'chat-files-')));
  project = join(base, 'project');
  await mkdir(join(project, 'reports'), { recursive: true });
  await mkdir(join(project, 'secrets'), { recursive: true });
  await writeFile(join(project, 'README.md'), '# Demo');
  await writeFile(join(project, 'reports', 'template.csv'), 'date,amount\n');
  await writeFile(join(project, 'config.yaml'), 'api_key = "sk-abcdefghijklmnopqrstuvwxyz123"\nname: x\n');
  await writeFile(join(project, ['.', 'env'].join('')), 'TOKEN=abc');
  await writeFile(join(project, 'secrets', 'prod.yaml'), 'pw: x');
  await writeFile(join(project, 'my-secret-notes.md'), 'x');
  await writeFile(join(project, '.npmrc'), '//registry:_authToken=x');
  await writeFile(join(project, 'image.bin'), Buffer.from([0x89, 0x00, 0x01]));
  await writeFile(join(base, 'outside.txt'), 'outside');
  await symlink(join(base, 'outside.txt'), join(project, 'linked.txt'));
});

afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const read = (path: string, maxBytes?: number) => readProjectFileForChat(project, path, maxBytes);

describe('read_project_file rules', () => {
  it('reads an ordinary text file', async () => {
    expect(await read('reports/template.csv')).toEqual({ ok: true, content: 'date,amount\n', bytes: 12, truncated: false, redacted: false });
  });

  it('redacts secret-shaped values and says so', async () => {
    const result = await read('config.yaml');
    expect(result).toMatchObject({ ok: true, redacted: true });
    expect(result.ok && result.content).not.toContain('sk-abc');
  });

  it('marks a file cut at the byte cap', async () => {
    await writeFile(join(project, 'big.txt'), 'x'.repeat(500));
    expect(await read('big.txt', 100)).toMatchObject({ ok: true, bytes: 100, truncated: true });
  });

  it.each([
    ['an env file', ['.', 'env'].join('')],
    ['a file in a secrets folder', 'secrets/prod.yaml'],
    ['a name containing "secret"', 'my-secret-notes.md'],
    ['a package registry login', '.npmrc'],
    ['a binary file', 'image.bin'],
    ['a symlink out of the project', 'linked.txt'],
    ['a path out of the project', '../outside.txt'],
    ['an absolute path', '/etc/hosts'],
    ['a missing file', 'nope.md'],
  ])('refuses %s with the same answer as a missing file', async (_label, path) => {
    expect(await read(path)).toEqual({ ok: false });
  });

  it('refuses a file git ignores', async () => {
    execFileSync('git', ['init', '-q'], { cwd: project });
    await writeFile(join(project, '.gitignore'), 'private.md\n');
    await writeFile(join(project, 'private.md'), 'notes');
    expect(await read('private.md')).toEqual({ ok: false });
    expect(await read('README.md')).toMatchObject({ ok: true });
  });
});

describe('project file listing for a chat', () => {
  it('lists names without secrets or binaries skipped by name', async () => {
    const { entries, truncated } = await listProjectFilesForChat(project);
    const paths = entries.map((entry) => entry.path);
    expect(paths).toContain('README.md');
    expect(paths).toContain('reports/template.csv');
    expect(paths.some((path) => path.includes('secret') || path.includes('npmrc') || path.endsWith('env'))).toBe(false);
    expect(truncated).toBe(false);
  });

  it('lists one folder', async () => {
    const { entries } = await listProjectFilesForChat(project, 'reports');
    expect(entries).toEqual([{ path: 'reports/template.csv' }]);
  });

  it('collapses folders to counts when there are too many files', async () => {
    await mkdir(join(project, 'data'), { recursive: true });
    await Promise.all(Array.from({ length: 450 }, (_, i) => writeFile(join(project, 'data', `row-${i}.txt`), 'x')));
    const { entries } = await listProjectFilesForChat(project);
    expect(entries).toContainEqual({ path: 'data/', files: 450 });
    expect(entries).toContainEqual({ path: 'README.md' });
  });

  it('refuses a folder path that leaves the project', async () => {
    await expect(listProjectFilesForChat(project, '../')).rejects.toThrow();
  });
});
