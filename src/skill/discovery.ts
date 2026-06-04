import { glob } from 'glob';
import { homedir } from 'os';
import { join } from 'path';
import { access } from 'fs/promises';
import { parseSkillFrontmatter } from './parser.js';
import type { SkillInfo } from './types.js';
import { logger } from '../utils/logger.js';

/**
 * Skill discovery directories in priority order:
 * 1. .agentuse/skills/ - Project-local
 * 2. ~/.agentuse/skills/ - User-global
 * 3. .claude/skills/ - Claude ecosystem compatibility
 */
export function getDiscoveryDirectories(projectRoot: string): string[] {
  const home = homedir();
  return [
    join(projectRoot, '.agentuse', 'skills'),
    join(home, '.agentuse', 'skills'),
    join(projectRoot, '.claude', 'skills'),
    join(home, '.claude', 'skills'),
  ];
}

/**
 * Check if a directory exists
 */
async function directoryExists(dir: string): Promise<boolean> {
  try {
    await access(dir);
    return true;
  } catch {
    return false;
  }
}

async function discoverSkillsFromDirectories(directories: string[]): Promise<Map<string, SkillInfo>> {
  const skills = new Map<string, SkillInfo>();

  for (const dir of directories) {
    if (!await directoryExists(dir)) {
      continue;
    }

    const pattern = join(dir, '**/SKILL.md');
    const matches = await glob(pattern, { absolute: true });

    for (const match of matches) {
      const skill = await parseSkillFrontmatter(match);
      if (!skill) continue;

      // Warn if explicit name differs from directory, but still load it.
      const dirName = match.split('/').slice(-2, -1)[0];
      if (dirName !== skill.name) {
        logger.debug(`Skill name "${skill.name}" differs from directory "${dirName}" in ${match}`);
      }

      // Warn on duplicate skill names
      if (skills.has(skill.name)) {
        logger.warn(`Duplicate skill name "${skill.name}". Using first found: ${skills.get(skill.name)!.location}`);
        continue;
      }

      skills.set(skill.name, skill);
    }
  }

  return skills;
}

/**
 * Discover all skills from configured directories
 * Returns map of skill name to SkillInfo
 */
export async function discoverSkills(projectRoot: string): Promise<Map<string, SkillInfo>> {
  return discoverSkillsFromDirectories(getDiscoveryDirectories(projectRoot));
}

/**
 * Discover all skills from explicit directories.
 */
export async function discoverSkillsInDirectories(directories: string[]): Promise<Map<string, SkillInfo>> {
  return discoverSkillsFromDirectories(directories);
}

/**
 * Get a specific skill by name
 */
export async function getSkill(
  name: string,
  projectRoot: string
): Promise<SkillInfo | undefined> {
  const skills = await discoverSkills(projectRoot);
  return skills.get(name);
}

/**
 * Get all discovered skills as array
 */
export async function getAllSkills(projectRoot: string): Promise<SkillInfo[]> {
  const skills = await discoverSkills(projectRoot);
  return Array.from(skills.values());
}
