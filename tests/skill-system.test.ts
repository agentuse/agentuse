import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'fs/promises';
import { join } from 'path';
import { homedir, tmpdir } from 'os';
import { parseSkillFrontmatter, parseSkillContent } from '../src/skill/parser';
import {
  discoverSkills,
  discoverSkillsInDirectories,
  getSkill,
  getAllSkills,
  getDiscoveryDirectories,
  resetSkillDiscoveryCache,
  setSkillDiscoveryTraversalHookForTest,
} from '../src/skill/discovery';
import { validateAllowedTools, formatToolsWarning } from '../src/skill/validate';
import { createSkillTool, createSkillTools, loadSkillPromptOutputs } from '../src/skill/tool';
import { expandTrustedSkills } from '../src/skill/capabilities';
import type { NormalizedSkillsConfig } from '../src/skill/config';
import type { SkillInfo } from '../src/skill/types';
import { extractSkillCommandMentions } from '../src/skill/command-extract';
import type { ToolsConfig } from '../src/tools/types';
import { logger } from '../src/utils/logger';

describe('Skill System', () => {
  let testDir: string;
  let originalHome: string | undefined;
  let originalConfigDir: string | undefined;

  beforeEach(async () => {
    // Create a temporary directory for test skills
    testDir = await mkdtemp(join(tmpdir(), 'skill-test-'));

    // Mock HOME environment variable to isolate tests from user's global skills
    originalHome = process.env.HOME;
    originalConfigDir = process.env.AGENTUSE_CONFIG_DIR;
    process.env.HOME = testDir;
    delete process.env.AGENTUSE_CONFIG_DIR;
  });

  afterEach(async () => {
    setSkillDiscoveryTraversalHookForTest(undefined);
    resetSkillDiscoveryCache();

    // Restore original HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
    }
    if (originalConfigDir !== undefined) {
      process.env.AGENTUSE_CONFIG_DIR = originalConfigDir;
    } else {
      delete process.env.AGENTUSE_CONFIG_DIR;
    }

    // Clean up temporary directory
    await rm(testDir, { recursive: true, force: true });
  });

  describe('parseSkillFrontmatter', () => {
    it('parses valid skill frontmatter', async () => {
      const skillPath = join(testDir, 'test-skill', 'SKILL.md');
      await mkdir(join(testDir, 'test-skill'));
      await writeFile(skillPath, `---
name: test-skill
description: A test skill
allowed-tools: Read Write Bash
license: MIT
---

# Test Skill Content`);

      const skill = await parseSkillFrontmatter(skillPath);

      expect(skill).toBeDefined();
      expect(skill?.name).toBe('test-skill');
      expect(skill?.description).toBe('A test skill');
      expect(skill?.allowedTools).toEqual(['Read', 'Write', 'Bash']);
      expect(skill?.license).toBe('MIT');
    });

    it('accepts skill with missing description (defaults to empty)', async () => {
      const skillPath = join(testDir, 'invalid-skill', 'SKILL.md');
      await mkdir(join(testDir, 'invalid-skill'));
      await writeFile(skillPath, `---
name: invalid-skill
---

Missing description`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('invalid-skill');
      expect(skill?.description).toBe('');
    });

    it('accepts skill with uppercase and underscore in name', async () => {
      const skillPath = join(testDir, 'Invalid_Skill', 'SKILL.md');
      await mkdir(join(testDir, 'Invalid_Skill'));
      await writeFile(skillPath, `---
name: Invalid_Skill
description: Has uppercase and underscore
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('Invalid_Skill');
    });

    it('rejects skill name with spaces', async () => {
      const skillPath = join(testDir, 'space-skill', 'SKILL.md');
      await mkdir(join(testDir, 'space-skill'));
      await writeFile(skillPath, `---
name: my skill name
description: Has spaces
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeNull();
    });

    it('rejects skill name with forward slash', async () => {
      const skillPath = join(testDir, 'slash-skill', 'SKILL.md');
      await mkdir(join(testDir, 'slash-skill'));
      await writeFile(skillPath, `---
name: my/skill
description: Has forward slash
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeNull();
    });

    it('rejects skill name with backslash', async () => {
      const skillPath = join(testDir, 'backslash-skill', 'SKILL.md');
      await mkdir(join(testDir, 'backslash-skill'));
      await writeFile(skillPath, `---
name: "my\\skill"
description: Has backslash
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeNull();
    });

    it('accepts skill name with consecutive hyphens', async () => {
      const skillPath = join(testDir, 'bad--skill', 'SKILL.md');
      await mkdir(join(testDir, 'bad--skill'));
      await writeFile(skillPath, `---
name: bad--skill
description: Has consecutive hyphens
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('bad--skill');
    });

    it('accepts skill with no frontmatter fields (infers name from directory)', async () => {
      const skillPath = join(testDir, 'bare-skill', 'SKILL.md');
      await mkdir(join(testDir, 'bare-skill'));
      await writeFile(skillPath, `---
---

Just content, no name or description`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('bare-skill');
      expect(skill?.description).toBe('');
    });

    it('accepts skill with no frontmatter at all (infers name from directory)', async () => {
      const skillPath = join(testDir, 'no-frontmatter', 'SKILL.md');
      await mkdir(join(testDir, 'no-frontmatter'));
      await writeFile(skillPath, `# My Skill

Just raw markdown, no YAML frontmatter`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('no-frontmatter');
      expect(skill?.description).toBe('');
    });

    it('accepts skill name with colon namespace', async () => {
      const skillPath = join(testDir, 'lifehack:posthog-query', 'SKILL.md');
      await mkdir(join(testDir, 'lifehack:posthog-query'));
      await writeFile(skillPath, `---
name: lifehack:posthog-query
description: Query PostHog analytics
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('lifehack:posthog-query');
    });

    it('accepts skill name with single hyphen', async () => {
      const skillPath = join(testDir, 'good-skill', 'SKILL.md');
      await mkdir(join(testDir, 'good-skill'));
      await writeFile(skillPath, `---
name: good-skill
description: Valid name with hyphen
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeDefined();
      expect(skill?.name).toBe('good-skill');
    });

    it('parses comma-separated allowed-tools', async () => {
      const skillPath = join(testDir, 'comma-tools', 'SKILL.md');
      await mkdir(join(testDir, 'comma-tools'));
      await writeFile(skillPath, `---
name: comma-tools
description: Tools separated by commas
allowed-tools: Read, Write, Bash
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill?.allowedTools).toEqual(['Read', 'Write', 'Bash']);
    });

    it('keeps spaces inside Bash() patterns when splitting', async () => {
      // `Bash(git commit *)` is the documented norm and the form Claude Code's
      // permission dialog writes by default. A naive /[,\s]+/ split shredded it
      // into "Bash(git", "commit", "*)" and silently dropped the grant.
      const skillPath = join(testDir, 'spaced-tools', 'SKILL.md');
      await mkdir(join(testDir, 'spaced-tools'));
      await writeFile(skillPath, `---
name: spaced-tools
description: Multi-word Bash patterns
allowed-tools: Bash(git add *) Bash(git commit *) Read
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill?.allowedTools).toEqual([
        'Bash(git add *)',
        'Bash(git commit *)',
        'Read',
      ]);
    });

    it('splits comma-separated patterns that themselves contain spaces', async () => {
      const skillPath = join(testDir, 'comma-spaced-tools', 'SKILL.md');
      await mkdir(join(testDir, 'comma-spaced-tools'));
      await writeFile(skillPath, `---
name: comma-spaced-tools
description: Claude Code's comma form with multi-word patterns
allowed-tools: Bash(agent-browser:*), Bash(npx agent-browser:*)
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill?.allowedTools).toEqual([
        'Bash(agent-browser:*)',
        'Bash(npx agent-browser:*)',
      ]);
    });

    it('accepts allowed-tools written as a YAML list', async () => {
      const skillPath = join(testDir, 'list-tools', 'SKILL.md');
      await mkdir(join(testDir, 'list-tools'));
      await writeFile(skillPath, `---
name: list-tools
description: Tools as a YAML list
allowed-tools:
  - Bash(npm run *)
  - Read
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeDefined();
      expect(skill?.allowedTools).toEqual(['Bash(npm run *)', 'Read']);
    });

    it('handles optional metadata fields', async () => {
      const skillPath = join(testDir, 'meta-skill', 'SKILL.md');
      await mkdir(join(testDir, 'meta-skill'));
      await writeFile(skillPath, `---
name: meta-skill
description: Has metadata
compatibility: Node.js >= 18
metadata:
  author: Test Author
  version: "1.0.0"
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill?.compatibility).toBe('Node.js >= 18');
      expect(skill?.metadata).toEqual({
        author: 'Test Author',
        version: '1.0.0',
      });
    });

    it('accepts nested (non-string) metadata values', async () => {
      // We discover `.claude/skills/` for Claude-ecosystem compatibility, and
      // other tools park nested config under `metadata` (e.g. OpenClaw's
      // `metadata.openclaw`). The runtime never reads these keys, so requiring
      // flat strings here rejected the ENTIRE skill over an annotation.
      const skillPath = join(testDir, 'nested-meta-skill', 'SKILL.md');
      await mkdir(join(testDir, 'nested-meta-skill'));
      await writeFile(skillPath, `---
name: nested-meta-skill
description: Carries a foreign tool's nested annotation
metadata:
  author: Test Author
  openclaw:
    emoji: "📰"
    requires:
      optionalEnv:
        - SOME_API_KEY
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);

      expect(skill).toBeDefined();
      expect(skill?.name).toBe('nested-meta-skill');
      expect(skill?.metadata).toEqual({
        author: 'Test Author',
        openclaw: {
          emoji: '📰',
          requires: { optionalEnv: ['SOME_API_KEY'] },
        },
      });
    });
  });

  describe('parseSkillContent', () => {
    it('parses full skill content including body', async () => {
      const skillPath = join(testDir, 'full-skill', 'SKILL.md');
      await mkdir(join(testDir, 'full-skill'));
      const content = `---
name: full-skill
description: Full skill test
---

# Full Skill

This is the skill content body.

## Instructions
1. Do this
2. Do that`;

      await writeFile(skillPath, content);

      const skill = await parseSkillContent(skillPath);

      expect(skill.name).toBe('full-skill');
      expect(skill.content).toContain('# Full Skill');
      expect(skill.content).toContain('This is the skill content body');
      expect(skill.directory).toBe(join(testDir, 'full-skill'));
    });

    it('parses skill with missing description (defaults to empty)', async () => {
      const skillPath = join(testDir, 'bad-skill', 'SKILL.md');
      await mkdir(join(testDir, 'bad-skill'));
      await writeFile(skillPath, `---
name: bad-skill
---

Missing description`);

      const skill = await parseSkillContent(skillPath);
      expect(skill.name).toBe('bad-skill');
      expect(skill.description).toBe('');
    });
  });

  describe('discoverSkills', () => {
    it('rescans when a nested skill is added while discovery is traversing', async () => {
      const group = join(testDir, '.agentuse', 'skills', 'group');
      const existing = join(group, 'existing');
      await mkdir(existing, { recursive: true });
      await writeFile(join(existing, 'SKILL.md'), `---
name: existing-during-scan
description: Existing skill
---

Content`);

      let added = false;
      setSkillDiscoveryTraversalHookForTest(async (dir, phase) => {
        if (dir !== group || phase !== 'after-read' || added) return;
        added = true;
        const late = join(group, 'late');
        await mkdir(late);
        await writeFile(join(late, 'SKILL.md'), `---
name: added-during-scan
description: Added after the directory listing
---

Content`);
      });

      const skills = await discoverSkills(testDir);
      expect(skills.has('existing-during-scan')).toBe(true);
      expect(skills.has('added-during-scan')).toBe(true);
    });

    it('skips unreadable subtrees without hiding readable skills', async () => {
      const root = join(testDir, '.agentuse', 'skills');
      const readable = join(root, 'readable');
      const unreadable = join(root, 'unreadable');
      await mkdir(readable, { recursive: true });
      await mkdir(unreadable);
      await writeFile(join(readable, 'SKILL.md'), `---
name: readable-next-to-unreadable
description: Still discoverable
---

Content`);
      await writeFile(join(unreadable, 'SKILL.md'), `---
name: recovered-readable-skill
description: Visible after permission recovery
---

Content`);

      setSkillDiscoveryTraversalHookForTest((dir, phase) => {
        if (dir !== unreadable || phase !== 'before-read') return;
        const error = new Error('permission denied') as NodeJS.ErrnoException;
        error.code = 'EACCES';
        throw error;
      });

      const skills = await discoverSkills(testDir);
      expect(skills.has('readable-next-to-unreadable')).toBe(true);
      expect(skills.has('recovered-readable-skill')).toBe(false);

      setSkillDiscoveryTraversalHookForTest(undefined);
      const recovered = await discoverSkills(testDir);
      expect(recovered.has('recovered-readable-skill')).toBe(true);
    });

    it('does not activate skills inside hidden directories', async () => {
      const hidden = join(testDir, '.agentuse', 'skills', '.disabled', 'hidden');
      await mkdir(hidden, { recursive: true });
      await writeFile(join(hidden, 'SKILL.md'), `---
name: hidden-disabled-skill
description: Must remain disabled
---

Content`);

      const skills = await discoverSkills(testDir);
      expect(skills.has('hidden-disabled-skill')).toBe(false);
    });

    it('invalidates a warm cache when a nested skill or duplicate is added', async () => {
      const group = join(testDir, '.agentuse', 'skills', 'group');
      const existing = join(group, 'existing');
      await mkdir(existing, { recursive: true });
      await writeFile(join(existing, 'SKILL.md'), `---
name: cached-skill
description: Existing skill
allowed-tools: Bash(cached-command:*)
---

Content`);

      const warmed = await discoverSkills(testDir);
      expect(warmed.get('cached-skill')?.shadowedLocations).toBeUndefined();
      await Bun.sleep(5);

      const added = join(group, 'added');
      await mkdir(added);
      await writeFile(join(added, 'SKILL.md'), `---
name: added-after-cache
description: Added later
---

Content`);
      const duplicate = join(group, 'duplicate');
      await mkdir(duplicate);
      await writeFile(join(duplicate, 'SKILL.md'), `---
name: cached-skill
description: Shadowing duplicate
---

Content`);

      const refreshed = await discoverSkills(testDir);
      expect(refreshed.has('added-after-cache')).toBe(true);
      expect(refreshed.get('cached-skill')?.shadowedLocations).toContain(join(existing, 'SKILL.md'));
      const trustByName: NormalizedSkillsConfig = {
        auto: true,
        trusted: false,
        explicit: { 'cached-skill': { trusted: true } },
      };
      expect(expandTrustedSkills({ bash: { commands: [] } }, refreshed, trustByName)?.bash?.commands).toEqual([]);
    });

    it('discovers skills from .agentuse/skills directory', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      await mkdir(skillsDir, { recursive: true });

      await mkdir(join(skillsDir, 'skill-one'));
      await writeFile(join(skillsDir, 'skill-one', 'SKILL.md'), `---
name: skill-one
description: First skill
---

Content`);

      await mkdir(join(skillsDir, 'skill-two'));
      await writeFile(join(skillsDir, 'skill-two', 'SKILL.md'), `---
name: skill-two
description: Second skill
---

Content`);

      const skills = await discoverSkills(testDir);

      // Note: May include skills from user's global directories, so check presence not count
      expect(skills.size).toBeGreaterThanOrEqual(2);
      expect(skills.has('skill-one')).toBe(true);
      expect(skills.has('skill-two')).toBe(true);
      expect(skills.get('skill-one')?.description).toBe('First skill');
    });

    it('loads skill even when name does not match directory', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      await mkdir(skillsDir, { recursive: true });

      await mkdir(join(skillsDir, 'wrong-dir'));
      await writeFile(join(skillsDir, 'wrong-dir', 'SKILL.md'), `---
name: correct-name
description: Name mismatch
---

Content`);

      const skills = await discoverSkills(testDir);

      expect(skills.has('correct-name')).toBe(true);
      expect(skills.get('correct-name')?.description).toBe('Name mismatch');
    });

    it('discovers skills from nested directories', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills', 'category');
      await mkdir(skillsDir, { recursive: true });

      await mkdir(join(skillsDir, 'nested-skill'));
      await writeFile(join(skillsDir, 'nested-skill', 'SKILL.md'), `---
name: nested-skill
description: Nested skill
---

Content`);

      const skills = await discoverSkills(testDir);

      expect(skills.has('nested-skill')).toBe(true);
    });

    it('includes ~/.agents/skills at lowest precedence', () => {
      const directories = getDiscoveryDirectories(testDir);

      expect(directories.at(-1)).toBe(join(homedir(), '.agents', 'skills'));
    });

    it('uses AGENTUSE_CONFIG_DIR for user-global skills', () => {
      const configDir = join(testDir, 'isolated-config');
      process.env.AGENTUSE_CONFIG_DIR = configDir;

      const directories = getDiscoveryDirectories(testDir);

      expect(directories[1]).toBe(join(configDir, 'skills'));
      expect(directories).not.toContain(join(homedir(), '.agentuse', 'skills'));
    });

    it('follows symlinked skill directories and keeps the visible location', async () => {
      const source = join(testDir, 'source-skill');
      const root = join(testDir, 'skills');
      await mkdir(source);
      await mkdir(root);
      await writeFile(join(source, 'SKILL.md'), `---
name: linked-skill
description: Linked skill
---

Content`);
      await symlink('../source-skill', join(root, 'linked-skill'));

      const skills = await discoverSkillsInDirectories([root]);

      expect(skills.get('linked-skill')?.location).toBe(join(root, 'linked-skill', 'SKILL.md'));
    });

    it('follows a symlinked discovery root', async () => {
      const sourceRoot = join(testDir, 'source-root');
      const linkedRoot = join(testDir, 'linked-root');
      const skillDir = join(sourceRoot, 'root-linked-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), `---
name: root-linked-skill
description: Root-linked skill
---

Content`);
      await symlink(sourceRoot, linkedRoot);

      const skills = await discoverSkillsInDirectories([linkedRoot]);

      expect(skills.get('root-linked-skill')?.location).toBe(
        join(linkedRoot, 'root-linked-skill', 'SKILL.md')
      );
    });

    it('does not traverse a circular skill-directory symlink', async () => {
      const root = join(testDir, 'skills');
      const skillDir = join(root, 'circular-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), `---
name: circular-skill
description: Circular skill
---

Content`);
      await symlink(skillDir, join(skillDir, 'loop'));

      const skills = await discoverSkillsInDirectories([root]);

      expect(skills.get('circular-skill')?.location).toBe(join(skillDir, 'SKILL.md'));
      expect(skills.get('circular-skill')?.shadowedLocations).toBeUndefined();
    });

    it('skips a true two-link symlink cycle without aborting readable skills', async () => {
      const root = join(testDir, 'skills');
      const readable = join(root, 'readable');
      await mkdir(readable, { recursive: true });
      await writeFile(join(readable, 'SKILL.md'), `---
name: readable-beside-cycle
description: Readable beside a true symlink cycle
---

Content`);
      await symlink('second-link', join(root, 'first-link'));
      await symlink('first-link', join(root, 'second-link'));

      const skills = await discoverSkillsInDirectories([root]);

      expect(skills.has('readable-beside-cycle')).toBe(true);
    });

    it('warns and continues past dangling skill symlinks', async () => {
      const root = join(testDir, 'skills');
      await mkdir(root);
      await symlink(join(testDir, 'missing-skill'), join(root, 'dangling-skill'));
      const warnings: string[] = [];
      const originalWarn = logger.warn.bind(logger);
      logger.warn = (message: string) => warnings.push(message);

      try {
        const skills = await discoverSkillsInDirectories([root]);
        expect(skills.has('dangling-skill')).toBe(false);
        expect(warnings).toContain(`Skipping dangling skill symlink: ${join(root, 'dangling-skill')}`);

        const target = join(testDir, 'missing-skill');
        await mkdir(target);
        await writeFile(join(target, 'SKILL.md'), `---
name: recovered-dangling-skill
description: Appeared after the first scan
---

Content`);
        const recovered = await discoverSkillsInDirectories([root]);
        expect(recovered.has('recovered-dangling-skill')).toBe(true);
      } finally {
        logger.warn = originalWarn;
      }
    });

    it('visits the same real skill directory once across compatibility roots', async () => {
      const source = join(testDir, 'source-skill');
      const firstRoot = join(testDir, 'first-root');
      const secondRoot = join(testDir, 'second-root');
      await mkdir(source);
      await mkdir(firstRoot);
      await mkdir(secondRoot);
      await writeFile(join(source, 'SKILL.md'), `---
name: shared-link
description: Shared link
---

Content`);
      await symlink(source, join(firstRoot, 'shared-link'));
      await symlink(source, join(secondRoot, 'shared-link'));

      const skills = await discoverSkillsInDirectories([firstRoot, secondRoot]);

      expect(skills.get('shared-link')?.location).toBe(join(firstRoot, 'shared-link', 'SKILL.md'));
      expect(skills.get('shared-link')?.shadowedLocations).toBeUndefined();
    });

    it('returns skills map (may include global skills)', async () => {
      const skills = await discoverSkills(testDir);
      // May include skills from user's global directories
      expect(skills).toBeInstanceOf(Map);
    });

    it('warns on duplicate skill names and uses first found', async () => {
      const agentUseDir = join(testDir, '.agentuse', 'skills');
      const claudeDir = join(testDir, '.claude', 'skills');

      await mkdir(agentUseDir, { recursive: true });
      await mkdir(claudeDir, { recursive: true });

      // Create same skill in two locations with unique name to avoid conflicts
      const uniqueName = `duplicate-test-${Date.now()}`;
      await mkdir(join(agentUseDir, uniqueName));
      await writeFile(join(agentUseDir, uniqueName, 'SKILL.md'), `---
name: ${uniqueName}
description: First duplicate
allowed-tools: Bash(project-shadow-command:*)
---

Content 1`);

      await mkdir(join(claudeDir, uniqueName));
      await writeFile(join(claudeDir, uniqueName, 'SKILL.md'), `---
name: ${uniqueName}
description: Second duplicate
---

Content 2`);

      const skills = await discoverSkills(testDir);

      expect(skills.has(uniqueName)).toBe(true);
      expect(skills.get(uniqueName)?.description).toBe('First duplicate');
      expect(skills.get(uniqueName)?.shadowedLocations).toContain(
        join(claudeDir, uniqueName, 'SKILL.md')
      );
      const trustByName: NormalizedSkillsConfig = {
        auto: true,
        trusted: false,
        explicit: { [uniqueName]: { trusted: true } },
      };
      expect(expandTrustedSkills(
        { bash: { commands: [] } },
        skills,
        trustByName
      )?.bash?.commands).toEqual([]);
    });
  });

  describe('getSkill', () => {
    it('retrieves specific skill by name', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      await mkdir(skillsDir, { recursive: true });

      await mkdir(join(skillsDir, 'target-skill'));
      await writeFile(join(skillsDir, 'target-skill', 'SKILL.md'), `---
name: target-skill
description: Target skill
---

Content`);

      const skill = await getSkill('target-skill', testDir);

      expect(skill).toBeDefined();
      expect(skill?.name).toBe('target-skill');
    });

    it('returns undefined for non-existent skill', async () => {
      const skill = await getSkill('non-existent', testDir);
      expect(skill).toBeUndefined();
    });
  });

  describe('getAllSkills', () => {
    it('returns array of all discovered skills', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      await mkdir(skillsDir, { recursive: true });

      const uniqueA = `skill-a-${Date.now()}`;
      const uniqueB = `skill-b-${Date.now()}`;

      await mkdir(join(skillsDir, uniqueA));
      await writeFile(join(skillsDir, uniqueA, 'SKILL.md'), `---
name: ${uniqueA}
description: Skill A
---

Content`);

      await mkdir(join(skillsDir, uniqueB));
      await writeFile(join(skillsDir, uniqueB, 'SKILL.md'), `---
name: ${uniqueB}
description: Skill B
---

Content`);

      const skills = await getAllSkills(testDir);

      expect(skills.length).toBeGreaterThanOrEqual(2);
      const skillNames = skills.map(s => s.name);
      expect(skillNames).toContain(uniqueA);
      expect(skillNames).toContain(uniqueB);
    });
  });

  describe('validateAllowedTools', () => {
    it('returns empty array when all tools are satisfied', () => {
      const allowedTools = ['Read', 'Write'];
      const toolsConfig: ToolsConfig = {
        filesystem: [
          {
            paths: ['/workspace'],
            permissions: ['read', 'write'],
          },
        ],
      };

      const unsatisfied = validateAllowedTools(allowedTools, toolsConfig);
      expect(unsatisfied).toEqual([]);
    });

    it('detects missing Read permission', () => {
      const allowedTools = ['Read'];
      const toolsConfig: ToolsConfig = {
        filesystem: [
          {
            paths: ['/workspace'],
            permissions: ['write'],
          },
        ],
      };

      const unsatisfied = validateAllowedTools(allowedTools, toolsConfig);
      expect(unsatisfied.length).toBe(1);
      expect(unsatisfied[0].pattern).toBe('Read');
      expect(unsatisfied[0].satisfied).toBe(false);
    });

    it('detects missing Write permission', () => {
      const allowedTools = ['Write'];
      const toolsConfig: ToolsConfig = {
        filesystem: [
          {
            paths: ['/workspace'],
            permissions: ['read'],
          },
        ],
      };

      const unsatisfied = validateAllowedTools(allowedTools, toolsConfig);
      expect(unsatisfied.length).toBe(1);
      expect(unsatisfied[0].pattern).toBe('Write');
    });

    it('validates Bash tool configuration', () => {
      const allowedTools = ['Bash'];
      const toolsConfig: ToolsConfig = {
        bash: {
          commands: ['git *', 'npm *'],
        },
      };

      const unsatisfied = validateAllowedTools(allowedTools, toolsConfig);
      expect(unsatisfied).toEqual([]);
    });

    it('detects missing Bash configuration', () => {
      const allowedTools = ['Bash'];
      const toolsConfig: ToolsConfig = {};

      const unsatisfied = validateAllowedTools(allowedTools, toolsConfig);
      expect(unsatisfied.length).toBe(1);
      expect(unsatisfied[0].pattern).toBe('Bash');
    });

    it('validates Bash command patterns like Bash(git:*)', () => {
      const allowedTools = ['Bash(git:*)'];
      const toolsConfig: ToolsConfig = {
        bash: {
          commands: ['git status', 'git diff'],
        },
      };

      const unsatisfied = validateAllowedTools(allowedTools, toolsConfig);
      expect(unsatisfied).toEqual([]);
    });

    it('detects missing Bash command', () => {
      const allowedTools = ['Bash(python3:*)'];
      const toolsConfig: ToolsConfig = {
        bash: {
          commands: ['git *'],
        },
      };

      const unsatisfied = validateAllowedTools(allowedTools, toolsConfig);
      expect(unsatisfied.length).toBe(1);
      expect(unsatisfied[0].pattern).toBe('Bash(python3:*)');
    });

    it('returns empty array when allowedTools is undefined', () => {
      const unsatisfied = validateAllowedTools(undefined, {});
      expect(unsatisfied).toEqual([]);
    });

    it('assumes unknown patterns are satisfied and warns', () => {
      const allowedTools = ['UnknownTool'];
      const toolsConfig: ToolsConfig = {};

      // Capture warnings
      const warnings: string[] = [];
      const originalWarn = logger.warn.bind(logger);
      logger.warn = (message: string) => {
        warnings.push(message);
      };

      try {
        const unsatisfied = validateAllowedTools(allowedTools, toolsConfig);

        // Should not block execution (satisfied: true)
        expect(unsatisfied).toEqual([]);

        // But should have logged a warning
        expect(warnings.length).toBeGreaterThan(0);
        expect(warnings.some(w => w.includes('Unknown tool pattern'))).toBe(true);
        expect(warnings.some(w => w.includes('UnknownTool'))).toBe(true);
      } finally {
        logger.warn = originalWarn;
      }
    });
  });

  describe('formatToolsWarning', () => {
    it('returns null when no unsatisfied tools', () => {
      const warning = formatToolsWarning([]);
      expect(warning).toBeNull();
    });

    it('formats warning message for unsatisfied tools', () => {
      const unsatisfied = [
        { pattern: 'Read', satisfied: false, reason: 'Filesystem read permission not configured' },
        { pattern: 'Bash', satisfied: false, reason: 'Bash tool not configured for this agent' },
      ];

      const warning = formatToolsWarning(unsatisfied);

      expect(warning).toContain('WARNING: Required tools not available');
      expect(warning).toContain('Read: Filesystem read permission not configured');
      expect(warning).toContain('Bash: Bash tool not configured for this agent');
    });

    it('includes bash configuration example when Bash is unsatisfied', () => {
      const unsatisfied = [
        { pattern: 'Bash', satisfied: false, reason: 'Bash tool not configured' },
      ];

      const warning = formatToolsWarning(unsatisfied);

      expect(warning).toContain('To enable bash, add to your agent YAML:');
      expect(warning).toContain('tools:');
      expect(warning).toContain('bash:');
    });
  });

  describe('createSkillTool', () => {
    it('creates skill tool with discovered skills', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      await mkdir(skillsDir, { recursive: true });

      const uniqueName = `test-skill-${Date.now()}`;
      await mkdir(join(skillsDir, uniqueName));
      await writeFile(join(skillsDir, uniqueName, 'SKILL.md'), `---
name: ${uniqueName}
description: A test skill
---

# Test Skill Content`);

      const { tool, skills } = await createSkillTool(testDir, undefined);

      expect(skills.length).toBeGreaterThanOrEqual(1);
      const testSkill = skills.find(s => s.name === uniqueName);
      expect(testSkill).toBeDefined();
      expect(testSkill?.description).toBe('A test skill');
      expect(tool.description).toContain(uniqueName);
      expect(tool.description).toContain('A test skill');
    });

    it('executes skill tool and returns content', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      await mkdir(skillsDir, { recursive: true });

      await mkdir(join(skillsDir, 'executable-skill'));
      await writeFile(join(skillsDir, 'executable-skill', 'SKILL.md'), `---
name: executable-skill
description: Can be executed
---

# Skill Instructions

Do this and that.`);

      const { tool } = await createSkillTool(testDir, undefined);

      const result = await tool.execute!({ name: 'executable-skill' });

      expect(result).toContain('# Skill Instructions');
      expect(result).toContain('Do this and that');
      expect(result).toContain('Base directory');
    });

    it('substitutes supported skill directory placeholders in loaded content', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      const skillDir = join(skillsDir, 'portable-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), `---
name: portable-skill
description: Uses portable paths
---

# Portable Skill

- Legacy: \${skillDir}/scripts/legacy.sh
- Generic: \${SKILL_DIR}/scripts/generic.sh
- Claude: \${CLAUDE_SKILL_DIR}/scripts/claude.sh
- Literal: $SKILL_DIR/scripts/runtime.sh`);

      const { tool } = await createSkillTool(testDir, undefined);

      const result = await tool.execute!({ name: 'portable-skill' });

      expect(result).toContain(`Legacy: ${skillDir}/scripts/legacy.sh`);
      expect(result).toContain(`Generic: ${skillDir}/scripts/generic.sh`);
      expect(result).toContain(`Claude: ${skillDir}/scripts/claude.sh`);
      expect(result).toContain('Literal: $SKILL_DIR/scripts/runtime.sh');
      expect(result).not.toContain('${skillDir}');
      expect(result).not.toContain('${SKILL_DIR}');
      expect(result).not.toContain('${CLAUDE_SKILL_DIR}');
    });

    it('throws error when skill not found', async () => {
      const { tool } = await createSkillTool(testDir, undefined);

      expect(async () => {
        await tool.execute!({ name: 'non-existent' });
      }).toThrow('Skill "non-existent" not found');
    });

    it('includes warning when required tools are missing', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      await mkdir(skillsDir, { recursive: true });

      await mkdir(join(skillsDir, 'tool-skill'));
      await writeFile(join(skillsDir, 'tool-skill', 'SKILL.md'), `---
name: tool-skill
description: Requires tools
allowed-tools: Read Write Bash
---

Content`);

      const toolsConfig: ToolsConfig = {}; // No tools configured

      const { tool } = await createSkillTool(testDir, toolsConfig);
      const result = await tool.execute!({ name: 'tool-skill' });

      expect(result).toContain('⚠️ WARNING');
      expect(result).toContain('Read');
      expect(result).toContain('Write');
      expect(result).toContain('Bash');
    });

    it('does not include warning when all required tools are available', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      await mkdir(skillsDir, { recursive: true });

      await mkdir(join(skillsDir, 'safe-skill'));
      await writeFile(join(skillsDir, 'safe-skill', 'SKILL.md'), `---
name: safe-skill
description: All tools available
allowed-tools: Read Write
---

Content`);

      const toolsConfig: ToolsConfig = {
        filesystem: [
          {
            paths: ['/workspace'],
            permissions: ['read', 'write'],
          },
        ],
      };

      const { tool } = await createSkillTool(testDir, toolsConfig);
      const result = await tool.execute!({ name: 'safe-skill' });

      expect(result).not.toContain('⚠️ WARNING');
    });

    it('limits on-demand skills to explicit skills when auto is false', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      await mkdir(join(skillsDir, 'visible-skill'), { recursive: true });
      await writeFile(join(skillsDir, 'visible-skill', 'SKILL.md'), `---
name: visible-skill
description: Visible
---

Visible content`);

      await mkdir(join(skillsDir, 'hidden-skill'), { recursive: true });
      await writeFile(join(skillsDir, 'hidden-skill', 'SKILL.md'), `---
name: hidden-skill
description: Hidden
---

Hidden content`);

      const { skillTool, skills } = await createSkillTools(testDir, undefined, {
        auto: false,
        explicitSkillNames: ['visible-skill'],
      });

      expect(skills.map((skill) => skill.name)).toEqual(['visible-skill']);
      expect(skillTool.description).toContain('visible-skill');
      expect(skillTool.description).not.toContain('hidden-skill');
      await expect(skillTool.execute!({ name: 'hidden-skill' })).rejects.toThrow('Skill "hidden-skill" not found');
    });

    it('preloads explicit skill prompt output', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      const skillDir = join(skillsDir, 'preload-skill');
      await mkdir(skillDir, { recursive: true });
      await writeFile(join(skillDir, 'SKILL.md'), `---
name: preload-skill
description: Preloaded
---

# Preloaded Instructions`);

      const outputs = await loadSkillPromptOutputs(testDir, undefined, ['preload-skill']);

      expect(outputs).toHaveLength(1);
      expect(outputs[0].name).toBe('preload-skill');
      expect(outputs[0].output).toContain('# Preloaded Instructions');
      expect(outputs[0].output).toContain(`**Base directory**: ${skillDir}`);
    });
  });

  describe('trust expansion preserves bash config (agentuse-lab#168)', () => {
    // Grant behavior (per-skill/global/none) is covered in skill-trust.test.ts;
    // here we pin the bash-config preservation the old expandSkillAllows tested.
    const skillsMap = new Map<string, SkillInfo>([
      ['browser', { name: 'browser', description: 'b', location: '/s/browser/SKILL.md', allowedTools: ['Bash(agent-browser:*)'] }],
    ]);
    const trust = (name: string): NormalizedSkillsConfig => ({ auto: true, trusted: false, explicit: { [name]: { trusted: true } } });
    const UNTRUSTED: NormalizedSkillsConfig = { auto: true, trusted: false, explicit: {} };

    it('merges granted commands while preserving allowedPaths and timeout', () => {
      const baseConfig = {
        bash: {
          commands: ['git *'],
          allowedPaths: ['/tmp', '~/workspace'],
          timeout: 60000,
        },
      };

      const config = expandTrustedSkills(baseConfig, skillsMap, trust('browser'));

      expect(config?.bash?.commands).toEqual(['git *', 'agent-browser *']);
      expect(config?.bash?.allowedPaths).toEqual(['/tmp', '~/workspace']);
      expect(config?.bash?.timeout).toBe(60000);
      expect(config?.bash?.commands).not.toBe(baseConfig.bash.commands);
    });

    it('returns baseConfig unchanged when nothing is trusted', () => {
      const baseConfig = { bash: { commands: ['git *'] } };
      expect(expandTrustedSkills(baseConfig, skillsMap, UNTRUSTED)).toBe(baseConfig);
    });

    it('does not append a duplicate when the grant already matches an existing pattern', () => {
      const baseConfig = { bash: { commands: ['agent-browser *'] } };
      // Trust would grant `agent-browser *`, which is already present, so the
      // config is returned unchanged (nothing new to add).
      expect(expandTrustedSkills(baseConfig, skillsMap, trust('browser'))).toBe(baseConfig);
    });
  });

  describe('extractSkillCommandMentions', () => {
    it('extracts command families from shell snippets, pipes, and command substitution', async () => {
      const mentions = await extractSkillCommandMentions({
        name: 'browser-skill',
        description: 'Browser skill',
        location: join(testDir, 'SKILL.md'),
        directory: testDir,
        allowedTools: ['Bash(git:*)'],
        content: [
          '```bash',
          'agent-browser snapshot | grep "Post"',
          'agent-browser eval "$(cat scripts/feed.js)"',
          '```',
          'Run `python3 scripts/check.py` after extraction.',
          'Ignore `window.AUTHOR` and `.claude/skills/foo` inline code.',
        ].join('\n'),
      });

      expect(mentions.map((mention) => mention.command)).toEqual([
        'agent-browser',
        'cat',
        'git',
        'grep',
        'python3',
      ]);
    });
  });
});
