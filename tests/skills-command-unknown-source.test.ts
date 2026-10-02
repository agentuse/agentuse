import { afterEach, beforeEach, describe, expect, it, mock, spyOn } from 'bun:test';
import { mkdtemp, realpath, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import * as discovery from '../src/skill/discovery';
import type { SkillInfo } from '../src/skill/types';

// A skill outside every listed discovery directory, as happens when the two
// sides of the containment check disagree on path form.
const stray: SkillInfo = {
  name: 'stray-skill',
  description: 'Lives outside every listed directory',
  location: join(tmpdir(), 'elsewhere', 'stray-skill', 'SKILL.md'),
};
mock.module('../src/skill/discovery', () => ({
  ...discovery,
  discoverSkills: async () => new Map([[stray.name, stray]]),
}));

const { createSkillsCommand } = await import('../src/cli/skills');

describe('skills installed list with an unclassified skill', () => {
  let testDir: string;
  let originalCwd: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    testDir = await realpath(await mkdtemp(join(tmpdir(), 'skills-unknown-source-')));
    originalCwd = process.cwd();
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
    process.chdir(testDir);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    if (originalHome !== undefined) process.env.HOME = originalHome;
    else delete process.env.HOME;
    await rm(testDir, { recursive: true, force: true });
  });

  async function run(args: string[]): Promise<string> {
    const output: string[] = [];
    const logSpy = spyOn(console, 'log').mockImplementation((value = '') => {
      output.push(String(value));
    });
    try {
      await createSkillsCommand().parseAsync(args, { from: 'user' });
    } finally {
      logSpy.mockRestore();
    }
    return output.join('\n');
  }

  it('prints every counted skill, including ones in no listed directory', async () => {
    const output = await run(['installed', 'list']);

    expect(output).toContain('Found 1 installed skill(s)');
    expect(output).toContain('unknown');
    expect(output).toContain('stray-skill');
  });

  it('reports the unclassified skill as unknown in JSON', async () => {
    const parsed = JSON.parse(await run(['installed', 'list', '--json']));

    expect(parsed.skills.find((skill: { name: string }) => skill.name === 'stray-skill')?.source).toBe('unknown');
  });
});
