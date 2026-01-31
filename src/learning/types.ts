import { z } from 'zod';

/**
 * Config schema for learning feature in agent config
 */
export const LearningConfigSchema = z.object({
  evaluate: z.union([z.literal(true), z.string()]),
  apply: z.boolean(),
  file: z.string().optional(),  // Custom file path (relative to agent file)
});

export type LearningConfig = z.infer<typeof LearningConfigSchema>;

/**
 * Learning category types
 */
export type LearningCategory = 'tip' | 'warning' | 'pattern' | 'tool-usage' | 'error-fix';

/**
 * Learning item stored in markdown
 */
export interface Learning {
  id: string;           // Short ID (8 chars)
  category: LearningCategory;
  title: string;        // One-line summary
  instruction: string;  // The actual learning text
  confidence: number;   // 0-1
  appliedCount: number; // Times injected
  extractedAt: string;  // ISO date
}
