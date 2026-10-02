import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { ulid } from 'ulid';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import * as models from '../src/models';
import * as sandbox from '../src/sandbox';
import { Store } from '../src/store/store';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { parseAgent, parseAgentContent } from '../src/parser';
import { prepareAgentExecution } from '../src/runner/preparation';
import { runAgent } from '../src/runner/run';
import { executeAgent } from '../src/worker/run';
import { createWorkerContext } from '../src/worker/context';

// Preparation creates the durable session before fallible setup (tool loading,
// sub-agent loading, the tools snapshot). It must own rollback for that window:
// a failure must not leave a `running` session with no owner, leak a sandbox or
// store lock, or continue as an untracked run when persistence was requested.

const priorEnv = {
  dataHome: process.env.XDG_DATA_HOME,
  codeMode: process.env.AGENTUSE_CODE_MODE,
  compaction: process.env.CONTEXT_COMPACTION,
};
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-prep-rollback-'));
  process.env.XDG_DATA_HOME = join(root, 'data');
  process.env.AGENTUSE_CODE_MODE = '0';
  process.env.CONTEXT_COMPACTION = 'false';
  await initStorage(root);
});

afterEach(async () => {
  for (const [key, value] of [
    ['XDG_DATA_HOME', priorEnv.dataHome],
    ['AGENTUSE_CODE_MODE', priorEnv.codeMode],
    ['CONTEXT_COMPACTION', priorEnv.compaction],
  ] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(root, { recursive: true, force: true });
});

const context = () => ({ projectRoot: root, stateRoot: root, cwd: root });

async function sessionStates(manager: SessionManager) {
  return (await manager.listSessionSummaries()).map(s => ({ status: s.status, code: s.error?.code }));
}

describe('prepareAgentExecution rollback', () => {
  it('kills the sandbox, releases the store and fails the session when a later step fails', async () => {
    let killed = 0;
    const allocation = spyOn(sandbox, 'createSandbox').mockImplementation(async () =>
      ({ container: { id: 'rollback-double' }, kill: async () => { killed++; } }) as never);
    const sandboxTools = spyOn(sandbox, 'createSandboxTools').mockReturnValue({});
    const release = spyOn(Store.prototype, 'releaseLock');
    try {
      const manager = new SessionManager();
      spyOn(manager, 'writeToolsSnapshot').mockRejectedValue(new Error('ENOSPC: snapshot fixture'));
      const agent = parseAgentContent(
        '---\nmodel: demo:test\nsandbox: true\nstore: true\nskills:\n  auto: false\n---\nReview',
        'rollback-fixture',
      );
      await expect(prepareAgentExecution({ agent, mcpClients: [], sessionManager: manager, projectContext: context() }))
        .rejects.toThrow('ENOSPC: snapshot fixture');
      expect(killed).toBe(1);
      expect(release).toHaveBeenCalled();
      expect(await sessionStates(manager)).toEqual([{ status: 'error', code: 'EXECUTION_ERROR' }]);
    } finally {
      allocation.mockRestore();
      sandboxTools.mockRestore();
      release.mockRestore();
    }
  });

  it('rethrows the original error when cleanup also fails', async () => {
    const allocation = spyOn(sandbox, 'createSandbox').mockImplementation(async () =>
      ({ container: { id: 'rollback-double' }, kill: async () => { throw new Error('kill failed'); } }) as never);
    const sandboxTools = spyOn(sandbox, 'createSandboxTools').mockReturnValue({});
    try {
      const manager = new SessionManager();
      spyOn(manager, 'writeToolsSnapshot').mockRejectedValue(new Error('ENOSPC: snapshot fixture'));
      spyOn(manager, 'setSessionError').mockRejectedValue(new Error('status write failed'));
      const agent = parseAgentContent('---\nmodel: demo:test\nsandbox: true\nskills:\n  auto: false\n---\nReview', 'rollback-fixture');
      await expect(prepareAgentExecution({ agent, mcpClients: [], sessionManager: manager, projectContext: context() }))
        .rejects.toThrow('ENOSPC: snapshot fixture');
    } finally {
      allocation.mockRestore();
      sandboxTools.mockRestore();
    }
  });

  it('leaves a resumed session status to its owner', async () => {
    const manager = new SessionManager();
    const agent = parseAgentContent('---\nmodel: demo:test\nskills:\n  auto: false\n---\nReview', 'rollback-fixture');
    const prepared = await prepareAgentExecution({ agent, mcpClients: [], sessionManager: manager, projectContext: context() });
    await prepared.cleanup();
    const { sessionID, agentId } = prepared;
    if (!sessionID || !agentId) throw new Error('fixture session was not created');
    await manager.setSessionSuspended(sessionID, agentId);
    const setError = spyOn(manager, 'setSessionError');
    spyOn(manager, 'readToolsSnapshot').mockRejectedValue(new Error('EIO: snapshot read fixture'));

    await expect(prepareAgentExecution({
      agent, mcpClients: [], sessionManager: manager, projectContext: context(), existingSessionId: sessionID,
    })).rejects.toThrow('EIO: snapshot read fixture');
    expect(setError).not.toHaveBeenCalled();
    expect(await sessionStates(manager)).toEqual([{ status: 'suspended', code: undefined }]);
  });

  it('fails the session for runAgent and the attached worker when tool loading fails', async () => {
    await mkdir(join(root, '.agentuse', 'store'), { recursive: true });
    await mkdir(join(root, 'external-fixture'));
    await symlink(join(root, 'external-fixture'), join(root, '.agentuse', 'store', 'records'));
    const source = '---\nmodel: demo:test\nstore: records\nintent: false\nskills:\n  auto: false\n---\nReview';
    const manager = new SessionManager();

    await expect(runAgent(parseAgentContent(source, 'prep-fixture'), [], false, undefined, Date.now(), false,
      undefined, undefined, manager, context(), undefined, undefined, true, undefined, false)).rejects.toThrow();
    expect(await sessionStates(manager)).toEqual([{ status: 'error', code: 'EXECUTION_ERROR' }]);

    const ctx = createWorkerContext();
    const result = await executeAgent(ctx, { id: 'attached-request', type: 'execute', projectRoot: root,
      agentContent: source, agentName: 'worker-prep-fixture', newSessionId: ulid() });
    expect(result.success).toBe(false);
    expect(await sessionStates(manager)).toEqual([
      { status: 'error', code: 'EXECUTION_ERROR' },
      { status: 'error', code: 'EXECUTION_ERROR' },
    ]);
  });
});

describe('attached worker handoff', () => {
  it('releases prepared resources when a continuation cannot be marked running', async () => {
    let killed = 0;
    const allocation = spyOn(sandbox, 'createSandbox').mockImplementation(async () =>
      ({ container: { id: 'handoff-double' }, kill: async () => { killed++; } }) as never);
    const sandboxTools = spyOn(sandbox, 'createSandboxTools').mockReturnValue({});
    const release = spyOn(Store.prototype, 'releaseLock');
    const markRunning = spyOn(SessionManager.prototype, 'setSessionRunning');
    try {
      const agentPath = join(root, 'continued.agentuse');
      await writeFile(agentPath, '---\nmodel: demo:test\nsandbox: true\nstore: true\nintent: false\nskills:\n  auto: false\n---\nReview');
      const manager = new SessionManager();
      const first = await prepareAgentExecution({
        agent: await parseAgent(agentPath), mcpClients: [], agentFilePath: agentPath,
        sessionManager: manager, projectContext: context(),
      });
      await first.cleanup();
      const { sessionID, agentId } = first;
      if (!sessionID || !agentId) throw new Error('fixture session was not created');
      await manager.setSessionCompleted(sessionID, agentId);
      killed = 0;
      release.mockClear();
      markRunning.mockRejectedValue(new Error('EIO: mark running fixture'));

      const result = await executeAgent(createWorkerContext(), {
        id: 'continue-request', type: 'continue-session', projectRoot: root, sessionId: sessionID, prompt: 'Continue.',
      });

      expect(result.success).toBe(false);
      expect(killed).toBe(1);
      expect(release).toHaveBeenCalled();
      expect(await sessionStates(manager)).toEqual([{ status: 'completed', code: undefined }]);
    } finally {
      allocation.mockRestore();
      sandboxTools.mockRestore();
      release.mockRestore();
      markRunning.mockRestore();
    }
  });
});

describe('requested persistence that fails', () => {
  const usage = { inputTokens: { total: 10, noCache: 10, cacheRead: 0, cacheWrite: 0 },
    outputTokens: { total: 5, text: 5, reasoning: 0 } };

  for (const failedOperation of ['createSession', 'createMessage'] as const) {
    it(`stops the run before any tool executes when ${failedOperation} fails`, async () => {
      let effects = 0;
      let turns = 0;
      const model = new MockLanguageModelV3({ doStream: async () => {
        const part = turns++ === 0
          ? { type: 'tool-call', toolCallId: 'local-effect', toolName: 'mcp__review__effect', input: '{}' }
          : { type: 'tool-call', toolCallId: 'outcome', toolName: 'report_outcome',
              input: JSON.stringify({ status: 'complete', headline: 'Fixture finished.', artifacts: [] }) };
        return { stream: convertArrayToReadableStream([
          { type: 'stream-start', warnings: [] }, part,
          { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' }, usage },
        ] as never) };
      } });
      const modelFactory = spyOn(models, 'createModel').mockResolvedValue(model as never);
      try {
        const manager = new SessionManager();
        spyOn(manager, failedOperation).mockRejectedValue(new Error(`EACCES: ${failedOperation} fixture`));
        const effectTool = { description: 'In-memory counter', inputSchema: z.object({}),
          execute: async () => { effects++; return { content: [{ type: 'text', text: 'done' }] }; } };
        const connection = { name: 'review', preloadedTools: { effect: effectTool },
          client: { listResources: async () => ({ resources: [] }),
            listResourceTemplates: async () => ({ resourceTemplates: [] }), close: async () => {} } };
        const agent = parseAgentContent('---\nmodel: demo:test\nintent: false\nmaxSteps: 3\nskills:\n  auto: false\n---\nReview', 'untracked-fixture');

        await expect(runAgent(agent, [connection as never], false, undefined, Date.now(), false,
          undefined, undefined, manager, context(), undefined, undefined, true, undefined, false))
          .rejects.toThrow(`EACCES: ${failedOperation} fixture`);
        expect(effects).toBe(0);
        // A session whose first message could not be written is failed, not left running.
        expect(await sessionStates(manager)).toEqual(
          failedOperation === 'createMessage' ? [{ status: 'error', code: 'EXECUTION_ERROR' }] : [],
        );
      } finally {
        modelFactory.mockRestore();
      }
    });
  }
});
