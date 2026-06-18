import { describe, expect, it } from 'bun:test';
import { readFile } from 'fs/promises';
import { join } from 'path';

describe('internal worker session state ordering', () => {
  it('restores resume state on preflight returns after applying approval result', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf-8');
    const executeAgentStart = source.indexOf('async function executeAgent');
    expect(executeAgentStart).toBeGreaterThanOrEqual(0);

    const executeAgent = source.slice(executeAgentStart);
    expect(executeAgent).toContain('const restoreResumeAndReturn = async <T>(response: T): Promise<T> =>');
    expect(executeAgent).toContain('return restoreResumeAndReturn({\n            id: req.id,\n            success: false,\n            error: { code: \'AGENT_NOT_FOUND\'');
    expect(executeAgent).toContain('return restoreResumeAndReturn({\n          id: req.id,\n          success: false,\n          error: { code: \'ENV_MISSING\'');
  });

  it('does not short-circuit rejected approval decisions before agent resume', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf-8');
    const resumeBranch = source.indexOf("if (req.type === 'resume')");
    const continueBranch = source.indexOf("} else if (req.type === 'continue-session')", resumeBranch);
    expect(resumeBranch).toBeGreaterThanOrEqual(0);
    expect(continueBranch).toBeGreaterThan(resumeBranch);

    const resumeSource = source.slice(resumeBranch, continueBranch);
    expect(resumeSource).toContain('const resumed = await applyResumeToolResult');
    expect(resumeSource).not.toContain('isRejectDecision');
    expect(resumeSource).not.toContain("finishReason: 'rejected'");
    expect(resumeSource).toContain('agentPath = resumed.agentFilePath;');
  });

  it('marks continuation sessions running only after parse/env/MCP preflight', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf-8');
    const continueBranch = source.indexOf("} else if (req.type === 'continue-session')");
    expect(continueBranch).toBeGreaterThanOrEqual(0);

    const continuationAssigned = source.indexOf('continuationSession = { sessionId: req.sessionId, agentId: found.agentId };', continueBranch);
    const mcpConnected = source.indexOf('mcp = await connectMCP(agent.config.mcpServers, req.debug ?? false, mcpBasePath);', continueBranch);
    const markedRunning = source.indexOf('await sessionManager.setSessionRunning(continuationSession.sessionId, continuationSession.agentId);', continueBranch);

    expect(continuationAssigned).toBeGreaterThan(continueBranch);
    expect(mcpConnected).toBeGreaterThan(continuationAssigned);
    expect(markedRunning).toBeGreaterThan(mcpConnected);
    expect(source.slice(continueBranch, mcpConnected)).not.toContain('setSessionRunning(');
  });
});
