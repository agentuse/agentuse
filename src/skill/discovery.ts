import { homedir } from 'os';
import { join } from 'path';
import { readdir, realpath, stat } from 'fs/promises';
import { parseSkillFrontmatter } from './parser.js';
import type { SkillInfo } from './types.js';
import { logger } from '../utils/logger.js';
import { getGlobalConfigDir } from '../utils/global-config.js';

/**
 * Skill discovery directories in priority order:
 * 1. .agentuse/skills/ - Project-local
 * 2. $AGENTUSE_CONFIG_DIR/skills/ - User-global (defaults to ~/.agentuse/skills/)
 * 3. .claude/skills/ - Claude ecosystem compatibility
 * 4. ~/.claude/skills/ - Claude ecosystem compatibility
 * 5. ~/.agents/skills/ - Shared agent skills compatibility
 */
export function getDiscoveryDirectories(projectRoot: string): string[] {
  const home = homedir();
  return [
    join(projectRoot, '.agentuse', 'skills'),
    join(getGlobalConfigDir(), 'skills'),
    join(projectRoot, '.claude', 'skills'),
    join(home, '.claude', 'skills'),
    join(home, '.agents', 'skills'),
  ];
}

interface DiscoveryCacheEntry {
  skills: Map<string, SkillInfo>;
  /** Every SKILL.md the scan touched, winners and shadowed duplicates alike. */
  locations: string[];
  /** Every directory traversed. A child addition changes its parent's mtime. */
  directories: string[];
  stamp: string;
}

// A run discovers skills 4x, plus 2x per subagent invocation, and `agentuse
// serve` keeps doing it for the life of the daemon. Bounded because a daemon
// serves many project roots.
const MAX_CACHED_DISCOVERIES = 32;
const discoveryCache = new Map<string, DiscoveryCacheEntry>();

/**
 * Cheap fingerprint of a set of paths: mtime + ctime + mode + size, or a miss
 * marker when the path is gone. Statting the search roots catches skills being
 * added, removed, or made readable; statting the SKILL.md files themselves
 * catches edits, which a directory mtime does not see.
 */
async function mtimeStamp(paths: string[]): Promise<string> {
  const stamps = await Promise.all(paths.map(pathStamp));
  return stamps.join('|');
}

async function pathStamp(path: string): Promise<string> {
  try {
    const info = await stat(path);
    return `${path}:${info.mtimeMs}:${info.ctimeMs}:${info.mode}:${info.size}`;
  } catch {
    return `${path}:-`;
  }
}

type TraversalPhase = 'before-read' | 'after-read';
let traversalHookForTest:
  | ((dir: string, phase: TraversalPhase) => void | Promise<void>)
  | undefined;

async function findSkillFiles(
  dir: string,
  traversed: string[],
  observedDirectoryStamps: string[],
  matches: string[],
  scanState: { cacheable: boolean; visitedRealDirectories: Set<string> }
): Promise<void> {
  const realDir = await realpath(dir).catch(() => undefined);
  if (realDir && scanState.visitedRealDirectories.has(realDir)) return;

  const observedStamp = await pathStamp(dir);
  let entries;
  try {
    await traversalHookForTest?.(dir, 'before-read');
    entries = await readdir(dir, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') return;
    if (code === 'ELOOP') {
      scanState.cacheable = false;
      logger.warn(`Skipping circular skill symlink: ${dir}`);
      return;
    }
    if (code === 'EACCES' || code === 'EPERM') {
      scanState.cacheable = false;
      logger.warn(`Skipping unreadable skill directory: ${dir}`);
      return;
    }
    throw error;
  }
  if (realDir) scanState.visitedRealDirectories.add(realDir);
  traversed.push(dir);
  observedDirectoryStamps.push(observedStamp);
  await traversalHookForTest?.(dir, 'after-read');
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const path = join(dir, entry.name);
    let isDirectory = entry.isDirectory();
    let isFile = entry.isFile();
    if (entry.isSymbolicLink()) {
      try {
        const target = await stat(path);
        isDirectory = target.isDirectory();
        isFile = target.isFile();
      } catch (error) {
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT') {
          scanState.cacheable = false;
          logger.warn(`Skipping dangling skill symlink: ${path}`);
          continue;
        }
        if (code === 'ELOOP') {
          scanState.cacheable = false;
          logger.warn(`Skipping circular skill symlink: ${path}`);
          continue;
        }
        if (code === 'EACCES' || code === 'EPERM') {
          scanState.cacheable = false;
          logger.warn(`Skipping unreadable skill symlink: ${path}`);
          continue;
        }
        throw error;
      }
    }
    if (isDirectory) {
      // Preserve glob's default behavior: hidden directories are not active
      // skill sources merely because they sit below a configured root.
      if (entry.name.startsWith('.')) continue;
      await findSkillFiles(path, traversed, observedDirectoryStamps, matches, scanState);
    }
    else if (isFile && entry.name === 'SKILL.md') matches.push(path);
  }
}

async function scanSkillDirectories(
  directories: string[]
): Promise<{
  skills: Map<string, SkillInfo>;
  traversed: string[];
  locations: string[];
  observedDirectoryStamp: string;
  observedLocationStamp: string;
  cacheable: boolean;
}> {
  const skills = new Map<string, SkillInfo>();
  const traversed: string[] = [];
  const observedDirectoryStamps: string[] = [];
  const locations: string[] = [];
  const observedLocationStamps: string[] = [];
  const scanState = { cacheable: true, visitedRealDirectories: new Set<string>() };

  for (const dir of directories) {
    const matches: string[] = [];
    await findSkillFiles(dir, traversed, observedDirectoryStamps, matches, scanState);

    for (const match of matches) {
      locations.push(match);
      observedLocationStamps.push(await pathStamp(match));
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

  return {
    skills,
    traversed,
    locations,
    observedDirectoryStamp: observedDirectoryStamps.join('|'),
    observedLocationStamp: observedLocationStamps.join('|'),
    cacheable: scanState.cacheable,
  };
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
    const stamp = `${await mtimeStamp(directories)}|${await mtimeStamp(cached.directories)}|${await mtimeStamp(cached.locations)}`;
    if (stamp === cached.stamp) return new Map(cached.skills);
  }

  // Capture each path before it is traversed or parsed, then compare that
  // observation with the filesystem after the scan. If the tree changed in
  // between, retry rather than caching an incomplete snapshot.
  let lastSkills = new Map<string, SkillInfo>();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const rootStamp = await mtimeStamp(directories);
    const scan = await scanSkillDirectories(directories);
    lastSkills = scan.skills;
    if (!scan.cacheable) return new Map(scan.skills);
    const observedStamp = `${rootStamp}|${scan.observedDirectoryStamp}|${scan.observedLocationStamp}`;
    const currentStamp = `${await mtimeStamp(directories)}|${await mtimeStamp(scan.traversed)}|${await mtimeStamp(scan.locations)}`;
    if (observedStamp !== currentStamp) continue;

    discoveryCache.delete(key);
    discoveryCache.set(key, {
      skills: scan.skills,
      locations: scan.locations,
      directories: scan.traversed,
      stamp: currentStamp,
    });
    if (discoveryCache.size > MAX_CACHED_DISCOVERIES) {
      discoveryCache.delete(discoveryCache.keys().next().value!);
    }
    return new Map(scan.skills);
  }

  // A continuously changing tree may not yield a stable snapshot. Return the
  // latest result, but deliberately do not memoize it so the next call retries.
  return new Map(lastSkills);
}

/** Test seam: forget every memoized discovery. */
export function resetSkillDiscoveryCache(): void {
  discoveryCache.clear();
}

/** Test seam for deterministic mutations between readdir and traversal. */
export function setSkillDiscoveryTraversalHookForTest(
  hook: ((dir: string, phase: TraversalPhase) => void | Promise<void>) | undefined
): void {
  traversalHookForTest = hook;
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
