import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.restore();

const terminalErrors: Array<{ sessionId: string; agentId: string; error: { code: string; message: string } }> = [];
const completedSessions: Array<{ sessionId: string; agentId: string }> = [];
let sessionManagerConstructions = 0;
let sessionCreations = 0;
let logSinkCreations = 0;
let sessionCreationParams: any;
let runError: Error = new Error('judge execution failed');

class CapturingSessionManager {
  constructor() {
    sessionManagerConstructions++;
  }

  getFullPath(): string {
    return 'parent-session-path';
  }

  setParentPath(): void {}

  async updateMessage(): Promise<void> {}

  async setSessionCompleted(sessionId: string, agentId: string): Promise<void> {
    completedSessions.push({ sessionId, agentId });
  }

  async setSessionError(
    sessionId: string,
    agentId: string,
    error: { code: string; message: string }
  ): Promise<void> {
    terminalErrors.push({ sessionId, agentId, error });
  }
}

mock.module('../src/parser', () => ({
  parseAgent: async () => ({
    name: 'strict-judge',
    description: 'test judge',
    instructions: 'Judge strictly.',
    config: { model: 'openai:gpt-5-mini' },
  }),
}));

mock.module('../src/mcp', () => ({
  connectMCP: async () => [],
}));

mock.module('../src/runner/tools-loader', () => ({
  loadAgentTools: async () => ({ all: {} }),
}));

mock.module('../src/runner/system-messages', () => ({
  buildSystemMessages: async () => ({ messages: [] }),
}));

mock.module('../src/runner/execution', () => ({
  executeAgentCore: () => ({}),
}));

mock.module('../src/runner/stream', () => ({
  processAgentStream: async () => {
    throw runError;
  },
}));

mock.module('../src/session/manager', () => ({
  SessionManager: CapturingSessionManager,
}));

mock.module('../src/runner/session-helper', () => ({
  createSessionAndMessage: async (params: unknown) => {
    sessionCreations++;
    sessionCreationParams = params;
    return {
      sessionID: 'judge-session',
      messageID: 'judge-message',
    };
  },
  createSessionLogSink: () => {
    logSinkCreations++;
    return {
      capture: () => {},
      flush: async () => {},
    };
  },
}));

let judgeOutput: typeof import('../src/verify/judge').judgeOutput;

beforeAll(async () => {
  ({ judgeOutput } = await import('../src/verify/judge'));
});

beforeEach(() => {
  terminalErrors.length = 0;
  completedSessions.length = 0;
  sessionManagerConstructions = 0;
  sessionCreations = 0;
  logSinkCreations = 0;
  sessionCreationParams = undefined;
  runError = new Error('judge execution failed');
});

const input = {
  task: 'Review the output',
  output: 'Candidate answer',
  attempt: 0,
};

const parentSession = {
  sessionManager: new CapturingSessionManager() as any,
  sessionID: 'parent-session',
  agentId: 'agents/parent',
};

const projectContext = {
  projectRoot: '/project',
  stateRoot: '/project',
  cwd: '/project',
};

describe('dedicated judge child lifecycle', () => {
  it('terminalizes the child as JUDGE_ERROR when execution throws', async () => {
    const outcome = await judgeOutput({
      input,
      config: { judge: './judge.agentuse', maxRedos: 1 },
      agentModel: 'openai:gpt-5-mini',
      agentFilePath: '/project/agent.agentuse',
      projectContext,
      parentSession,
    });

    expect(outcome).toEqual({ status: 'error', detail: 'judge execution failed' });
    expect({ sessionManagerConstructions, sessionCreations, logSinkCreations }).toEqual({
      sessionManagerConstructions: 1,
      sessionCreations: 1,
      logSinkCreations: 1,
    });
    expect(terminalErrors).toEqual([{
      sessionId: 'judge-session',
      agentId: 'judge',
      error: {
        code: 'JUDGE_ERROR',
        message: 'judge execution failed: judge execution failed',
      },
    }]);
    expect(completedSessions).toHaveLength(0);
    expect(sessionCreationParams?.observability).toEqual({
      role: 'verify-judge',
      attempt: 0,
      maxAttempts: 2,
    });
  });

  it('terminalizes the child as JUDGE_CANCELLED and propagates cancellation', async () => {
    const controller = new AbortController();
    controller.abort();
    runError = Object.assign(new Error('stopped'), { name: 'AbortError' });

    await expect(judgeOutput({
      input,
      config: { judge: './judge.agentuse', maxRedos: 1 },
      agentModel: 'openai:gpt-5-mini',
      agentFilePath: '/project/agent.agentuse',
      projectContext,
      parentSession,
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' });

    expect(terminalErrors).toEqual([{
      sessionId: 'judge-session',
      agentId: 'judge',
      error: {
        code: 'JUDGE_CANCELLED',
        message: 'judge execution was cancelled',
      },
    }]);
    expect(completedSessions).toHaveLength(0);
  });
});
