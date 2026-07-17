import type { ToolsConfig } from '../tools/types.js';
import type { SkillInfo } from './types.js';
import { isSkillTrusted, type NormalizedSkillsConfig } from './config.js';
import { extractCommandFromAllowedTool } from './command-extract.js';

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
 * Expand a trusted skill's declared commands into the agent's effective tools
 * config (agentuse-lab#168): trusting a skill grants the bash commands it
 * declares in `allowed-tools`, WITHOUT the author having to re-list them.
 *
 * Trust only grants (adds to `commands`). Gating stays the author's explicit
 * call: to gate a subset (e.g. a trusted skill grants `birdc *` but you want
 * `birdc reply *` behind approval), add that pattern to `tools.bash.gated`. It
 * wins over the trust-granted family via gated-wins precedence, so the family
 * auto-runs while the gated subcommand needs approval. `agentuse doctor` flags
 * granted commands that look irreversible so you know what to consider gating.
 */
export function expandTrustedSkills(
  baseConfig: ToolsConfig | undefined,
  skills: Map<string, SkillInfo>,
  skillsConfig: NormalizedSkillsConfig | undefined,
): ToolsConfig | undefined {
  const granted = trustedSkillGrants(skills, skillsConfig);
  if (granted.length === 0) return baseConfig;

  const userCommands = baseConfig?.bash?.commands ?? [];
  const commands = [...new Set([...userCommands, ...granted])];
  if (commands.length === userCommands.length) return baseConfig;   // nothing new to grant

  return {
    ...(baseConfig ?? {}),
    ...(baseConfig?.filesystem && { filesystem: [...baseConfig.filesystem] }),
    bash: {
      ...(baseConfig?.bash ?? {}),
      commands,
    },
  };
}
