import matter from 'gray-matter';
import { readFile } from 'fs/promises';
import { basename, dirname } from 'path';
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
 * Split on top-level separators only: a comma or whitespace that is NOT inside
 * a `Bash(...)` pattern's parentheses.
 */
function splitTopLevel(value: string): string[] {
  const out: string[] = [];
  let current = '';
  let depth = 0;
  for (const ch of value) {
    if (ch === '(') depth++;
    else if (ch === ')') depth = Math.max(0, depth - 1);
    else if (depth === 0 && (ch === ',' || /\s/.test(ch))) {
      if (current) out.push(current);
      current = '';
      continue;
    }
    current += ch;
  }
  if (current) out.push(current);
  return out;
}

/**
 * Parse allowed-tools into an array of patterns.
 *
 * Accepts all three shapes Claude Code documents: a space-separated string, a
 * comma-separated string, or a YAML list. (The Agent Skills spec documents only
 * the space-separated form; we take the superset because we also discover
 * `.claude/skills/`.)
 *
 * Splitting is paren-aware because a `Bash(...)` pattern may contain spaces:
 * `Bash(git commit *)` and `Bash(npm run *)` are the documented norm, and the
 * Claude Code permission dialog writes that space form by default. A naive
 * `/[,\s]+/` split shredded every such pattern into unusable fragments
 * ("Bash(npm", "run", "*)"), silently dropping the grant.
 */
function parseAllowedTools(allowedTools: string | string[] | undefined): string[] | undefined {
  if (!allowedTools) return undefined;
  const raw = Array.isArray(allowedTools) ? allowedTools : splitTopLevel(allowedTools);
  const tools = raw.map(t => t.trim()).filter(Boolean);
  return tools.length > 0 ? tools : undefined;
}

/**
 * Parse SKILL.md frontmatter only (for discovery)
 * Returns SkillInfo or null if invalid
 */
export async function parseSkillFrontmatter(filePath: string): Promise<SkillInfo | null> {
  try {
    const content = await readFile(filePath, 'utf-8');
    const { data } = matter(content, {});

    const parsed = SkillFrontmatterSchema.safeParse(data);
    if (!parsed.success) {
      logger.warn(`Invalid skill "${filePath}": ${formatZodError(parsed.error)}`);
      return null;
    }

    const frontmatter = parsed.data;
    const skillName = frontmatter.name || basename(dirname(filePath));

    return {
      name: skillName,
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
  const { data, content } = matter(fileContent, {});

  const parsed = SkillFrontmatterSchema.safeParse(data);
  if (!parsed.success) {
    throw new Error(`Invalid skill frontmatter: ${formatZodError(parsed.error)}`);
  }

  const frontmatter = parsed.data;
  const skillName = frontmatter.name || basename(dirname(filePath));

  return {
    name: skillName,
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
