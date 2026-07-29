import { describe, test, expect } from 'bun:test';
import { expandTrustedSkills, trustedSkillGrants } from '../src/skill/capabilities';
import type { NormalizedSkillsConfig } from '../src/skill/config';
import type { SkillInfo } from '../src/skill/types';
import type { ToolsConfig } from '../src/tools/types';

function skill(name: string, allowedTools?: string[]): SkillInfo {
  return {
    name,
    description: `${name} skill`,
    location: `/skills/${name}/SKILL.md`,
    ...(allowedTools && { allowedTools }),
  };
}

function skillsMap(...infos: SkillInfo[]): Map<string, SkillInfo> {
  return new Map(infos.map((s) => [s.name, s]));
}

const AUTO: NormalizedSkillsConfig = { auto: true, trusted: false, explicit: {} };
const perSkillTrust = (name: string): NormalizedSkillsConfig => ({ auto: true, trusted: false, explicit: { [name]: { trusted: true } } });
const GLOBAL_TRUST: NormalizedSkillsConfig = { auto: true, trusted: true, explicit: {} };

describe('skill trust expansion (agentuse-lab#168)', () => {
  test('untrusted skill grants nothing', () => {
    const base: ToolsConfig = { bash: { commands: ['ls *'] } };
    const out = expandTrustedSkills(base, skillsMap(skill('linkedin', ['Bash(agent-browser:*)'])), AUTO);
    expect(out).toBe(base); // unchanged reference
  });

  test('per-skill trust grants the skill\'s allowed-tools Bash commands (to commands, auto-run)', () => {
    const base: ToolsConfig = { bash: { commands: ['ls *'] } };
    const out = expandTrustedSkills(base, skillsMap(skill('linkedin', ['Bash(agent-browser:*)', 'Read'])), perSkillTrust('linkedin'));
    expect(out?.bash?.commands).toEqual(expect.arrayContaining(['ls *', 'agent-browser *']));
    // `Read` is not a bash grant, so it is ignored.
    expect(out?.bash?.commands).not.toContain('Read *');
    // Trust only grants; it never invents gates.
    expect(out?.bash?.gated).toBeUndefined();
  });

  test('global trust grants every discovered skill', () => {
    const out = expandTrustedSkills(
      { bash: { commands: [] } },
      skillsMap(skill('a', ['Bash(foo:*)']), skill('b', ['Bash(bar:*)'])),
      GLOBAL_TRUST,
    );
    expect(out?.bash?.commands).toEqual(expect.arrayContaining(['foo *', 'bar *']));
  });

  test('a shadowing skill does not inherit a per-name trust grant', () => {
    const shadowing = {
      ...skill('linkedin', ['Bash(untrusted-project-command:*)']),
      location: '/project/.agentuse/skills/linkedin/SKILL.md',
      shadowedLocations: ['/home/user/.agentuse/skills/linkedin/SKILL.md'],
    };
    expect(trustedSkillGrants(
      skillsMap(shadowing),
      perSkillTrust('linkedin')
    )).toEqual([]);
  });

  test('global trust remains an explicit grant across duplicate sources', () => {
    const shadowing = {
      ...skill('linkedin', ['Bash(project-command:*)']),
      shadowedLocations: ['/home/user/.agentuse/skills/linkedin/SKILL.md'],
    };
    expect(trustedSkillGrants(skillsMap(shadowing), GLOBAL_TRUST)).toEqual(['project-command *']);
  });

  test('the author gates a subcommand: trust grants the family, tools.bash.gated wins for reply', () => {
    // Trust grants birdc * (auto-run). The author put birdc reply * in gated; the
    // expansion preserves it, and gated-wins precedence gates reply at runtime
    // while birdc read still auto-runs. Gating is the author's explicit choice.
    const base: ToolsConfig = { bash: { commands: [], gated: ['birdc reply *'] } };
    const out = expandTrustedSkills(base, skillsMap(skill('x-personal', ['Bash(birdc:*)'])), perSkillTrust('x-personal'));
    expect(out?.bash?.commands).toContain('birdc *');
    expect(out?.bash?.gated).toContain('birdc reply *');
  });

  test('helpers: trustedSkillGrants', () => {
    const skills = skillsMap(skill('x-personal', ['Bash(birdc:*)']));
    expect(trustedSkillGrants(skills, perSkillTrust('x-personal'))).toEqual(['birdc *']);
    expect(trustedSkillGrants(skills, AUTO)).toEqual([]);
  });

  test('trailing-wildcard spellings are equivalent: Bash(ls *) === Bash(ls:*)', () => {
    // Per the Claude Code permissions spec, and the space form is what the
    // permission dialog writes by default - previously it granted nothing.
    const spaced = skillsMap(skill('a', ['Bash(ls *)']));
    const colon = skillsMap(skill('a', ['Bash(ls:*)']));
    expect(trustedSkillGrants(spaced, perSkillTrust('a'))).toEqual(['ls *']);
    expect(trustedSkillGrants(colon, perSkillTrust('a'))).toEqual(['ls *']);
  });

  test('a multi-word prefix grants exactly that prefix, not the whole family', () => {
    const skills = skillsMap(skill('a', ['Bash(npm run *)', 'Bash(npx agent-browser:*)']));
    expect(trustedSkillGrants(skills, perSkillTrust('a'))).toEqual([
      'npm run *',
      'npx agent-browser *',
    ]);
  });

  test('a non-tail wildcard grants nothing rather than widening', () => {
    // Bash(git * main) is a legal Claude Code pattern, but it is not a prefix.
    // Collapsing it to `git *` would hand over every git subcommand.
    const skills = skillsMap(skill('a', ['Bash(git * main)']));
    expect(trustedSkillGrants(skills, perSkillTrust('a'))).toEqual([]);
  });

  test('shell metacharacters in a pattern grant nothing', () => {
    const skills = skillsMap(skill('a', ['Bash(echo $(whoami) *)', 'Bash(a && b *)']));
    expect(trustedSkillGrants(skills, perSkillTrust('a'))).toEqual([]);
  });
});
