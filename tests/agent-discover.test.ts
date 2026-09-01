import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  discoverProjectSkillCatalog,
  parseProjectDiscoveryResponse,
} from '../src/agents/discover';

const response = JSON.stringify({
  summary: 'A TypeScript dashboard with tests and release workflows.',
  suggestions: [
    { name: 'Release Publisher', description: 'Prepare and publish reviewed releases.', objective: 'Inspect release changes, prepare the release, then run npm publish only after human approval. Return the published version and verification.', schedule: '0 9 * * 1-5', evidence: ['package.json defines release workflows'] },
    { name: 'Test Health', description: 'Report test health and drift.', objective: 'Inspect test configuration and recent test-related changes, then report risks. Do not modify files.', schedule: '0 10 * * 1', evidence: ['tests directory is present'] },
    { name: 'Docs Drift', description: 'Find documentation drift.', objective: 'Compare public docs with project manifests and report likely drift. Do not modify files.', schedule: '0 11 * * 5', evidence: ['README.md and package.json are present'] },
  ],
});

describe('project-aware agent discovery', () => {
  it('summarizes effective project and global skills with project precedence', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-discovery-skills-'));
    const config = await mkdtemp(join(tmpdir(), 'agent-discovery-config-'));
    const previousConfig = process.env.AGENTUSE_CONFIG_DIR;
    process.env.AGENTUSE_CONFIG_DIR = config;
    try {
      const projectSkill = join(root, '.agentuse', 'skills', 'shared-helper');
      const globalDuplicate = join(config, 'skills', 'shared-helper');
      const globalSkill = join(config, 'skills', 'global-helper');
      await mkdir(projectSkill, { recursive: true });
      await mkdir(globalDuplicate, { recursive: true });
      await mkdir(globalSkill, { recursive: true });
      await writeFile(join(projectSkill, 'SKILL.md'), `---\nname: shared-helper\ndescription: Project winner\nallowed-tools: Bash(project-tool:*)\n---\nProject instructions.`);
      await writeFile(join(globalDuplicate, 'SKILL.md'), `---\nname: shared-helper\ndescription: Global duplicate\n---\nGlobal instructions.`);
      await writeFile(join(globalSkill, 'SKILL.md'), `---\nname: global-helper\ndescription: Global capability\n---\nGlobal instructions.`);

      const catalog = await discoverProjectSkillCatalog(root);
      expect(catalog.find((skill) => skill.name === 'shared-helper')).toMatchObject({
        description: 'Project winner', source: 'project',
        allowedTools: ['Bash(project-tool:*)'], ambiguous: true,
      });
      expect(catalog.find((skill) => skill.name === 'global-helper')).toMatchObject({
        source: 'global', ambiguous: false,
      });
    } finally {
      if (previousConfig === undefined) delete process.env.AGENTUSE_CONFIG_DIR;
      else process.env.AGENTUSE_CONFIG_DIR = previousConfig;
      await rm(root, { recursive: true, force: true });
      await rm(config, { recursive: true, force: true });
    }
  });

  it('parses exactly three scheduled, evidence-backed suggestions', () => {
    const result = parseProjectDiscoveryResponse(response, 'agentuse', 42);
    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions[0]?.scheduleHuman).toContain('Monday through Friday');
    expect(result.inspectedFiles).toBe(42);
  });

});
