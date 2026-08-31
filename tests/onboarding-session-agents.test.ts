import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseAgentContent } from '../src/parser';
import { loadAgentTools } from '../src/runner/tools-loader';
import {
  prepareProjectDiscoveryView,
  redactProjectDiscoveryText,
} from '../src/agents/discover';
import {
  buildAgentCreatorSessionAgent,
  buildProjectDiscoverySessionAgent,
  parseProjectDiscoverySessionOutput,
} from '../src/onboarding/session-agents';
import {
  agentSourceSubmissionContract,
  createSubmitAgentSourceTool,
} from '../src/onboarding/submit-agent-source';
import {
  createSubmitProjectSuggestionsTool,
  projectSuggestionsSubmissionContract,
} from '../src/onboarding/submit-project-suggestions';

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

const suggestions = JSON.stringify({
  summary: 'A TypeScript application with tests and release automation.',
  suggestions: [
    { name: 'Release review', description: 'Review release readiness.', objective: 'Inspect package.json and tests, then report release risks.', schedule: '0 9 * * 1', evidence: ['package.json'] },
    { name: 'Docs drift', description: 'Find documentation drift.', objective: 'Compare README.md with source behavior and report drift.', schedule: '0 10 * * 3', evidence: ['README.md'] },
    { name: 'Test health', description: 'Summarize test health.', objective: 'Inspect tests and configuration, then report recurring failures.', schedule: '0 11 * * 5', evidence: ['tests/example.test.ts'] },
  ],
});

describe('onboarding session agents', () => {
  it('builds a sanitized adaptive project view and removes it on cleanup', async () => {
    const project = await mkdtemp(join(tmpdir(), 'onboarding-project-source-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'onboarding-project-outside-'));
    cleanups.push(
      () => rm(project, { recursive: true, force: true }),
      () => rm(outsideRoot, { recursive: true, force: true }),
    );
    await mkdir(join(project, 'src'), { recursive: true });
    await mkdir(join(project, 'node_modules', 'pkg'), { recursive: true });
    await writeFile(join(project, 'README.md'), '# Product');
    await writeFile(join(project, 'src', 'config.ts'), 'const API_KEY="super-secret-value";\nexport const mode="test";');
    await writeFile(join(project, '.env'), 'TOKEN=never-copy');
    await writeFile(join(project, 'node_modules', 'pkg', 'index.js'), 'generated noise');
    const outsideFile = join(outsideRoot, 'outside.txt');
    await writeFile(outsideFile, 'outside-project-secret');
    await symlink(outsideFile, join(project, 'linked-outside.txt'));

    const view = await prepareProjectDiscoveryView(project);
    cleanups.push(view.cleanup);
    expect(view.availableFiles).toContain('README.md');
    expect(view.availableFiles).toContain('src/config.ts');
    expect(view.availableFiles).not.toContain('.env');
    expect(view.availableFiles.some((path) => path.includes('node_modules'))).toBe(false);
    expect(view.availableFiles).not.toContain('linked-outside.txt');
    expect(view.inspectedFiles).toBe(view.availableFiles.length);
    expect(await readFile(join(view.root, 'src', 'config.ts'), 'utf8')).toContain('API_KEY=[REDACTED]');
    expect(await readFile(join(view.root, 'src', 'config.ts'), 'utf8')).not.toContain('super-secret-value');
    await expect(readFile(join(view.root, 'linked-outside.txt'), 'utf8')).rejects.toThrow();
  });

  it('redacts common secret assignments, provider tokens, and private keys', () => {
    const text = redactProjectDiscoveryText('PASSWORD: hunter2\nconst token = ghp_abcdefghijklmnopqrstuvwxyz123456\n-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----');
    expect(text).not.toContain('hunter2');
    expect(text).not.toContain('ghp_');
    expect(text).not.toContain('\nabc\n');
    expect(text).toContain('[REDACTED]');
  });

  it('creates parser-valid hidden agents with only sanitized filesystem reads', () => {
    const discovery = parseAgentContent(buildProjectDiscoverySessionAgent({
      model: 'openai:gpt-5.6-terra', projectName: 'demo', inspectedFiles: 99, safeViewRoot: '/tmp/safe-view',
    }), '');
    expect(discovery.name).toBe('onboarding-project-discovery');
    expect(discovery.config.reasoning).toBe('minimal');
    expect(discovery.config.tools?.filesystem?.[0]?.path).toBe('/tmp/safe-view');
    expect(discovery.config.tools?.bash).toBeUndefined();
    expect(discovery.config.maxSteps).toBe(20);
    expect(discovery.instructions).toContain('Submit the one-sentence project summary');
    expect(discovery.instructions).toContain('submit_project_suggestions');
    expect(discovery.config.metadata?.projectName).toBe('demo');
    expect(discovery.config.metadata?.inspectedFiles).toBe(99);

    const creator = parseAgentContent(buildAgentCreatorSessionAgent({
      model: 'openai:gpt-5.6-terra',
      safeViewRoot: '/tmp/safe-view',
      creatorSkill: 'Creator rules',
      requestedName: 'Docs drift',
      description: 'Find drift',
      objective: 'Inspect docs',
      schedule: '0 9 * * 1',
      availableModels: ['openai:gpt-5.6-luna'],
    }), '');
    expect(creator.name).toBe('onboarding-agent-creator');
    expect(creator.config.reasoning).toBe('minimal');
    expect(creator.instructions).toContain('<creator_skill>');
    expect(creator.instructions).toContain('openai:gpt-5.6-luna');
    expect(creator.instructions).toContain('Submit the complete raw .agentuse file through submit_agent_source');
    expect(creator.instructions).toContain('Do not stream it as a normal assistant message');
    expect(creator.instructions).toContain('tools.filesystem must be an array');
    expect(creator.instructions).toContain('{ path: "${root}", permissions: ["read"] }');
    expect(creator.config.timeout).toBe(300);
    expect(creator.config.metadata?.requestedName).toBe('Docs drift');
    expect(creator.config.metadata?.requestedSchedule).toBe('0 9 * * 1');
  });

  it('validates creator source inside the structured submission tool', async () => {
    const contract = agentSourceSubmissionContract({
      internal: true,
      onboarding: 'agent-creator',
      requestedName: 'Docs drift',
      requestedSchedule: '0 9 * * 1',
      availableModels: ['openai:gpt-5.6-luna'],
    });
    expect(contract).toBeDefined();
    const submission: { source?: string; model?: string } = {};
    const tool = createSubmitAgentSourceTool(submission, contract!);
    await expect((tool.execute as any)({ source: 'not an agent' })).rejects.toThrow('Source rejected');

    const source = '---\nname: Docs drift\nmodel: openai:gpt-5.6-luna\ndescription: Find drift\nschedule: 0 9 * * 1\ntools:\n  filesystem:\n    - path: ${root}\n      permissions: [read]\n---\n\n## Goal\nReport drift.\n';
    await expect((tool.execute as any)({ source })).resolves.toContain('Accepted');
    expect(submission.source).toBe(source);
    expect(submission.model).toBe('openai:gpt-5.6-luna');
  });

  it('injects the creator tool and blocks completion until valid source is submitted', async () => {
    const agent = parseAgentContent(`---
name: onboarding-agent-creator
model: openai:gpt-5.6-luna
metadata:
  internal: true
  onboarding: agent-creator
  requestedName: Docs drift
  requestedSchedule: 0 9 * * 1
  availableModels:
    - openai:gpt-5.6-luna
---

Create the agent.
`, 'onboarding-agent-creator');
    const loaded = await loadAgentTools({ agent, mcpConnections: [] });
    expect(loaded.all.submit_agent_source).toBeDefined();
    await expect((loaded.all.report_complete!.execute as any)({ headline: 'Created Docs drift' }))
      .rejects.toThrow('Call submit_agent_source first');

    const source = '---\nname: Docs drift\nmodel: openai:gpt-5.6-luna\ndescription: Find drift\nschedule: 0 9 * * 1\n---\n\n## Goal\nReport drift.\n';
    await (loaded.all.submit_agent_source!.execute as any)({ source });
    await expect((loaded.all.report_complete!.execute as any)({ headline: 'Created Docs drift' }))
      .resolves.toContain('Recorded and delivered');
    expect(loaded.agentSourceSubmission?.source).toBe(source);
  });

  it('validates and carries discovery suggestions through a structured tool', async () => {
    const contract = projectSuggestionsSubmissionContract({
      internal: true,
      onboarding: 'project-discovery',
      projectName: 'demo',
      inspectedFiles: 99,
    });
    expect(contract).toEqual({ projectName: 'demo', inspectedFiles: 99 });
    const submission: { result?: unknown } = {};
    const tool = createSubmitProjectSuggestionsTool(submission as any, contract!);
    await expect((tool.execute as any)({ summary: 'Demo project', suggestions: [] }))
      .rejects.toThrow('exactly three project suggestions');

    await expect((tool.execute as any)(JSON.parse(suggestions))).resolves.toContain('Accepted');
    expect((submission.result as any)?.suggestions).toHaveLength(3);
    expect((submission.result as any)?.inspectedFiles).toBe(99);
  });

  it('injects the discovery submission tool and guards completion', async () => {
    const agent = parseAgentContent(`---
name: onboarding-project-discovery
model: openai:gpt-5.6-luna
metadata:
  internal: true
  onboarding: project-discovery
  projectName: demo
  inspectedFiles: 99
---

Discover useful work.
`, 'onboarding-project-discovery');
    const loaded = await loadAgentTools({ agent, mcpConnections: [] });
    expect(loaded.all.submit_project_suggestions).toBeDefined();
    await expect((loaded.all.report_complete!.execute as any)({ headline: 'Found ideas' }))
      .rejects.toThrow('Call submit_project_suggestions first');

    await (loaded.all.submit_project_suggestions!.execute as any)(JSON.parse(suggestions));
    await expect((loaded.all.report_complete!.execute as any)({ headline: 'Found three ideas' }))
      .resolves.toContain('Recorded and delivered');
    expect(loaded.projectSuggestionsSubmission?.result?.suggestions).toHaveLength(3);
  });

  it('parses runtime-prefixed discovery JSON', () => {
    const parsed = parseProjectDiscoverySessionOutput(`✅ Complete:\n${suggestions}`, 'demo', 99);
    expect(parsed.suggestions).toHaveLength(3);
    expect(parsed.inspectedFiles).toBe(99);
  });
});
