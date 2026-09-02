import { describe, expect, it } from 'bun:test';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

const sourceRoot = join(import.meta.dir, '..', 'src');

async function source(path: string): Promise<string> {
  return readFile(join(sourceRoot, path), 'utf8');
}

describe('internal AgentUse architecture', () => {
  it('keeps agent design and idea discovery out of helper completions', async () => {
    const protectedModules = [
      'agents/author.ts',
      'agents/discover.ts',
      'onboarding/session-agents.ts',
    ];

    for (const path of protectedModules) {
      const contents = await source(path);
      expect(contents, `${path} must not import completeText`).not.toMatch(
        /from\s+['"][^'"]*complete-text(?:\.js)?['"]/u,
      );
      expect(contents, `${path} must not call completeText`).not.toMatch(/\bcompleteText\s*\(/u);
    }
  });

  it('has no callable legacy project-discovery completion endpoint', async () => {
    const [serve, webApi] = await Promise.all([
      source('cli/serve.ts'),
      source('cli/serve/web/lib/api.ts'),
    ]);

    expect(serve).not.toContain('routePath === "/agents/discover"');
    expect(webApi).not.toContain("postJson('/api/agents/discover'");
    expect(webApi).not.toMatch(/export function discoverProjectAgents\b/u);
  });

  it('routes New Agent and project ideas through persisted workers', async () => {
    const serve = await source('cli/serve.ts');
    const newAgentStart = serve.indexOf('routePath === "/agents" && req.method === "POST"');
    const projectIdeasStart = serve.indexOf("routePath === '/onboarding/discovery' && req.method === 'POST'");
    expect(newAgentStart).toBeGreaterThan(-1);
    expect(projectIdeasStart).toBeGreaterThan(-1);
    expect(serve.slice(newAgentStart, serve.indexOf('routePath === "/projects"', newAgentStart))).toContain('worker.execute({');
    expect(serve.slice(projectIdeasStart, serve.indexOf('routePath === "/onboarding/run"', projectIdeasStart))).toContain('worker.execute({');
  });

  it('runs agent revisions as persisted, resumable AgentUse sessions', async () => {
    const serve = await source('cli/serve.ts');
    const revisionStart = serve.indexOf("routePath.match(/^\\/sessions\\/([^/?#]+)\\/revisions$/)");
    expect(revisionStart).toBeGreaterThan(-1);
    const section = serve.slice(revisionStart, serve.indexOf('const revisionActionMatch', revisionStart));
    expect(section).toContain('writeInternalAgentRevisionSource(');
    expect(section).toContain('agentPath: internalAgentPath');
    expect(section).toContain('newSessionId: revisionSessionId');
    expect(section).not.toContain('completeText(');
  });

  it('uses one creator endpoint, worker path, and SSE job controller', async () => {
    const [serve, webApi, createDialog, onboarding, controller] = await Promise.all([
      source('cli/serve.ts'),
      source('cli/serve/web/lib/api.ts'),
      source('cli/serve/web/components/agent-create-dialog.tsx'),
      source('cli/serve/web/components/project-agent-discovery.tsx'),
      source('cli/serve/web/hooks/use-internal-agent-job.ts'),
    ]);

    expect(serve).not.toContain("routePath === '/onboarding/creation'");
    expect(serve.match(/agentName: 'internal-agent-creator'/gu)).toHaveLength(1);
    expect(webApi).toContain("postJson('/api/agents', { ...input, guided: true })");
    expect(webApi).not.toContain('fetchAgentCreationJob');
    expect(webApi).not.toContain('fetchOnboardingJob');
    expect(createDialog).toContain('useInternalAgentJob(activeJob)');
    expect(onboarding).toContain('useInternalAgentJob(activeJob)');
    expect(controller).toContain('useApprovalStream({');
  });

  it('returns persisted jobs before preparing project context', async () => {
    const serve = await source('cli/serve.ts');
    const routeSections = [
      serve.slice(
        serve.indexOf('routePath === "/agents" && req.method === "POST"'),
        serve.indexOf('routePath === "/projects"'),
      ),
      serve.slice(
        serve.indexOf("routePath === '/onboarding/discovery' && req.method === 'POST'"),
        serve.indexOf('routePath === "/onboarding/run"'),
      ),
    ];

    for (const section of routeSections) {
      const persisted = section.indexOf('onboardingJobs.set(job.id, job)');
      const responded = section.indexOf('sendJSON(res, 202');
      const prepared = section.indexOf('prepareProjectDiscoveryView');
      const executed = section.indexOf('worker.execute({');
      expect(persisted).toBeGreaterThan(-1);
      expect(responded).toBeGreaterThan(persisted);
      expect(prepared).toBeGreaterThan(responded);
      expect(executed).toBeGreaterThan(prepared);
    }
  });

  it('returns a durable revision session before preparing its project context', async () => {
    const serve = await source('cli/serve.ts');
    const revisionStart = serve.indexOf("routePath.match(/^\\/sessions\\/([^/?#]+)\\/revisions$/)");
    const section = serve.slice(revisionStart, serve.indexOf('const revisionActionMatch', revisionStart));
    const recorded = section.indexOf('createAgentRevisionRecord({');
    const sessionCreated = section.indexOf('worker.createPreparingSession({');
    const responded = section.indexOf('sendJSON(res, 202');
    const prepared = section.indexOf('prepareProjectDiscoveryView');
    const executed = section.indexOf('worker.execute({');

    expect(recorded).toBeGreaterThan(-1);
    expect(sessionCreated).toBeGreaterThan(recorded);
    expect(responded).toBeGreaterThan(sessionCreated);
    expect(prepared).toBeGreaterThan(responded);
    expect(executed).toBeGreaterThan(prepared);
    expect(section).toContain('preparedSession: true');
  });
});
