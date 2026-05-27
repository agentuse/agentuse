import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir } from 'os';
import { findProjectRoot } from '../src/utils/project';

describe('findProjectRoot $HOME guard', () => {
  let homeTempDir: string;

  beforeEach(async () => {
    homeTempDir = await mkdtemp(join(homedir(), '.agentuse-project-test-'));
  });

  afterEach(async () => {
    await rm(homeTempDir, { recursive: true, force: true });
  });

  it('stops walking at $HOME even when a marker exists there', async () => {
    const nested = join(homeTempDir, 'a', 'b', 'c');
    await mkdir(nested, { recursive: true });

    const result = findProjectRoot(nested);

    expect(result).not.toBe(homedir());
    expect(result.startsWith(homeTempDir)).toBe(true);
  });

  it('returns marker directory when found below $HOME', async () => {
    const projectDir = join(homeTempDir, 'my-project');
    const nested = join(projectDir, 'src');
    await mkdir(nested, { recursive: true });
    await writeFile(join(projectDir, 'package.json'), '{}');

    const result = findProjectRoot(nested);

    expect(result).toBe(projectDir);
  });
});
