import { describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
  collectProjectDiscoveryContext,
  discoverProjectAgents,
  parseProjectDiscoveryResponse,
} from '../src/agents/discover';

const response = JSON.stringify({
  summary: 'A TypeScript dashboard with tests and release workflows.',
  suggestions: [
    { name: 'Change Digest', description: 'Summarize meaningful changes.', objective: 'Inspect recent project changes and return a concise impact digest. Do not modify files.', schedule: '0 9 * * 1-5', evidence: ['package.json defines a dashboard build'] },
    { name: 'Test Health', description: 'Report test health and drift.', objective: 'Inspect test configuration and recent test-related changes, then report risks. Do not modify files.', schedule: '0 10 * * 1', evidence: ['tests directory is present'] },
    { name: 'Docs Drift', description: 'Find documentation drift.', objective: 'Compare public docs with project manifests and report likely drift. Do not modify files.', schedule: '0 11 * * 5', evidence: ['README.md and package.json are present'] },
  ],
});

describe('project-aware agent discovery', () => {
  it('parses exactly three scheduled, evidence-backed suggestions', () => {
    const result = parseProjectDiscoveryResponse(response, 'agentuse', 42);
    expect(result.suggestions).toHaveLength(3);
    expect(result.suggestions[0]?.scheduleHuman).toContain('Monday through Friday');
    expect(result.inspectedFiles).toBe(42);
  });

  it('collects bounded project context without secrets or generated dependencies', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-discovery-'));
    await mkdir(join(root, 'node_modules'), { recursive: true });
    await writeFile(join(root, 'README.md'), '# Useful project');
    await writeFile(join(root, 'package.json'), '{"scripts":{"test":"bun test"}}');
    await writeFile(join(root, '.env'), 'SECRET=never-include');
    await writeFile(join(root, 'node_modules', 'noise.js'), 'noise');
    const snapshot = await collectProjectDiscoveryContext(root);
    expect(snapshot.context).toContain('Useful project');
    expect(snapshot.context).toContain('package.json');
    expect(snapshot.context).not.toContain('SECRET=never-include');
    expect(snapshot.context).not.toContain('node_modules/noise.js');
  });

  it('uses the selected configured model for the scan', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-discovery-'));
    await writeFile(join(root, 'README.md'), '# Useful project');
    let calledModel = '';
    const result = await discoverProjectAgents(root, 'openai:gpt-5.6-terra', async (model, options) => {
      calledModel = model;
      expect(options.prompt).toContain('<project_snapshot>');
      return response;
    });
    expect(calledModel).toBe('openai:gpt-5.6-terra');
    expect(result.suggestions[2]?.name).toBe('Docs Drift');
  });

  it('asks the model to repair an invalid first response', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-discovery-'));
    await writeFile(join(root, 'README.md'), '# Useful project');
    const invalid = JSON.stringify({
      summary: 'A useful project.',
      suggestions: JSON.parse(response).suggestions.map((suggestion: Record<string, unknown>) => ({ ...suggestion, evidence: [] })),
    });
    const prompts: string[] = [];
    const result = await discoverProjectAgents(root, 'openai:gpt-5.6-terra', async (_model, options) => {
      prompts.push(options.prompt);
      return prompts.length === 1 ? invalid : response;
    });
    expect(prompts).toHaveLength(2);
    expect(prompts[1]).toContain('failed validation');
    expect(prompts[1]).toContain('evidence');
    expect(result.suggestions).toHaveLength(3);
  });

  it('returns an actionable error when repair still fails', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agent-discovery-'));
    await writeFile(join(root, 'README.md'), '# Useful project');
    await expect(discoverProjectAgents(root, 'openai:gpt-5.6-terra', async () => '{}'))
      .rejects.toThrow('Try scanning again or choose another analysis model');
  });
});
