import { z } from 'zod';

/**
 * Skill name validation:
 * - 1-64 characters
 * - Lowercase letters, numbers, and hyphens only
 * - Cannot start or end with hyphen
 * - No consecutive hyphens
 */
const skillNameRegex = /^[a-z][a-z0-9-]*[a-z0-9]$|^[a-z]$/;

export const SkillFrontmatterSchema = z.object({
  name: z.string()
    .min(1, 'Name is required')
    .max(64, 'Name must be 64 characters or less')
    .regex(skillNameRegex, 'Name must be lowercase letters, numbers, and hyphens only')
    .refine(s => !s.includes('--'), 'Name cannot contain consecutive hyphens'),
  description: z.string()
    .min(1, 'Description is required')
    .max(1024, 'Description must be 1024 characters or less'),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  metadata: z.record(z.string(), z.string()).optional(),
  'allowed-tools': z.string().optional(),
});

export type SkillFrontmatter = z.infer<typeof SkillFrontmatterSchema>;

/**
 * Parsed skill information
 */
export interface SkillInfo {
  /** Skill identifier from frontmatter */
  name: string;
  /** Description of what the skill does and when to use it */
  description: string;
  /** Absolute path to SKILL.md file */
  location: string;
  /** Parsed allowed-tools patterns */
  allowedTools?: string[] | undefined;
  /** License information */
  license?: string | undefined;
  /** Compatibility/environment requirements */
  compatibility?: string | undefined;
  /** Additional metadata */
  metadata?: Record<string, string> | undefined;
}

/**
 * Full skill content after loading
 */
export interface SkillContent extends SkillInfo {
  /** Markdown body content (after frontmatter) */
  content: string;
  /** Directory containing the skill */
  directory: string;
}

/**
 * Tool validation result for allowed-tools checking
 */
export interface ToolValidationResult {
  pattern: string;
  satisfied: boolean;
  reason?: string | undefined;
}
