import type { ToolsConfig } from '../tools/types.js';
import type { SkillInfo } from './types.js';
import { isSkillTrusted, type NormalizedSkillsConfig } from './config.js';
import { extractCommandFromAllowedTool } from './command-extract.js';
import { looksEffectful } from '../tools/effectful-heuristic.js';

/**
 * The bash command patterns a trusted skill grants: the `Bash(x:*)` entries in
 * its SKILL.md `allowed-tools`, as `x *` allowlist patterns.
 */
export function trustedSkillGrants(
  skills: Map<string, SkillInfo>,
  skillsConfig: NormalizedSkillsConfig | undefined,
): string[] {
  const patterns = new Set<string>();
  for (const [name, info] of skills) {
    if (!isSkillTrusted(skillsConfig, name)) continue;
    for (const tool of info.allowedTools ?? []) {
      const head = extractCommandFromAllowedTool(tool);
      if (head) patterns.add(`${head} *`);
    }
  }
  return [...patterns];
}

/**
 * Gated patterns a skill declares for itself, via SKILL.md
 * `metadata.agentuse-gated` (a comma/newline-separated list of command patterns).
 * This is how a skill marks its OWN irreversible commands (e.g. `birdc reply *`)
 * so trusting the skill brings the gate together with the grant - the heuristic
 * can only see the granted family (`birdc *`), not the irreversible subcommand.
 * Spec-compliant: `metadata` is the SKILL.md standard's free-form namespace, so a
 * skill declaring this stays a valid, portable skill everywhere else.
 */
export function skillDeclaredGated(skill: SkillInfo): string[] {
  const raw = skill.metadata?.['agentuse-gated'];
  if (!raw) return [];
  return raw.split(/[,\n]/).map((s) => s.trim()).filter(Boolean);
}

/**
 * Expand a trusted skill's declared commands into the agent's effective tools
 * config (agentuse-lab#168): trusting a skill grants the bash commands it
 * declares in `allowed-tools`, WITHOUT the author having to re-list them.
 *
 * Rail (#168): a trust-granted command that looks irreversible (`looksEffectful`)
 * is routed to `gated` instead of `commands`, so a trusted third-party skill's
 * posting/deleting commands run only after human approval, never auto. A command
 * the author lists themselves in `tools.bash.commands` is respected as-is (their
 * explicit choice), never auto-gated. Both buckets are runnable (the effective
 * allowlist is commands ∪ gated); `gated` just adds the lease.
 */
export function expandTrustedSkills(
  baseConfig: ToolsConfig | undefined,
  skills: Map<string, SkillInfo>,
  skillsConfig: NormalizedSkillsConfig | undefined,
): ToolsConfig | undefined {
  const granted = trustedSkillGrants(skills, skillsConfig);
  // Skill-declared gates from every trusted skill (primary safety rail).
  const declaredGated = new Set<string>();
  for (const [name, info] of skills) {
    if (!isSkillTrusted(skillsConfig, name)) continue;
    for (const pattern of skillDeclaredGated(info)) declaredGated.add(pattern);
  }
  if (granted.length === 0 && declaredGated.size === 0) return baseConfig;

  const userCommands = baseConfig?.bash?.commands ?? [];
  const userCommandSet = new Set(userCommands);
  const userGated = baseConfig?.bash?.gated ?? [];

  const addCommands: string[] = [];
  const addGated: string[] = [...declaredGated];      // skill-declared gates always apply
  for (const pattern of granted) {
    if (userCommandSet.has(pattern)) continue;        // author listed it: respect their choice
    // Heuristic fallback: auto-gate an effectful-looking whole-command grant a
    // skill did not explicitly declare gated (e.g. a trusted `deploy *`).
    if (looksEffectful(pattern) && !declaredGated.has(pattern)) addGated.push(pattern);
    else addCommands.push(pattern);
  }
  if (addCommands.length === 0 && addGated.length === 0) return baseConfig;

  const commands = [...new Set([...userCommands, ...addCommands])];
  const gated = [...new Set([...userGated, ...addGated])];

  return {
    ...(baseConfig ?? {}),
    ...(baseConfig?.filesystem && { filesystem: [...baseConfig.filesystem] }),
    bash: {
      ...(baseConfig?.bash ?? {}),
      commands,
      ...(gated.length > 0 && { gated }),
    },
  };
}
