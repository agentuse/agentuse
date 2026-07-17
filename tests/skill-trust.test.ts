import { describe, test, expect } from 'bun:test';
import { expandTrustedSkills, trustedSkillGrants, skillDeclaredGated } from '../src/skill/capabilities';
import type { NormalizedSkillsConfig } from '../src/skill/config';
import type { SkillInfo } from '../src/skill/types';
import type { ToolsConfig } from '../src/tools/types';

function skill(name: string, allowedTools?: string[], gatedMeta?: string): SkillInfo {
  return {
    name,
    description: `${name} skill`,
    location: `/skills/${name}/SKILL.md`,
    ...(allowedTools && { allowedTools }),
    ...(gatedMeta && { metadata: { 'agentuse-gated': gatedMeta } }),
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

  test('per-skill trust grants the skill\'s allowed-tools Bash commands', () => {
    const base: ToolsConfig = { bash: { commands: ['ls *'] } };
    const out = expandTrustedSkills(base, skillsMap(skill('linkedin', ['Bash(agent-browser:*)', 'Read'])), perSkillTrust('linkedin'));
    expect(out?.bash?.commands).toContain('agent-browser *');
    expect(out?.bash?.commands).toContain('ls *');
    // `Read` is not a bash grant, so it is ignored.
    expect(out?.bash?.commands).not.toContain('Read *');
  });

  test('global trust grants every discovered skill', () => {
    const out = expandTrustedSkills(
      { bash: { commands: [] } },
      skillsMap(skill('a', ['Bash(foo:*)']), skill('b', ['Bash(bar:*)'])),
      GLOBAL_TRUST,
    );
    expect(out?.bash?.commands).toEqual(expect.arrayContaining(['foo *', 'bar *']));
  });

  test('heuristic fallback auto-gates an effectful-looking whole-command grant', () => {
    // `deploy` is an effectful verb, so a trusted `deploy *` grant is gated, not auto-run.
    const out = expandTrustedSkills(
      { bash: { commands: [] } },
      skillsMap(skill('shipper', ['Bash(deploy:*)', 'Bash(build:*)'])),
      perSkillTrust('shipper'),
    );
    expect(out?.bash?.gated).toContain('deploy *');
    expect(out?.bash?.commands).toContain('build *'); // benign -> auto-run
    expect(out?.bash?.commands).not.toContain('deploy *');
  });

  test('skill-declared gated brings the precise sub-command gate with the family grant', () => {
    // The birdc case the heuristic can't see: family grant `birdc *` is auto-run,
    // but the skill declares `birdc reply *` gated, so trust brings both.
    const out = expandTrustedSkills(
      { bash: { commands: [] } },
      skillsMap(skill('x-personal', ['Bash(birdc:*)'], 'birdc reply *, birdc tweet *')),
      perSkillTrust('x-personal'),
    );
    expect(out?.bash?.commands).toContain('birdc *');       // family runnable
    expect(out?.bash?.gated).toEqual(expect.arrayContaining(['birdc reply *', 'birdc tweet *']));
  });

  test('a command the author lists themselves is respected, never auto-gated', () => {
    // Author explicitly allowlisted `deploy *`: their choice wins, no auto-gate.
    const out = expandTrustedSkills(
      { bash: { commands: ['deploy *'] } },
      skillsMap(skill('shipper', ['Bash(deploy:*)'])),
      perSkillTrust('shipper'),
    );
    expect(out?.bash?.commands).toContain('deploy *');
    expect(out?.bash?.gated ?? []).not.toContain('deploy *');
  });

  test('helpers: trustedSkillGrants and skillDeclaredGated', () => {
    const skills = skillsMap(skill('x-personal', ['Bash(birdc:*)'], 'birdc reply *'));
    expect(trustedSkillGrants(skills, perSkillTrust('x-personal'))).toEqual(['birdc *']);
    expect(trustedSkillGrants(skills, AUTO)).toEqual([]);
    expect(skillDeclaredGated(skills.get('x-personal')!)).toEqual(['birdc reply *']);
  });
});
