import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import { mkdtemp, writeFile, mkdir, rm, readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { resolveSource, add } from '../src/cli/add';

describe('agentuse add', () => {
  let projectDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'add-test-project-'));
    sourceDir = await mkdtemp(join(tmpdir(), 'add-test-source-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(sourceDir, { recursive: true, force: true });
  });

  describe('resolveSource', () => {
    it('resolves github shorthand', () => {
      const result = resolveSource('user/repo');
      expect(result.type).toBe('github');
      expect(result.path).toBe('https://github.com/user/repo.git');
      expect(result.needsClone).toBe(true);
    });

    it('resolves github shorthand with ref', () => {
      const result = resolveSource('user/repo#v1.0.0');
      expect(result.type).toBe('github');
      expect(result.path).toBe('https://github.com/user/repo.git');
      expect(result.ref).toBe('v1.0.0');
      expect(result.needsClone).toBe(true);
    });

    it('resolves https git URL', () => {
      const result = resolveSource('https://github.com/user/repo.git');
      expect(result.type).toBe('git');
      expect(result.path).toBe('https://github.com/user/repo.git');
      expect(result.needsClone).toBe(true);
    });

    it('resolves git@ URL', () => {
      const result = resolveSource('git@github.com:user/repo.git');
      expect(result.type).toBe('git');
      expect(result.path).toBe('git@github.com:user/repo.git');
      expect(result.needsClone).toBe(true);
    });

    it('resolves local path starting with ./', async () => {
      const result = resolveSource('./some/path');
      expect(result.type).toBe('local');
      expect(result.needsClone).toBe(false);
    });

    it('resolves local path starting with /', async () => {
      const result = resolveSource('/absolute/path');
      expect(result.type).toBe('local');
      expect(result.needsClone).toBe(false);
    });

    it('resolves direct skill path', async () => {
      // Create a skill directory
      await mkdir(join(sourceDir, 'my-skill'));
      await writeFile(join(sourceDir, 'my-skill', 'SKILL.md'), '---\nname: my-skill\n---');

      const result = resolveSource(join(sourceDir, 'my-skill'));
      expect(result.type).toBe('skill');
      expect(result.needsClone).toBe(false);
    });
  });

  describe('add - local skills', () => {
    it('copies skill from skills/ directory', async () => {
      await mkdir(join(sourceDir, 'skills', 'my-skill'), { recursive: true });
      await writeFile(join(sourceDir, 'skills', 'my-skill', 'SKILL.md'), `---
name: my-skill
description: Test skill
---
# Content`);

      const result = await add(sourceDir, projectDir, { force: true });

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('my-skill');
      expect(result.skills[0].action).toBe('added');

      const destPath = join(projectDir, '.agentuse', 'skills', 'my-skill', 'SKILL.md');
      expect(existsSync(destPath)).toBe(true);
    });

    it('copies skill from nested directory', async () => {
      await mkdir(join(sourceDir, 'skills', 'category', 'nested-skill'), { recursive: true });
      await writeFile(join(sourceDir, 'skills', 'category', 'nested-skill', 'SKILL.md'), `---
name: nested-skill
description: Nested
---
# Nested`);

      const result = await add(sourceDir, projectDir, { force: true });

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('nested-skill');
      expect(existsSync(join(projectDir, '.agentuse', 'skills', 'nested-skill', 'SKILL.md'))).toBe(true);
    });

    it('copies direct skill path', async () => {
      await mkdir(join(sourceDir, 'direct-skill'));
      await writeFile(join(sourceDir, 'direct-skill', 'SKILL.md'), `---
name: direct-skill
description: Direct
---
# Direct`);

      const result = await add(join(sourceDir, 'direct-skill'), projectDir, { force: true });

      expect(result.skills).toHaveLength(1);
      expect(result.skills[0].name).toBe('direct-skill');
      expect(existsSync(join(projectDir, '.agentuse', 'skills', 'direct-skill', 'SKILL.md'))).toBe(true);
    });

    it('copies skill with scripts directory', async () => {
      await mkdir(join(sourceDir, 'skills', 'scripted-skill', 'scripts'), { recursive: true });
      await writeFile(join(sourceDir, 'skills', 'scripted-skill', 'SKILL.md'), `---
name: scripted-skill
description: Has scripts
---
# With scripts`);
      await writeFile(join(sourceDir, 'skills', 'scripted-skill', 'scripts', 'run.sh'), '#!/bin/bash\necho hello');

      await add(sourceDir, projectDir, { force: true });

      expect(existsSync(join(projectDir, '.agentuse', 'skills', 'scripted-skill', 'SKILL.md'))).toBe(true);
      expect(existsSync(join(projectDir, '.agentuse', 'skills', 'scripted-skill', 'scripts', 'run.sh'))).toBe(true);
    });
  });

  describe('add - local agents', () => {
    it('copies .agentuse files preserving relative path', async () => {
      await mkdir(join(sourceDir, 'agents'), { recursive: true });
      await writeFile(join(sourceDir, 'agents', 'my-agent.agentuse'), `model: anthropic:claude-sonnet-4-5
---
# Agent`);

      const result = await add(sourceDir, projectDir, { force: true });

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].path).toBe('agents/my-agent.agentuse');
      expect(existsSync(join(projectDir, 'agents', 'my-agent.agentuse'))).toBe(true);
    });

    it('copies root-level .agentuse files', async () => {
      await writeFile(join(sourceDir, 'root-agent.agentuse'), `model: anthropic:claude-sonnet-4-5
---
# Root`);

      const result = await add(sourceDir, projectDir, { force: true });

      expect(result.agents).toHaveLength(1);
      expect(result.agents[0].path).toBe('root-agent.agentuse');
      expect(existsSync(join(projectDir, 'root-agent.agentuse'))).toBe(true);
    });
  });

  describe('add - ignores', () => {
    it('ignores node_modules', async () => {
      await mkdir(join(sourceDir, 'node_modules', 'pkg'), { recursive: true });
      await writeFile(join(sourceDir, 'node_modules', 'pkg', 'SKILL.md'), `---
name: pkg
description: Ignored
---`);

      const result = await add(sourceDir, projectDir, { force: true });

      expect(result.skills).toHaveLength(0);
      expect(existsSync(join(projectDir, '.agentuse', 'skills', 'pkg'))).toBe(false);
    });

    it('ignores docs directory', async () => {
      await mkdir(join(sourceDir, 'docs', 'doc-skill'), { recursive: true });
      await writeFile(join(sourceDir, 'docs', 'doc-skill', 'SKILL.md'), `---
name: doc-skill
description: Ignored
---`);

      const result = await add(sourceDir, projectDir, { force: true });

      expect(result.skills).toHaveLength(0);
    });

    it('ignores tests directory', async () => {
      await mkdir(join(sourceDir, 'tests', 'test-skill'), { recursive: true });
      await writeFile(join(sourceDir, 'tests', 'test-skill', 'SKILL.md'), `---
name: test-skill
description: Ignored
---`);

      const result = await add(sourceDir, projectDir, { force: true });

      expect(result.skills).toHaveLength(0);
    });
  });

  describe('add - force mode', () => {
    it('overwrites existing skill with force', async () => {
      // Create existing skill
      await mkdir(join(projectDir, '.agentuse', 'skills', 'existing-skill'), { recursive: true });
      await writeFile(join(projectDir, '.agentuse', 'skills', 'existing-skill', 'SKILL.md'), 'old content');

      // Create source skill
      await mkdir(join(sourceDir, 'skills', 'existing-skill'), { recursive: true });
      await writeFile(join(sourceDir, 'skills', 'existing-skill', 'SKILL.md'), `---
name: existing-skill
description: New
---
# New content`);

      const result = await add(sourceDir, projectDir, { force: true });

      expect(result.skills[0].action).toBe('overwritten');
      const content = await readFile(join(projectDir, '.agentuse', 'skills', 'existing-skill', 'SKILL.md'), 'utf-8');
      expect(content).toContain('New content');
    });
  });

  describe('add - mixed content', () => {
    it('copies both skills and agents', async () => {
      await mkdir(join(sourceDir, 'skills', 'skill-a'), { recursive: true });
      await writeFile(join(sourceDir, 'skills', 'skill-a', 'SKILL.md'), `---
name: skill-a
description: Skill A
---`);

      await writeFile(join(sourceDir, 'agent-a.agentuse'), `model: anthropic:claude-sonnet-4-5
---`);

      const result = await add(sourceDir, projectDir, { force: true });

      expect(result.skills).toHaveLength(1);
      expect(result.agents).toHaveLength(1);
    });

    it('returns empty results for empty source', async () => {
      const result = await add(sourceDir, projectDir, { force: true });

      expect(result.skills).toHaveLength(0);
      expect(result.agents).toHaveLength(0);
    });
  });
});
