import { glob } from 'glob';
import { homedir } from 'os';
import { join } from 'path';
import { access, stat } from 'fs/promises';
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

interface DiscoveryCacheEntry {
  skills: Map<string, SkillInfo>;
  /** Every SKILL.md the scan touched, winners and shadowed duplicates alike. */
  locations: string[];
  stamp: string;
}

// A run discovers skills 4x, plus 2x per subagent invocation, and `agentuse
// serve` keeps doing it for the life of the daemon. Bounded because a daemon
// serves many project roots.
const MAX_CACHED_DISCOVERIES = 32;
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/**
 * Cheap fingerprint of a set of paths: mtime + size, or a miss marker when the
 * path is gone. Statting the search roots catches skills being added or removed;
 * statting the SKILL.md files themselves catches edits, which a directory mtime
 * does not see.
 */
async function mtimeStamp(paths: string[]): Promise<string> {
  const stamps = await Promise.all(paths.map(async (path) => {
    try {
      const info = await stat(path);
      return `${path}:${info.mtimeMs}:${info.size}`;
    } catch {
      return `${path}:-`;
    }
  }));
  return stamps.join('|');
}

async function scanSkillDirectories(directories: string[]): Promise<Map<string, SkillInfo>> {
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
        const selected = skills.get(skill.name)!;
        selected.shadowedLocations = [
          ...(selected.shadowedLocations ?? []),
          skill.location,
        ];
        logger.warn(
          `Duplicate skill name "${skill.name}". Using first found: ${selected.location}. ` +
          `Per-skill trust grants are disabled for this ambiguous name.`
        );
        continue;
      }

      skills.set(skill.name, skill);
    }
  }

  return skills;
}

/**
 * Scan, memoized against the mtimes of the search roots and of every SKILL.md
 * the last scan found. A globbed re-parse of the whole tree per call is the
 * dominant cost of tool loading; the stamp check is a handful of stats and is
 * re-run on every call, so a long-lived `serve` process still picks up a skill
 * that was added, edited, or removed underneath it.
 */
async function discoverSkillsFromDirectories(directories: string[]): Promise<Map<string, SkillInfo>> {
  const key = directories.join('\u0000');
  const cached = discoveryCache.get(key);
  if (cached) {
    const stamp = `${await mtimeStamp(directories)}|${await mtimeStamp(cached.locations)}`;
    if (stamp === cached.stamp) return new Map(cached.skills);
  }

  // Stamped before the scan so a skill added while it runs invalidates the
  // entry instead of being fingerprinted as already-seen.
  const rootStamp = await mtimeStamp(directories);
  const skills = await scanSkillDirectories(directories);
  const locations = Array.from(skills.values()).flatMap(
    (skill) => [skill.location, ...(skill.shadowedLocations ?? [])]
  );

  discoveryCache.delete(key);
  discoveryCache.set(key, {
    skills,
    locations,
    stamp: `${rootStamp}|${await mtimeStamp(locations)}`,
  });
  if (discoveryCache.size > MAX_CACHED_DISCOVERIES) {
    discoveryCache.delete(discoveryCache.keys().next().value!);
  }

  // Copied so a caller mutating the map it gets back cannot corrupt the cache.
  return new Map(skills);
}

/** Test seam: forget every memoized discovery. */
export function resetSkillDiscoveryCache(): void {
  discoveryCache.clear();
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
