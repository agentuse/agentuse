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
});
