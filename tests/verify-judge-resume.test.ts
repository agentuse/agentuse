import { beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';

mock.restore();

// One judge session per gate cycle: the second attempt resumes the first
// attempt's child session instead of opening a new one. These tests pin the
// plumbing: no new session, history rehydrated from the judge's own session,
// the revision turn appended and persisted, and the handle returned so the
// gate can resume again.

let sessionCreations = 0;
let rehydrateCalls: Array<{ sessionID: string; agentId: string }> = [];
let coreOptions: any[] = [];
let addedParts: any[] = [];
let sessionUpdates: any[] = [];
let runningSessions: string[] = [];
let completedSessions: string[] = [];
let parentPathsSet: string[] = [];
let judgeReplyText = '{"pass": true, "critique": "fine"}';

class CapturingSessionManager {
  getFullPath(): string { return '/store/parent-session'; }
  setParentPath(path: string): void { parentPathsSet.push(path); }
  async updateMessage(): Promise<void> {}
  async setSessionCompleted(sessionId: string): Promise<void> { completedSessions.push(sessionId); }
  async setSessionError(): Promise<void> {}
  async setSessionRunning(sessionId: string): Promise<void> { runningSessions.push(sessionId); }
  async updateSession(_sessionId: string, _agentId: string, updates: unknown): Promise<void> { sessionUpdates.push(updates); }
  async addPart(_s: string, _a: string, _m: string, part: unknown): Promise<string> { addedParts.push(part); return 'part'; }
}

mock.module('../src/parser', () => ({
  parseAgent: async () => ({
    name: 'reply-judge',
    description: 'test judge',
    instructions: 'Judge strictly.',
    config: { model: 'openai:gpt-5-mini' },
  }),
}));
mock.module('../src/mcp', () => ({ connectMCP: async () => [] }));
mock.module('../src/runner/tools-loader', () => ({ loadAgentTools: async () => ({ all: {} }) }));
mock.module('../src/runner/system-messages', () => ({ buildSystemMessages: async () => ({ messages: [] }) }));
mock.module('../src/runner/execution', () => ({
  executeAgentCore: (_agent: unknown, _tools: unknown, options: unknown) => { coreOptions.push(options); return {}; },
}));
mock.module('../src/runner/stream', () => ({
  processAgentStream: async () => ({ text: judgeReplyText, usage: { inputTokens: 10, outputTokens: 5 }, parts: [] }),
}));
mock.module('../src/session/manager', () => ({ SessionManager: CapturingSessionManager }));
mock.module('../src/session/rehydrate', () => ({
  rehydrateMessages: async (_m: unknown, sessionID: string, agentId: string) => {
    rehydrateCalls.push({ sessionID, agentId });
    return [
      { role: 'user', content: 'Judge strictly.\n\nfirst request' },
      { role: 'assistant', content: 'A fails, B passes. {"pass": false}' },
    ];
  },
}));
mock.module('../src/runner/session-helper', () => ({
  createSessionAndMessage: async () => {
    sessionCreations++;
    return { sessionID: 'judge-session', messageID: 'judge-message' };
  },
  createSessionLogSink: () => ({ capture: () => {}, flush: async () => {} }),
}));

let judgeOutput: typeof import('../src/verify/judge').judgeOutput;
let JUDGE_RESUME_MAX_HISTORY_CHARS: number;

beforeAll(async () => {
  ({ judgeOutput, JUDGE_RESUME_MAX_HISTORY_CHARS } = await import('../src/verify/judge'));
});

beforeEach(() => {
  sessionCreations = 0;
  rehydrateCalls = [];
  coreOptions = [];
  addedParts = [];
  sessionUpdates = [];
  runningSessions = [];
  completedSessions = [];
  parentPathsSet = [];
  judgeReplyText = '{"pass": true, "critique": "fine"}';
});

const parentSession = {
  sessionManager: new CapturingSessionManager() as any,
  sessionID: 'parent-session',
  agentId: 'agents/parent',
};
const projectContext = { projectRoot: '/project', stateRoot: '/project', cwd: '/project' };
const config = { judge: './judge.agentuse', maxRedos: 3 };
const candidates = [
  { id: 'A', label: 'Option A', text: 'post A' },
  { id: 'B', label: 'Option B', text: 'post B v2' },
];

describe('judge session resume', () => {
  it('returns a session handle with the first verdict', async () => {
    const outcome = await judgeOutput({
      input: { kind: 'gate', task: 'reply', output: 'first request', attempt: 0, candidates },
      config, agentModel: 'openai:gpt-5-mini', agentFilePath: '/project/agent.agentuse', projectContext, parentSession,
    });
    expect(outcome.status).toBe('verdict');
    expect(sessionCreations).toBe(1);
    expect(rehydrateCalls).toEqual([]);
    const session = (outcome as any).session;
    expect(session).toMatchObject({ sessionID: 'judge-session', messageID: 'judge-message', firstAttempt: 0, lastAttempt: 0 });
    expect(session.judgePath.endsWith('/project/judge.agentuse')).toBe(true);
    expect(session.historyChars).toBeGreaterThan(0);
  });

  it('resumes the same judge session on the next attempt and sends only the revision', async () => {
    const first = await judgeOutput({
      input: { kind: 'gate', task: 'reply', output: 'first request', attempt: 0, candidates },
      config, agentModel: 'openai:gpt-5-mini', agentFilePath: '/project/agent.agentuse', projectContext, parentSession,
    });
    const handle = (first as any).session;
    sessionCreations = 0; coreOptions = []; addedParts = [];

    const second = await judgeOutput({
      input: {
        kind: 'gate', task: 'reply', output: 'revised request', attempt: 1, candidates,
        settledCandidateIds: ['A'], changedCandidateIds: ['B'], resume: handle,
      },
      config, agentModel: 'openai:gpt-5-mini', agentFilePath: '/project/agent.agentuse', projectContext, parentSession,
    });

    expect(second.status).toBe('verdict');
    expect(sessionCreations).toBe(0);
    expect(rehydrateCalls).toEqual([{ sessionID: 'judge-session', agentId: 'judge' }]);
    // The manager for the resumed session is rooted under the parent, like a fresh one.
    expect(parentPathsSet.at(-1)).toBe('/store/parent-session');
    // Model-facing history = the judge's own prior turns + the revision as the new user turn.
    const options = coreOptions[0];
    expect(options.messages).toHaveLength(3);
    expect(options.messages[2].role).toBe('user');
    expect(options.messages[2].content).toContain('Revised approval request (attempt 2)');
    expect(options.messages[2].content).toContain('A: Option A — unchanged and already passed');
    expect(options.messages[2].content).toContain('B: Option B — REVISED');
    expect(options.messages[2].content).not.toContain('Judge strictly.\n\n## Revised');
    // The revision turn is persisted on the judge session, the session re-runs, then completes.
    expect(addedParts).toMatchObject([{ type: 'text', role: 'user', synthetic: true }]);
    expect(runningSessions).toEqual(['judge-session']);
    expect(sessionUpdates).toMatchObject([{ observability: { role: 'verify-judge', attempt: 0, lastAttempt: 1, maxAttempts: 4 } }]);
    expect(completedSessions).toContain('judge-session');
    expect((second as any).session).toMatchObject({ sessionID: 'judge-session', firstAttempt: 0, lastAttempt: 1 });
  });

  it('opens a fresh session when the handle is for another judge or its history is full', async () => {
    const base = { kind: 'gate' as const, task: 'reply', output: 'revised', attempt: 1, candidates };
    const stale = { sessionID: 'judge-session', agentId: 'judge', messageID: 'judge-message', judgePath: '/elsewhere/other-judge.agentuse', firstAttempt: 0, lastAttempt: 0, historyChars: 10 };
    await judgeOutput({ input: { ...base, resume: stale }, config, agentModel: 'openai:gpt-5-mini', agentFilePath: '/project/agent.agentuse', projectContext, parentSession });
    expect(sessionCreations).toBe(1);
    expect(rehydrateCalls).toEqual([]);

    sessionCreations = 0;
    const full = { ...stale, judgePath: '/project/judge.agentuse', historyChars: JUDGE_RESUME_MAX_HISTORY_CHARS + 1 };
    await judgeOutput({ input: { ...base, resume: full }, config, agentModel: 'openai:gpt-5-mini', agentFilePath: '/project/agent.agentuse', projectContext, parentSession });
    expect(sessionCreations).toBe(1);
    expect(rehydrateCalls).toEqual([]);
  });
});
