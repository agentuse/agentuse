import { afterEach, describe, expect, it } from 'bun:test';
import { createHash } from 'node:crypto';
import { lstat, mkdir, mkdtemp, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { mountChangesetShadow } from '../src/agents/changeset-mount';
import { changesetShadowRoot } from '../src/agents/changeset-types';

const SESSION_ID = '01K4ABCDEFGHJKMNPQRSTVWXYZ';

const cleanups: Array<() => Promise<void>> = [];
const priorDataDir = process.env.AGENTUSE_DATA_DIR;

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
  if (priorDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = priorDataDir;
});

async function fixture(): Promise<{ projectRoot: string }> {
  const projectRoot = await mkdtemp(join(tmpdir(), 'changeset-mount-project-'));
  const dataRoot = await mkdtemp(join(tmpdir(), 'changeset-mount-data-'));
  cleanups.push(
    () => rm(projectRoot, { recursive: true, force: true }),
    () => rm(dataRoot, { recursive: true, force: true }),
  );
  process.env.AGENTUSE_DATA_DIR = dataRoot;

  await mkdir(join(projectRoot, 'agents'), { recursive: true });
  await mkdir(join(projectRoot, 'agents', 'workers'), { recursive: true });
  await mkdir(join(projectRoot, 'src'), { recursive: true });
  await mkdir(join(projectRoot, '.agentuse', 'store'), { recursive: true });
  await writeFile(join(projectRoot, 'agents', 'existing.agentuse'), 'existing agent\n', 'utf8');
  await writeFile(join(projectRoot, 'agents', 'sibling.agentuse'), 'sibling agent\n', 'utf8');
  await writeFile(join(projectRoot, 'agents', 'workers', 'worker.agentuse'), 'worker\n', 'utf8');
  await writeFile(join(projectRoot, 'src', 'index.ts'), 'export const x = 1;\n', 'utf8');
  await writeFile(join(projectRoot, '.agentuse', 'store', 'state.json'), '{}\n', 'utf8');
  await writeFile(join(projectRoot, '.gitignore'), 'node_modules\n', 'utf8');
  await writeFile(join(projectRoot, 'README.md'), '# project\n', 'utf8');
  return { projectRoot };
}

/** Hash every path in a tree with its type and content, without following links. */
async function hashTree(root: string): Promise<string> {
  const hash = createHash('sha256');
  const walk = async (dir: string): Promise<void> => {
    const entries = (await readdir(dir)).sort();
    for (const name of entries) {
      const full = join(dir, name);
      const stats = await lstat(full);
      const rel = relative(root, full);
      if (stats.isSymbolicLink()) {
        hash.update(`link:${rel}\n`);
      } else if (stats.isDirectory()) {
        hash.update(`dir:${rel}\n`);
        await walk(full);
      } else {
        hash.update(`file:${rel}:${await readFile(full, 'utf8')}\n`);
      }
    }
  };
  await walk(root);
  return hash.digest('hex');
}

async function mount(projectRoot: string, files: Array<{ path: string; content: string }>) {
  const result = await mountChangesetShadow({
    projectRoot,
    scopeRoot: projectRoot,
    sessionId: SESSION_ID,
    files,
  });
  cleanups.push(result.cleanup);
  return result;
}

describe('mountChangesetShadow', () => {
  it('links every top-level entry, including dotfiles', async () => {
    const { projectRoot } = await fixture();
    const { root } = await mount(projectRoot, []);

    expect(root).toBe(changesetShadowRoot(projectRoot, SESSION_ID));
    const entries = (await readdir(root)).sort();
    expect(entries).toEqual(['.agentuse', '.gitignore', 'README.md', 'agents', 'src']);
    for (const name of entries) {
      expect((await lstat(join(root, name))).isSymbolicLink()).toBe(true);
    }
    // State under .agentuse resolves through the link.
    expect(await readFile(join(root, '.agentuse', 'store', 'state.json'), 'utf8')).toBe('{}\n');
  });

  it('materializes only the ancestors a changeset needs and leaves siblings linked', async () => {
    const { projectRoot } = await fixture();
    const { root } = await mount(projectRoot, [
      { path: 'agents/workers/new.agentuse', content: 'new worker\n' },
    ]);

    expect((await lstat(join(root, 'agents'))).isDirectory()).toBe(true);
    expect((await lstat(join(root, 'agents'))).isSymbolicLink()).toBe(false);
    expect((await lstat(join(root, 'agents', 'workers'))).isSymbolicLink()).toBe(false);
    // Siblings at both materialized levels stay as links.
    expect((await lstat(join(root, 'agents', 'existing.agentuse'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, 'agents', 'workers', 'worker.agentuse'))).isSymbolicLink()).toBe(true);
    expect((await lstat(join(root, 'src'))).isSymbolicLink()).toBe(true);
    // The staged file is a regular file, not a link.
    const staged = await lstat(join(root, 'agents', 'workers', 'new.agentuse'));
    expect(staged.isSymbolicLink()).toBe(false);
    expect(staged.isFile()).toBe(true);
    expect(staged.mode & 0o777).toBe(0o644);
    expect(await readFile(join(root, 'agents', 'workers', 'new.agentuse'), 'utf8')).toBe('new worker\n');
    // Nothing landed in the project.
    await expect(readFile(join(projectRoot, 'agents', 'workers', 'new.agentuse'), 'utf8')).rejects.toThrow();
  });

  it('shadows a real file without changing it', async () => {
    const { projectRoot } = await fixture();
    const { root } = await mount(projectRoot, [
      { path: 'agents/existing.agentuse', content: 'revised agent\n' },
    ]);

    expect(await readFile(join(root, 'agents', 'existing.agentuse'), 'utf8')).toBe('revised agent\n');
    expect((await lstat(join(root, 'agents', 'existing.agentuse'))).isSymbolicLink()).toBe(false);
    expect(await readFile(join(projectRoot, 'agents', 'existing.agentuse'), 'utf8')).toBe('existing agent\n');
  });

  it('creates a directory chain that does not exist in the project', async () => {
    const { projectRoot } = await fixture();
    const { root } = await mount(projectRoot, [
      { path: 'tools/deep/nested/run.py', content: 'print(1)\n' },
    ]);

    expect(await readFile(join(root, 'tools', 'deep', 'nested', 'run.py'), 'utf8')).toBe('print(1)\n');
    await expect(lstat(join(projectRoot, 'tools'))).rejects.toThrow();
  });

  it('resolves the entry path and reads real siblings through the links', async () => {
    const { projectRoot } = await fixture();
    const { root, entryFor } = await mount(projectRoot, [
      { path: 'agents/new.agentuse', content: 'entry\n' },
      { path: 'scripts/x.py', content: 'print("x")\n' },
    ]);

    expect(entryFor('agents/new.agentuse')).toBe(join(root, 'agents', 'new.agentuse'));
    expect(entryFor('./agents/new.agentuse')).toBe(join(root, 'agents', 'new.agentuse'));
    expect(await readFile(entryFor('agents/new.agentuse'), 'utf8')).toBe('entry\n');
    expect(await readFile(join(root, 'agents', 'existing.agentuse'), 'utf8')).toBe('existing agent\n');
    expect(await readFile(join(root, 'scripts', 'x.py'), 'utf8')).toBe('print("x")\n');
    await expect(readFile(join(projectRoot, 'scripts', 'x.py'), 'utf8')).rejects.toThrow();
  });

  it('cleanup removes the shadow and leaves the project byte-identical', async () => {
    const { projectRoot } = await fixture();
    const before = await hashTree(projectRoot);

    const { root, cleanup } = await mount(projectRoot, [
      { path: 'agents/workers/new.agentuse', content: 'new worker\n' },
      { path: 'agents/existing.agentuse', content: 'revised\n' },
      { path: 'tools/deep/run.py', content: 'print(1)\n' },
    ]);
    // A real file inside a materialized directory must survive the rm.
    expect(await readFile(join(root, 'agents', 'workers', 'worker.agentuse'), 'utf8')).toBe('worker\n');

    await cleanup();

    await expect(lstat(root)).rejects.toThrow();
    expect(await hashTree(projectRoot)).toBe(before);
    expect(await readFile(join(projectRoot, 'agents', 'workers', 'worker.agentuse'), 'utf8')).toBe('worker\n');
    await cleanup();
  });

  it('refuses a path that escapes the project scope', async () => {
    const { projectRoot } = await fixture();
    await expect(mount(projectRoot, [{ path: '../outside.agentuse', content: 'x' }]))
      .rejects.toThrow(/escapes the project scope/u);
    await expect(mount(projectRoot, [{ path: join(projectRoot, 'abs.agentuse'), content: 'x' }]))
      .rejects.toThrow(/project-relative/u);
    await expect(lstat(changesetShadowRoot(projectRoot, SESSION_ID))).rejects.toThrow();
  });

  it('refuses to mount under a symlinked project directory', async () => {
    const { projectRoot } = await fixture();
    await mkdir(join(projectRoot, 'shared'), { recursive: true });
    await symlink(join(projectRoot, 'shared'), join(projectRoot, 'linked'));

    await expect(mount(projectRoot, [{ path: 'linked/new.agentuse', content: 'x' }]))
      .rejects.toThrow(/symlinked project directory/u);
  });

  it('refuses a changeset path that collides with a real directory', async () => {
    const { projectRoot } = await fixture();
    await expect(mount(projectRoot, [{ path: 'agents', content: 'x' }]))
      .rejects.toThrow(/collides with a project directory/u);
    await expect(mount(projectRoot, [{ path: 'README.md/child.txt', content: 'x' }]))
      .rejects.toThrow(/collides with a project file/u);
  });
});
