import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, stat, writeFile, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { atomicWriteFile, atomicWriteFileSync, createFileExclusive } from '../src/utils/atomic-write';

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'atomic-write-'));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const modeOf = async (path: string) => (await stat(path)).mode & 0o777;

describe.each([
  ['async', (t: string, c: string, o?: Parameters<typeof atomicWriteFile>[2]) => atomicWriteFile(t, c, o)],
  ['sync', async (t: string, c: string, o?: Parameters<typeof atomicWriteFile>[2]) => atomicWriteFileSync(t, c, o)],
])('%s atomic write', (_label, write) => {
  it('creates the file and leaves no temp file behind', async () => {
    const target = join(dir, 'state.json');
    await write(target, '{"a":1}');
    expect(await readFile(target, 'utf8')).toBe('{"a":1}');
    expect(await readdir(dir)).toEqual(['state.json']);
  });

  it('replaces existing content without a partial state', async () => {
    const target = join(dir, 'state.json');
    await write(target, 'a-much-longer-first-write');
    await write(target, 'short');
    expect(await readFile(target, 'utf8')).toBe('short');
  });

  it('applies an explicit mode even when the file already exists too open', async () => {
    const target = join(dir, 'secret.json');
    await writeFile(target, 'old');
    await chmod(target, 0o644);
    await write(target, 'new', { mode: 0o600 });
    expect(await modeOf(target)).toBe(0o600);
  });

  it('preserves the existing mode when none is given', async () => {
    const target = join(dir, 'agent.agentuse');
    await writeFile(target, 'old');
    await chmod(target, 0o640);
    await write(target, 'new');
    expect(await modeOf(target)).toBe(0o640);
  });

  it('creates the parent directory on request', async () => {
    const target = join(dir, 'nested', 'deep', 'state.json');
    await write(target, 'ok', { mkdir: true });
    expect(await readFile(target, 'utf8')).toBe('ok');
  });

  it('cleans up the temp file when the destination directory is missing', async () => {
    const target = join(dir, 'missing', 'state.json');
    await expect(Promise.resolve(write(target, 'ok'))).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('createFileExclusive', () => {
  it('writes the complete content on first create', async () => {
    const target = join(dir, 'agent.agentuse');
    await createFileExclusive(target, 'body');
    expect(await readFile(target, 'utf8')).toBe('body');
    expect(await modeOf(target)).toBe(0o600);
    expect(await readdir(dir)).toEqual(['agent.agentuse']);
  });

  it('fails with EEXIST and leaves the existing file untouched', async () => {
    const target = join(dir, 'agent.agentuse');
    await writeFile(target, 'original');
    await expect(createFileExclusive(target, 'replacement'))
      .rejects.toMatchObject({ code: 'EEXIST' });
    expect(await readFile(target, 'utf8')).toBe('original');
    expect(await readdir(dir)).toEqual(['agent.agentuse']);
  });

  it('only one of many concurrent creates wins', async () => {
    const target = join(dir, 'agent.agentuse');
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_unused, index) => createFileExclusive(target, `writer-${index}`)),
    );
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const winner = results.findIndex((result) => result.status === 'fulfilled');
    expect(await readFile(target, 'utf8')).toBe(`writer-${winner}`);
    expect(await readdir(dir)).toEqual(['agent.agentuse']);
  });
});
