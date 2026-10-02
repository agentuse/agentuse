import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseAgentContent } from '../src/parser';
import { defaultSkillsConfig, isSkillTrusted, SkillsConfigSchema } from '../src/skill/config';
import { parseSkillFrontmatter } from '../src/skill/parser';

const agentWithSkills = (skills: string) => `---
model: anthropic:claude-sonnet-4-0
${skills}
---

Test agent`;

describe('skill names in agent config', () => {
  it('accepts in the array form every name discovery accepts', () => {
    const agent = parseAgentContent(agentWithSkills('skills: [Invalid_Skill, bad--skill, my.skill, ns:my-skill]'), 'test');

    expect(Object.keys(agent.config.skills?.explicit ?? {})).toEqual(['Invalid_Skill', 'bad--skill', 'my.skill', 'ns:my-skill']);
  });

  it('trusts a non-kebab name in the map form', () => {
    const agent = parseAgentContent(agentWithSkills('skills:\n  bad--skill: trusted\n  My_Skill: {}'), 'test');

    expect(isSkillTrusted(agent.config.skills, 'bad--skill')).toBe(true);
    expect(isSkillTrusted(agent.config.skills, 'My_Skill')).toBe(false);
  });

  it('still rejects names discovery rejects', () => {
    expect(() => parseAgentContent(agentWithSkills('skills: ["my skill"]'), 'test')).toThrow();
    expect(() => parseAgentContent(agentWithSkills('skills: ["a/b"]'), 'test')).toThrow();
    expect(() => parseAgentContent(agentWithSkills('skills: [""]'), 'test')).toThrow();
  });

  it('keeps prototype names as ordinary keys', () => {
    const listed = SkillsConfigSchema.parse(['__proto__', 'constructor']);
    expect(Object.getPrototypeOf(listed.explicit)).toBeNull();
    expect(Object.keys(listed.explicit)).toEqual(['__proto__', 'constructor']);
    expect(isSkillTrusted(listed, 'toString')).toBe(false);

    const mapped = SkillsConfigSchema.parse({ constructor: 'trusted' });
    expect(isSkillTrusted(mapped, 'constructor')).toBe(true);
    expect(isSkillTrusted(mapped, 'hasOwnProperty')).toBe(false);
    expect(Object.getPrototypeOf(defaultSkillsConfig().explicit)).toBeNull();
  });
});

describe('skill names inferred from the directory', () => {
  let testDir: string;

  beforeEach(async () => {
    testDir = await mkdtemp(join(tmpdir(), 'skill-name-dir-'));
  });

  afterEach(async () => {
    await rm(testDir, { recursive: true, force: true });
  });

  it('rejects a directory name config could not address', async () => {
    await mkdir(join(testDir, 'my skill'));
    await writeFile(join(testDir, 'my skill', 'SKILL.md'), '---\ndescription: No name\n---\n\nContent');

    expect(await parseSkillFrontmatter(join(testDir, 'my skill', 'SKILL.md'))).toBeNull();
  });

  it('treats an empty frontmatter name as the directory name', async () => {
    await mkdir(join(testDir, 'dir-named'));
    await writeFile(join(testDir, 'dir-named', 'SKILL.md'), '---\nname: ""\ndescription: Empty name\n---\n\nContent');

    expect((await parseSkillFrontmatter(join(testDir, 'dir-named', 'SKILL.md')))?.name).toBe('dir-named');
  });
});
