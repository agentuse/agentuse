import matter from 'gray-matter';
import { readFile } from 'fs/promises';
import { dirname } from 'path';
import type { ZodError } from 'zod';
import { SkillFrontmatterSchema, type SkillInfo, type SkillContent } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Format Zod error as a single sentence
 */
function formatZodError(error: ZodError): string {
  return error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ');
}

/**
 * Parse allowed-tools string into array of patterns
 */
function parseAllowedTools(allowedTools: string | undefined): string[] | undefined {
  if (!allowedTools) return undefined;
  const tools = allowedTools.trim().split(/\s+/).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

/**
 * Parse SKILL.md frontmatter only (for discovery)
 * Returns SkillInfo or null if invalid
 */
export async function parseSkillFrontmatter(filePath: string): Promise<SkillInfo | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const { data } = matter(content);

    const parsed = SkillFrontmatterSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn(`Invalid skill "${filePath}": ${formatZodError(parsed.error)}`);
      return null;
    }

    const frontmatter = parsed.data;

    return {
      name: frontmatter.name,
      description: frontmatter.description,
      location: filePath,
      allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
      license: frontmatter.license,
      compatibility: frontmatter.compatibility,
      metadata: frontmatter.metadata,
    };
  } catch (error) {
    logger.warn(`Failed to parse skill at ${filePath}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

/**
 * Parse full SKILL.md content (for loading)
 * Returns SkillContent or throws if invalid
 */
export async function parseSkillContent(filePath: string): Promise<SkillContent> {
  const fileContent = await readFile(filePath, 'utf-8');
  const { data, content } = matter(fileContent);

  const parsed = SkillFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid skill frontmatter: ${formatZodError(parsed.error)}`);
  }

  const frontmatter = parsed.data;

  return {
    name: frontmatter.name,
    description: frontmatter.description,
    location: filePath,
    allowedTools: parseAllowedTools(frontmatter['allowed-tools']),
    license: frontmatter.license,
    compatibility: frontmatter.compatibility,
    metadata: frontmatter.metadata,
    content: content.trim(),
    directory: dirname(filePath),
  };
}
