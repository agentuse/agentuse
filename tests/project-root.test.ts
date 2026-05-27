import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { findProjectRoot, resolveLocalAgentPath, resolveProjectContext } from '../src/utils/project';

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

describe('resolveProjectContext stateRoot', () => {
  let scratchDir: string;

  beforeEach(async () => {
    scratchDir = await mkdtemp(join(tmpdir(), 'agentuse-stateroot-'));
  });

  afterEach(async () => {
    await rm(scratchDir, { recursive: true, force: true });
  });

  it('derives stateRoot from the agent file project when provided', async () => {
    // Two sibling "projects", each with a marker. Cwd is in one, the agent
    // file lives in the other.
    const cwdProject = join(scratchDir, 'cwd-project');
    const agentProject = join(scratchDir, 'agent-project');
    await mkdir(join(cwdProject, 'sub'), { recursive: true });
    await mkdir(join(agentProject, 'agents'), { recursive: true });
    await writeFile(join(cwdProject, 'package.json'), '{}');
    await writeFile(join(agentProject, 'package.json'), '{}');
    const agentFilePath = join(agentProject, 'agents', 'foo.agentuse');
    await writeFile(agentFilePath, '');

    const context = resolveProjectContext(join(cwdProject, 'sub'), {
      agentFilePath,
    });

    expect(context.projectRoot).toBe(cwdProject);
    expect(context.stateRoot).toBe(agentProject);
  });

  it('falls back to projectRoot when no agent file path is given', async () => {
    const cwdProject = join(scratchDir, 'cwd-only');
    await mkdir(cwdProject, { recursive: true });
    await writeFile(join(cwdProject, 'package.json'), '{}');

    const context = resolveProjectContext(cwdProject);

    expect(context.projectRoot).toBe(cwdProject);
    expect(context.stateRoot).toBe(cwdProject);
  });

  it('falls back to projectRoot when agent file path does not exist', async () => {
    const cwdProject = join(scratchDir, 'cwd-fallback');
    await mkdir(cwdProject, { recursive: true });
    await writeFile(join(cwdProject, 'package.json'), '{}');

    const context = resolveProjectContext(cwdProject, {
      agentFilePath: join(scratchDir, 'does-not-exist.agentuse'),
    });

    expect(context.projectRoot).toBe(cwdProject);
    expect(context.stateRoot).toBe(cwdProject);
  });

  it('resolves extensionless agent paths before deriving stateRoot', async () => {
    const cwdProject = join(scratchDir, 'cwd-project');
    const agentProject = join(scratchDir, 'agent-project');
    await mkdir(cwdProject, { recursive: true });
    await mkdir(join(agentProject, 'agents'), { recursive: true });
    await writeFile(join(cwdProject, 'package.json'), '{}');
    await writeFile(join(agentProject, 'package.json'), '{}');
    const agentFilePath = join(agentProject, 'agents', 'foo.agentuse');
    await writeFile(agentFilePath, '');

    const resolvedAgentPath = resolveLocalAgentPath(join(agentProject, 'agents', 'foo'), cwdProject);
    const context = resolveProjectContext(cwdProject, {
      ...(resolvedAgentPath && { agentFilePath: resolvedAgentPath }),
    });

    expect(resolvedAgentPath).toBe(agentFilePath);
    expect(context.projectRoot).toBe(cwdProject);
    expect(context.stateRoot).toBe(agentProject);
  });
});
