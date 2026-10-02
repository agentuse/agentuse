import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createAddCommand } from '../src/cli/add';

describe('agentuse add command', () => {
  let projectDir: string;
  let sourceDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;
  let originalTelemetry: string | undefined;
  let exitSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    projectDir = await realpath(await mkdtemp(join(tmpdir(), 'add-command-project-')));
    sourceDir = await realpath(await mkdtemp(join(tmpdir(), 'add-command-source-')));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    originalTelemetry = process.env.AGENTUSE_TELEMETRY_DISABLED;
    process.env.HOME = projectDir;
    process.env.AGENTUSE_TELEMETRY_DISABLED = 'true';
    process.chdir(projectDir);
    exitSpy = spyOn(process, 'exit').mockImplementation(((code?: number) => {
      throw new Error(`process.exit(${code})`);
    }) as typeof process.exit);
  });

  afterEach(async () => {
    exitSpy?.mockRestore();
    process.chdir(originalCwd);
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    if (originalTelemetry !== undefined) process.env.AGENTUSE_TELEMETRY_DISABLED = originalTelemetry;
    else delete process.env.AGENTUSE_TELEMETRY_DISABLED;
    await rm(projectDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  });

  async function runAdd(args: string[]): Promise<void> {
    await createAddCommand().parseAsync(args, { from: 'user' });
  }

  it('--list on a direct skill path installs nothing', async () => {
    const skillDir = join(sourceDir, 'my-skill');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: Direct\n---');

    await runAdd([skillDir, '--list']);

    expect(existsSync(join(projectDir, '.agentuse', 'skills', 'my-skill'))).toBe(false);
  });

  it('--skill installs only the named skill and no agents', async () => {
    await mkdir(join(sourceDir, 'skills', 'sk-a'), { recursive: true });
    await writeFile(join(sourceDir, 'skills', 'sk-a', 'SKILL.md'), '---\nname: sk-a\ndescription: A\n---');
    await mkdir(join(sourceDir, 'agents'));
    await writeFile(join(sourceDir, 'agents', 'one.agentuse'), 'model: anthropic:claude-sonnet-4-5\n---');
    await writeFile(join(sourceDir, 'agents', 'two.agentuse'), 'model: anthropic:claude-sonnet-4-5\n---');

    await runAdd([sourceDir, '--skill', 'sk-a']);

    expect(existsSync(join(projectDir, '.agentuse', 'skills', 'sk-a', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(projectDir, 'agents'))).toBe(false);
  });

  it('--agent installs only the named agent and no skills', async () => {
    await mkdir(join(sourceDir, 'skills', 'sk-a'), { recursive: true });
    await writeFile(join(sourceDir, 'skills', 'sk-a', 'SKILL.md'), '---\nname: sk-a\ndescription: A\n---');
    await mkdir(join(sourceDir, 'agents'));
    await writeFile(join(sourceDir, 'agents', 'one.agentuse'), 'model: anthropic:claude-sonnet-4-5\n---');
    await writeFile(join(sourceDir, 'agents', 'two.agentuse'), 'model: anthropic:claude-sonnet-4-5\n---');

    await runAdd([sourceDir, '--agent', 'agents/one.agentuse']);

    expect(existsSync(join(projectDir, 'agents', 'one.agentuse'))).toBe(true);
    expect(existsSync(join(projectDir, 'agents', 'two.agentuse'))).toBe(false);
    expect(existsSync(join(projectDir, '.agentuse', 'skills'))).toBe(false);
  });

  it('installs a direct skill path without asking', async () => {
    const skillDir = join(sourceDir, 'my-skill');
    await mkdir(skillDir);
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: my-skill\ndescription: Direct\n---');

    await runAdd([skillDir]);

    expect(existsSync(join(projectDir, '.agentuse', 'skills', 'my-skill', 'SKILL.md'))).toBe(true);
  });
});
