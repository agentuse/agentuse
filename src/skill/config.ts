import { z } from 'zod';

export interface SkillGrantConfig {
  // Trusting a skill grants it the bash commands it declares in its SKILL.md
  // `allowed-tools`. Default (no trust) grants nothing: the skill loads but its
  // commands must be listed in `tools.bash.commands` to run. Trust is a real
  // decision (like installing an editor extension) - see the trust expansion in
  // capabilities.ts. Trust only grants; it never invents gates. To require
  // approval for a subset of what a skill grants, the author lists that pattern
  // in `tools.bash.gated` (agentuse-lab#168).
  trusted?: boolean | undefined;
}

export interface NormalizedSkillsConfig {
  auto: boolean;
  trusted: boolean;   // global: trust ALL discovered skills (the blunt shortcut)
  explicit: Record<string, SkillGrantConfig>;
}

const SkillNameSchema = z.string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)*$/, 'Invalid skill name');

const SkillGrantSchema = z.object({
  trusted: z.boolean().optional(),
}).strict();

/** Normalize one per-skill value: `trusted` shorthand, an object, or bare inclusion. */
function normalizeGrant(value: unknown): SkillGrantConfig | { error: string } {
  if (value === 'trusted') return { trusted: true };
  if (value == null) return {};
  if (typeof value === 'object') {
    const result = SkillGrantSchema.safeParse(value);
    if (!result.success) return { error: result.error.issues[0]?.message ?? 'invalid skill grant' };
    return result.data;
  }
  return { error: 'skill value must be "trusted", an object, or empty' };
}

// Naming a skill (in the array or map form) PRELOADS it; it never hides the
// others. Discovery stays on by default, so unlisted skills remain loadable
// on demand. Restricting to a closed set is an explicit, deliberate act:
// set `auto: false` in the map form. This keeps the common intent ("these are
// the skills I use") on the short path and makes hiding loud, not accidental
// (agentuse-lab#168). Note: this reverses v0.15.0, where `skills: [x]` was an
// allowlist that silently hid every other skill.
export const SkillsConfigSchema = z.union([
  z.literal('auto').transform((): NormalizedSkillsConfig => ({ auto: true, trusted: false, explicit: {} })),
  z.literal('trusted').transform((): NormalizedSkillsConfig => ({ auto: true, trusted: true, explicit: {} })),
  z.array(SkillNameSchema).transform((names): NormalizedSkillsConfig => ({
    auto: true,
    trusted: false,
    explicit: Object.fromEntries(names.map((name) => [name, {}])),
  })),
  z.record(z.unknown()).transform((raw, ctx): NormalizedSkillsConfig => {
    const explicit: Record<string, SkillGrantConfig> = {};
    // Open by default: naming skills annotates them, it does not fence out the
    // rest. Opt into a closed set with an explicit `auto: false`.
    let auto = true;

    for (const [key, value] of Object.entries(raw)) {
      if (key === 'auto') {
        if (typeof value !== 'boolean') {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: [key],
            message: 'skills.auto must be a boolean',
          });
          return z.NEVER;
        }
        auto = value;
        continue;
      }

      const nameResult = SkillNameSchema.safeParse(key);
      if (!nameResult.success) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: `Invalid skill name "${key}"`,
        });
        return z.NEVER;
      }

      const grant = normalizeGrant(value);
      if ('error' in grant) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: [key],
          message: grant.error,
        });
        return z.NEVER;
      }

      explicit[key] = grant;
    }

    return { auto, trusted: false, explicit };
  }),
]);

export function defaultSkillsConfig(): NormalizedSkillsConfig {
  return { auto: true, trusted: false, explicit: {} };
}

export function getExplicitSkillNames(skills: NormalizedSkillsConfig | undefined): string[] {
  return Object.keys(skills?.explicit ?? {});
}

/** Whether a specific discovered skill is trusted (globally or per-skill). */
export function isSkillTrusted(skills: NormalizedSkillsConfig | undefined, name: string): boolean {
  if (!skills) return false;
  return skills.trusted === true || skills.explicit[name]?.trusted === true;
}

/** The explicit skills marked `trusted` (does not include the global trust-all switch). */
export function getTrustedSkillNames(skills: NormalizedSkillsConfig | undefined): string[] {
  return Object.entries(skills?.explicit ?? {})
    .filter(([, grant]) => grant.trusted === true)
    .map(([name]) => name);
}

/** Global trust-all switch: every discovered skill is trusted. */
export function trustsAllSkills(skills: NormalizedSkillsConfig | undefined): boolean {
  return skills?.trusted === true;
}
