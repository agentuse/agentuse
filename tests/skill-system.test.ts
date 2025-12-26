import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { parseSkillFrontmatter, parseSkillContent } from '../src/skill/parser';
import { discoverSkills, getSkill, getAllSkills } from '../src/skill/discovery';
import { validateAllowedTools, formatToolsWarning } from '../src/skill/validate';
import { createSkillTool } from '../src/skill/tool';
import type { ToolsConfig } from '../src/tools/types';

describe('Skill System', () => {
  let testDir: string;
  let originalHome: string | undefined;

  beforeEach(async () => {
    // Create a temporary directory for test skills
    testDir = await mkdtemp(join(tmpdir(), 'skill-test-'));

    // Mock HOME environment variable to isolate tests from user's global skills
    originalHome = process.env.HOME;
    process.env.HOME = testDir;
  });

  afterEach(async () => {
    // Restore original HOME
    if (originalHome !== undefined) {
      process.env.HOME = originalHome;
    } else {
      delete process.env.HOME;
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

    it('rejects skill with missing required fields', async () => {
      const skillPath = join(testDir, 'invalid-skill', 'SKILL.md');
      await mkdir(join(testDir, 'invalid-skill'));
      await writeFile(skillPath, `---
name: invalid-skill
---

Missing description`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeNull();
    });

    it('rejects skill with invalid name format', async () => {
      const skillPath = join(testDir, 'Invalid_Skill', 'SKILL.md');
      await mkdir(join(testDir, 'Invalid_Skill'));
      await writeFile(skillPath, `---
name: Invalid_Skill
description: Has uppercase and underscore
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeNull();
    });

    it('rejects skill name with consecutive hyphens', async () => {
      const skillPath = join(testDir, 'bad--skill', 'SKILL.md');
      await mkdir(join(testDir, 'bad--skill'));
      await writeFile(skillPath, `---
name: bad--skill
description: Has consecutive hyphens
---

Content`);

      const skill = await parseSkillFrontmatter(skillPath);
      expect(skill).toBeNull();
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

    it('throws on invalid frontmatter', async () => {
      const skillPath = join(testDir, 'bad-skill', 'SKILL.md');
      await mkdir(join(testDir, 'bad-skill'));
      await writeFile(skillPath, `---
name: bad-skill
---

Missing description`);

      expect(async () => {
        await parseSkillContent(skillPath);
      }).toThrow();
    });
  });

  describe('discoverSkills', () => {
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

    it('warns when skill name does not match directory', async () => {
      const skillsDir = join(testDir, '.agentuse', 'skills');
      await mkdir(skillsDir, { recursive: true });

      await mkdir(join(skillsDir, 'wrong-dir'));
      await writeFile(join(skillsDir, 'wrong-dir', 'SKILL.md'), `---
name: correct-name
description: Name mismatch
---

Content`);

      const skills = await discoverSkills(testDir);

      // Should not include skill with mismatched name
      expect(skills.has('correct-name')).toBe(false);
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

    it('assumes unknown patterns are satisfied', () => {
      const allowedTools = ['UnknownTool'];
      const toolsConfig: ToolsConfig = {};

      const unsatisfied = validateAllowedTools(allowedTools, toolsConfig);
      expect(unsatisfied).toEqual([]);
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
  });
});
