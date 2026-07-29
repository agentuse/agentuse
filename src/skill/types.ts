import { z } from 'zod';

export const SkillFrontmatterSchema = z.object({
  name: z.string()
    .max(64, 'Name must be 64 characters or less')
    .refine(s => !/[/\\\s]/.test(s), 'Name cannot contain spaces, forward slashes, or backslashes')
    .optional(),
  description: z.string()
    .max(1024, 'Description must be 1024 characters or less')
    .optional()
    .default(''),
  license: z.string().optional(),
  compatibility: z.string().max(500).optional(),
  // Free-form annotations, never interpreted by the runtime - only preserved
  // and surfaced (`agentuse skills installed list --json`).
  //
  // DELIBERATELY laxer than the Agent Skills spec, which defines metadata as
  // "a map from string keys to string values" (agentskills.io/specification).
  // We accept nested values because we also discover `.claude/skills/` and
  // `~/.claude/skills/`, where published third-party skills park another tool's
  // config here anyway (e.g. OpenClaw's `metadata.openclaw`) and Claude Code
  // loads them fine. Rejection is all-or-nothing: holding a field we never read
  // to the strict shape made the WHOLE skill invisible to every agent. Matches
  // the agent frontmatter's `metadata` (parser.ts), which is already `unknown`.
  metadata: z.record(z.string(), z.unknown()).optional(),
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
  /**
   * Lower-priority skills with the same declared name. Per-skill trust by name
   * is intentionally not expanded while this list is non-empty: the name does
   * not identify one canonical source.
   */
  shadowedLocations?: string[] | undefined;
  /** Parsed allowed-tools patterns */
  allowedTools?: string[] | undefined;
  /** License information */
  license?: string | undefined;
  /** Compatibility/environment requirements */
  compatibility?: string | undefined;
  /** Additional metadata: free-form, never interpreted, values may be nested */
  metadata?: Record<string, unknown> | undefined;
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
