import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { createSkillsCommand } from '../src/cli/skills';

describe('createSkillsCommand', () => {
  let testDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;
  let logSpy: ReturnType<typeof spyOn> | undefined;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'skills-command-test-'));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
    process.chdir(testDir);
  });

  afterEach(async () => {
    logSpy?.mockRestore();
    process.chdir(originalCwd);
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    await rm(testDir, { recursive: true, force: true });
  });

  async function writeSkill(name: string, description: string, body = '# Skill Body') {
    const skillDir = join(testDir, '.agentuse', 'skills', name);
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), `---
name: ${name}
description: ${description}
---

${body}
`);
    return skillDir;
  }

  async function runSkillsCommand(args: string[]): Promise<string> {
    const output: string[] = [];
    logSpy = spyOn(console, 'log').mockImplementation((value = '') => {
      output.push(String(value));
    });

    const command = createSkillsCommand();
    await command.parseAsync(args, { from: 'user' });
    return output.join('\n');
  }

  it('lists builtin skills as JSON from the default command', async () => {
    await writeSkill('code-review', 'Review code');

    const output = await runSkillsCommand(['--json']);
    const parsed = JSON.parse(output);

    expect(parsed.count).toBeGreaterThanOrEqual(1);
    expect(parsed.source).toBe('builtin');
    expect(parsed.skills.some((candidate: { name: string }) => candidate.name === 'core')).toBe(true);
    expect(parsed.skills.some((candidate: { name: string }) => candidate.name === 'runner')).toBe(true);
    expect(parsed.skills.some((candidate: { name: string }) => candidate.name === 'creator')).toBe(true);
    expect(parsed.skills.some((candidate: { name: string }) => candidate.name === 'code-review')).toBe(false);
  });

  it('lists builtin skills as JSON from the explicit list subcommand', async () => {
    const output = await runSkillsCommand(['list', '--json']);
    const parsed = JSON.parse(output);

    expect(parsed.source).toBe('builtin');
    expect(parsed.skills.some((candidate: { name: string }) => candidate.name === 'core')).toBe(true);
  });

  it('lists installed skills from the installed subcommand', async () => {
    await writeSkill('list-helper', 'List helper');

    const output = await runSkillsCommand(['installed', 'list', '--json']);
    const parsed = JSON.parse(output);
    const skill = parsed.skills.find((candidate: { name: string }) => candidate.name === 'list-helper');

    expect(parsed.source).toBe('installed');
    expect(skill.description).toBe('List helper');
  });

  it('defaults installed to installed list', async () => {
    await writeSkill('installed-helper', 'Installed helper');

    const output = await runSkillsCommand(['installed', '--json']);
    const parsed = JSON.parse(output);
    const skill = parsed.skills.find((candidate: { name: string }) => candidate.name === 'installed-helper');

    expect(parsed.source).toBe('installed');
    expect(skill.description).toBe('Installed helper');
  });

  it('does not treat installed as builtin list data', async () => {
    await writeSkill('not-builtin', 'Installed only');

    const output = await runSkillsCommand(['list', '--json']);
    const parsed = JSON.parse(output);

    expect(parsed.skills.some((candidate: { name: string }) => candidate.name === 'not-builtin')).toBe(false);
  });

  it('prints raw builtin core skill content with get', async () => {
    const output = await runSkillsCommand(['get', 'core']);

    expect(output).toContain('name: core');
    expect(output).toContain('# AgentUse Core');
  });

  it('prints specialized builtin skills with get', async () => {
    const output = await runSkillsCommand(['get', 'runner', 'creator']);

    expect(output).toContain('--- runner/SKILL.md ---');
    expect(output).toContain('name: runner');
    expect(output).toContain('--- creator/SKILL.md ---');
    expect(output).toContain('name: creator');
  });

  it('prints raw installed skill content with installed get', async () => {
    await writeSkill('code-review', 'Review code', '# Review\n\nUse sharp judgment.');

    const output = await runSkillsCommand(['installed', 'get', 'code-review']);

    expect(output).toContain('name: code-review');
    expect(output).toContain('# Review');
    expect(output).toContain('Use sharp judgment.');
  });

  it('prints skill content as JSON when the flag follows the name', async () => {
    await writeSkill('json-review', 'JSON review', '# JSON Review');

    const output = await runSkillsCommand(['installed', 'get', 'json-review', '--json']);
    const parsed = JSON.parse(output);

    expect(parsed.count).toBe(1);
    expect(parsed.source).toBe('installed');
    expect(parsed.skills[0].name).toBe('json-review');
    expect(parsed.skills[0].content).toContain('# JSON Review');
  });

  it('includes supporting text files with get --full', async () => {
    const skillDir = await writeSkill('release-helper', 'Prepare releases');
    await mkdir(join(skillDir, 'references'));
    await writeFile(join(skillDir, 'references', 'checklist.md'), '# Checklist\n\nShip it cleanly.');

    const output = await runSkillsCommand(['installed', 'get', 'release-helper', '--full']);

    expect(output).toContain('--- references/checklist.md ---');
    expect(output).toContain('Ship it cleanly.');
  });

  it('prints the installed skill directory path', async () => {
    const skillDir = await writeSkill('path-helper', 'Find paths');

    const output = await runSkillsCommand(['installed', 'path', 'path-helper']);

    expect(output).toBe(await realpath(skillDir));
  });

  it('prints builtin skill directory path', async () => {
    const output = await runSkillsCommand(['path', 'core']);

    expect(output).toContain('/skill-data/core');
  });
});
