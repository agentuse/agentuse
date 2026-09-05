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

  it('leaves a finished creator session drafted, writing the agent only on save', async () => {
    const serve = await source('cli/serve.ts');
    // The creator's consume path records a numbered draft; the project file is
    // written by the save route alone, so a draft the operator never accepts
    // never lands in the project.
    const consume = serve.slice(serve.indexOf("kind: 'agent-creation'"));
    const consumeBody = consume.slice(consume.indexOf('consume: async (execution)'), consume.indexOf('mapError:'));
    expect(consumeBody).toContain('appendAgentDraft');
    expect(consumeBody).not.toContain('finishAgentCreation');

    const saveRoute = serve.slice(serve.indexOf('draftActionMatch'));
    expect(saveRoute).toContain('markAgentDraftSaved');
    expect(saveRoute).toContain('finishAgentCreation');
  });

  it('runs a draft test the way `agentuse test` does, from one shared rule', async () => {
    const [serve, cli, mockTools] = await Promise.all([
      source('cli/serve.ts'),
      source('index.ts'),
      source('runner/mock-tools.ts'),
    ]);

    // The scope rule lives once. A second copy in serve is what silently ran
    // every draft test at scope "all", faking the reads that were supposed to
    // ground it.
    expect(mockTools).toContain('export function resolveMockScope(');
    expect(serve).toContain('resolveMockScope(');
    expect(cli).toContain('resolveMockScope(');
    // Scoped to the test-run helper: an unrelated metadata builder elsewhere in
    // serve legitimately reads the same field.
    const mockRunner = serve.slice(serve.indexOf('const startMockTestRun'), serve.indexOf('const recoverAgentCreationJob'));
    expect(mockRunner).not.toContain('bash?.gated');

    // The env is assembled by the shared helper, never by hand: a hand-rolled
    // copy omitted AGENTUSE_MOCK_SCOPE entirely.
    expect(serve).toContain('mockRunEnv({ scope, model: mockModel })');
    expect(serve).not.toContain("AGENTUSE_MOCK_MODE: '1'");

    // No silent fallback onto the agent's own premium model.
    expect(serve).toContain('configuredMockModel()');
    expect(serve).not.toContain('AGENTUSE_MOCK_MODEL: process.env.AGENTUSE_MOCK_MODEL || draft.model');
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
    const [serve, webApi, draftPage, onboarding, controller] = await Promise.all([
      source('cli/serve.ts'),
      source('cli/serve/web/lib/api.ts'),
      source('cli/serve/web/routes/agent-draft.tsx'),
      source('cli/serve/web/components/project-agent-discovery.tsx'),
      source('cli/serve/web/hooks/use-internal-agent-job.ts'),
    ]);

    expect(serve).not.toContain("routePath === '/onboarding/creation'");
    // Once, on the durable preparing shell. The run itself goes through the
    // creator source written to disk, which is what makes the session
    // continuable for a change request.
    expect(serve.match(/agentName: 'internal-agent-creator'/gu)).toHaveLength(1);
    expect(serve).toContain('writeInternalAgentDraftSource(project.root, sessionId, agentContent)');
    expect(webApi).toContain("postJson('/api/agents', { ...input, guided: true })");
    expect(webApi).not.toContain('fetchAgentCreationJob');
    expect(webApi).not.toContain('fetchOnboardingJob');
    // The create dialog hands off the moment the session exists. The draft page
    // then follows the session log itself, because the panel outlives the job:
    // the session settles, the operator asks for a change, and it runs again.
    expect(draftPage).toContain('useSessionLog({');
    expect(draftPage).not.toContain('useInternalAgentJob');
    expect(onboarding).toContain('useInternalAgentJob(activeJob)');
    expect(controller).toContain('useApprovalStream({');
  });

  it('creates durable preparing jobs before preparing project context', async () => {
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
      const persisted = section.indexOf('beginInternalAgentJob({');
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
    const sessionCreated = section.indexOf('beginInternalAgentJob({');
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
