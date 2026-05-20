import { z } from 'zod';

export interface SkillGrantConfig {
  allow?: string[] | undefined;
}

export interface NormalizedSkillsConfig {
  auto: boolean;
  trusted: boolean;
  explicit: Record<string, SkillGrantConfig>;
}

const SkillNameSchema = z.string()
  .min(1)
  .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*(?::[a-z0-9]+(?:-[a-z0-9]+)*)*$/, 'Invalid skill name');

const SkillGrantSchema = z.object({
  allow: z.array(z.string()).optional(),
}).strict();

export const SkillsConfigSchema = z.union([
  z.literal('auto').transform((): NormalizedSkillsConfig => ({ auto: true, trusted: false, explicit: {} })),
  z.literal('trusted').transform((): NormalizedSkillsConfig => ({ auto: true, trusted: true, explicit: {} })),
  z.array(SkillNameSchema).transform((names): NormalizedSkillsConfig => ({
    auto: false,
    trusted: false,
    explicit: Object.fromEntries(names.map((name) => [name, {}])),
  })),
  z.record(z.unknown()).transform((raw, ctx): NormalizedSkillsConfig => {
    const explicit: Record<string, SkillGrantConfig> = {};
    let auto = false;

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

      const grantResult = SkillGrantSchema.safeParse(value ?? {});
      if (!grantResult.success) {
        for (const issue of grantResult.error.issues) {
          ctx.addIssue({
            ...issue,
            path: [key, ...issue.path],
          });
        }
        return z.NEVER;
      }

      explicit[key] = grantResult.data;
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

export function getGrantedSkillAllows(skills: NormalizedSkillsConfig | undefined): string[] {
  const allows = new Set<string>();
  for (const grant of Object.values(skills?.explicit ?? {})) {
    for (const allow of grant.allow ?? []) {
      if (allow !== '*') {
        allows.add(allow);
      }
    }
  }
  return [...allows];
}

export function hasFullSkillGrant(skills: NormalizedSkillsConfig | undefined): boolean {
  return skills?.trusted === true || Object.values(skills?.explicit ?? {}).some((grant) => grant.allow?.includes('*'));
}
