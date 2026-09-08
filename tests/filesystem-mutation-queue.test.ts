import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createEditTool, createWriteTool } from '../src/tools/filesystem.js';
import { withFileMutationQueue } from '../src/tools/file-mutation-queue.js';
import type { FilesystemPathConfig } from '../src/tools/types.js';

const temporaryRoots: string[] = [];

async function temporaryRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'agentuse-mutations-')));
  temporaryRoots.push(root);
  return root;
}

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('file mutation queue', () => {
  it('runs mutations to one path in registration order', async () => {
    const events: string[] = [];
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    const first = withFileMutationQueue('/tmp/same-file', async () => {
      events.push('first:start');
      await firstCanFinish;
      events.push('first:end');
    });
    const second = withFileMutationQueue('/tmp/same-file', async () => {
      events.push('second:start');
      events.push('second:end');
    });

    await Promise.resolve();
    expect(events).toEqual(['first:start']);
    releaseFirst();
    await Promise.all([first, second]);
    expect(events).toEqual(['first:start', 'first:end', 'second:start', 'second:end']);
  });

  it('does not block mutations to different paths', async () => {
    let releaseFirst!: () => void;
    const firstCanFinish = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let secondStarted = false;

    const first = withFileMutationQueue('/tmp/file-a', async () => {
      await firstCanFinish;
    });
    const second = withFileMutationQueue('/tmp/file-b', async () => {
      secondStarted = true;
    });

    await Promise.resolve();
    expect(secondStarted).toBe(true);
    releaseFirst();
    await Promise.all([first, second]);
  });

  it('releases the next mutation when an earlier one fails', async () => {
    const failure = withFileMutationQueue('/tmp/failing-file', async () => {
      throw new Error('expected failure');
    });
    const next = withFileMutationQueue('/tmp/failing-file', async () => 'completed');

    await expect(failure).rejects.toThrow('expected failure');
    await expect(next).resolves.toBe('completed');
  });
});

describe('filesystem mutation tools', () => {
  it('preserves concurrent edits to different spans of one file', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'article.md');
    await writeFile(target, 'alpha: old\nbody\nomega: old\n');

    const config: FilesystemPathConfig[] = [{ path: root, permissions: ['edit'] }];
    const edit = createEditTool(config, { projectRoot: root }) as any;
    const [first, second] = await Promise.all([
      edit.execute({ file_path: target, old_string: 'alpha: old', new_string: 'alpha: new' }),
      edit.execute({ file_path: target, old_string: 'omega: old', new_string: 'omega: new' }),
    ]);

    expect(JSON.parse(first.output).success).toBe(true);
    expect(JSON.parse(second.output).success).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('alpha: new\nbody\nomega: new\n');
  });

  it('serializes edits made through a symlink and its real path', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'target.md');
    const alias = join(root, 'alias.md');
    await writeFile(target, 'first: old\nsecond: old\n');
    await symlink(target, alias);

    const config: FilesystemPathConfig[] = [{ path: root, permissions: ['edit'] }];
    const edit = createEditTool(config, { projectRoot: root }) as any;
    await Promise.all([
      edit.execute({ file_path: target, old_string: 'first: old', new_string: 'first: new' }),
      edit.execute({ file_path: alias, old_string: 'second: old', new_string: 'second: new' }),
    ]);

    expect(await readFile(target, 'utf8')).toBe('first: new\nsecond: new\n');
  });

  it('orders whole-file writes and edits through the same queue', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'ordered.txt');
    await writeFile(target, 'before\n');

    const config: FilesystemPathConfig[] = [{ path: root, permissions: ['write', 'edit'] }];
    const write = createWriteTool(config, { projectRoot: root }) as any;
    const edit = createEditTool(config, { projectRoot: root }) as any;
    const writeResult = write.execute({ file_path: target, content: 'after write\n' });
    const editResult = edit.execute({ file_path: target, old_string: 'after write', new_string: 'after edit' });

    const [written, edited] = await Promise.all([writeResult, editResult]);
    expect(JSON.parse(written.output).success).toBe(true);
    expect(JSON.parse(edited.output).success).toBe(true);
    expect(await readFile(target, 'utf8')).toBe('after edit\n');
  });

  it('matches batch edits against one snapshot and applies changing lengths safely', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'batch.txt');
    await writeFile(target, 'one\nmiddle\nthree\n');
    const config: FilesystemPathConfig[] = [{ path: root, permissions: ['edit'] }];
    const edit = createEditTool(config, { projectRoot: root }) as any;

    const result = await edit.execute({
      file_path: target,
      edits: [
        { old_string: 'one', new_string: 'a much longer first line' },
        { old_string: 'three', new_string: '3' },
      ],
    });

    expect(JSON.parse(result.output)).toMatchObject({
      success: true,
      editsApplied: 2,
      replacements: 2,
    });
    expect(await readFile(target, 'utf8')).toBe('a much longer first line\nmiddle\n3\n');
  });

  it('rejects dependent batch edits and leaves the file unchanged', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'dependent.txt');
    await writeFile(target, 'original\n');
    const config: FilesystemPathConfig[] = [{ path: root, permissions: ['edit'] }];
    const edit = createEditTool(config, { projectRoot: root }) as any;

    const result = await edit.execute({
      file_path: target,
      edits: [
        { old_string: 'original', new_string: 'intermediate' },
        { old_string: 'intermediate', new_string: 'final' },
      ],
    });

    expect(JSON.parse(result.output)).toMatchObject({ success: false });
    expect(await readFile(target, 'utf8')).toBe('original\n');
  });

  it('rejects overlapping batch edits and leaves the file unchanged', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'overlap.txt');
    await writeFile(target, 'alpha beta gamma\n');
    const config: FilesystemPathConfig[] = [{ path: root, permissions: ['edit'] }];
    const edit = createEditTool(config, { projectRoot: root }) as any;

    const result = await edit.execute({
      file_path: target,
      edits: [
        { old_string: 'alpha beta', new_string: 'first' },
        { old_string: 'beta gamma', new_string: 'second' },
      ],
    });

    const output = JSON.parse(result.output);
    expect(output.success).toBe(false);
    expect(output.error).toContain('overlap');
    expect(await readFile(target, 'utf8')).toBe('alpha beta gamma\n');
  });

  it('keeps an aborted queued edit ordered and leaves the file unchanged', async () => {
    const root = await temporaryRoot();
    const target = join(root, 'aborted.txt');
    await writeFile(target, 'unchanged\n');
    const config: FilesystemPathConfig[] = [{ path: root, permissions: ['edit'] }];
    const edit = createEditTool(config, { projectRoot: root }) as any;

    let releaseBlocker!: () => void;
    const blockerCanFinish = new Promise<void>((resolve) => {
      releaseBlocker = resolve;
    });
    let blockerStarted!: () => void;
    const blockerDidStart = new Promise<void>((resolve) => {
      blockerStarted = resolve;
    });
    const blocker = withFileMutationQueue(target, async () => {
      blockerStarted();
      await blockerCanFinish;
    });
    await blockerDidStart;

    const controller = new AbortController();
    const pendingEdit = edit.execute(
      { file_path: target, old_string: 'unchanged', new_string: 'changed' },
      { abortSignal: controller.signal },
    );
    controller.abort();
    releaseBlocker();

    const result = await pendingEdit;
    await blocker;
    expect(JSON.parse(result.output)).toMatchObject({ success: false, error: 'Operation aborted' });
    expect(await readFile(target, 'utf8')).toBe('unchanged\n');
  });
});
