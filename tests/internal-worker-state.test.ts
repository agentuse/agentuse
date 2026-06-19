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

  it('does not cache suspended approval snapshots', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf-8');
    const helperStart = source.indexOf('function shouldCacheApprovalInfoResponse');
    const nextHelper = source.indexOf('async function withApprovalInfoCache', helperStart);
    expect(helperStart).toBeGreaterThanOrEqual(0);
    expect(nextHelper).toBeGreaterThan(helperStart);

    const helperSource = source.slice(helperStart, nextHelper);
    expect(helperSource).toContain("return status === 'completed' || status === 'error';");
    expect(helperSource).not.toContain("status !== 'running'");
  });

  it('keeps approval decisions durable when the resumed run fails', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf-8');
    const runAgentCall = source.indexOf('const result = await runAgent(');
    const runAgentCatch = source.indexOf('} catch (err) {', runAgentCall);
    const abortBranch = source.indexOf('if (abortController.signal.aborted)', runAgentCatch);
    expect(runAgentCall).toBeGreaterThanOrEqual(0);
    expect(runAgentCatch).toBeGreaterThan(runAgentCall);
    expect(abortBranch).toBeGreaterThan(runAgentCatch);

    const runAgentFailureHandler = source.slice(runAgentCatch, abortBranch);
    expect(runAgentFailureHandler).not.toContain('restoreResumeToolResult');
    expect(runAgentFailureHandler).toContain('resumeRollback = undefined;');
  });

  it('renders recovered post-approval failures as approved gate plus session error', async () => {
    const source = await readFile(join(import.meta.dir, '..', 'src', 'index.ts'), 'utf-8');
    const recoveryStart = source.indexOf('function logsWithRecoveredApprovalDecision');
    const sessionErrorStart = source.indexOf('function logsWithSessionError');
    const childSummariesStart = source.indexOf('async function childSessionSummaries');
    expect(recoveryStart).toBeGreaterThanOrEqual(0);
    expect(sessionErrorStart).toBeGreaterThan(recoveryStart);
    expect(childSummariesStart).toBeGreaterThan(sessionErrorStart);

    const recoverySource = source.slice(recoveryStart, sessionErrorStart);
    expect(recoverySource).toContain("status: 'completed'");
    expect(recoverySource).toContain("title: 'Approved'");
    expect(recoverySource).toContain("decisionStatus: 'approved'");
    expect(recoverySource).not.toContain("status: 'error'");
    expect(recoverySource).not.toContain('errorMessage');

    const sessionErrorSource = source.slice(sessionErrorStart, childSummariesStart);
    expect(sessionErrorSource).toContain("id = `session-error:${session.id}`");
    expect(sessionErrorSource).toContain("status: 'error'");
    expect(sessionErrorSource).toContain("title: 'Session failed'");
    expect(sessionErrorSource).toContain('errorMessage: message');
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
