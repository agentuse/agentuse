import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';

// Ensure no module mocks leak from other files
mock.restore();

const judgeOutputMock = mock(async (_params: unknown): Promise<unknown> => ({
  status: 'verdict',
  verdict: { pass: true },
}));

mock.module('../src/verify/judge', () => ({
  judgeOutput: judgeOutputMock,
}));

let withGateVerify: typeof import('../src/verify/gate').withGateVerify;
let resolveVerifyPlacements: typeof import('../src/verify/gate').resolveVerifyPlacements;
let renderGatePayload: typeof import('../src/verify/gate').renderGatePayload;
let shouldDeferGateReviewToHuman: typeof import('../src/verify/gate').shouldDeferGateReviewToHuman;

beforeAll(async () => {
  ({
    withGateVerify,
    resolveVerifyPlacements,
    renderGatePayload,
    shouldDeferGateReviewToHuman,
  } = await import('../src/verify/gate'));
});

beforeEach(() => {
  judgeOutputMock.mockReset();
});

const baseOptions = {
  config: { criteria: 'high quality', maxRedos: 1 },
  agentModel: 'anthropic:claude-sonnet-5',
  task: 'Reply to tweets in Leon voice.',
};

function makeGateTool() {
  const suspend = mock(async (_input: unknown) => {
    throw new Error('SUSPENDED');
  });
  const tool = { description: 'gate', inputSchema: {}, execute: suspend } as any;
  return { tool, suspend };
}

const gateInput = {
  prompt: 'Approve this reply?',
  changes: [{ label: 'Reply to post', content: 'The draft reply text.' }],
  reference: { author: 'Peter', excerpt: 'Original tweet text.' },
};

describe('resolveVerifyPlacements', () => {
  it('defaults to gate when an approval gate exists, output otherwise', () => {
    expect([...resolveVerifyPlacements({ maxRedos: 1 }, true)]).toEqual(['gate']);
    expect([...resolveVerifyPlacements({ maxRedos: 1 }, false)]).toEqual(['output']);
  });

  it('honors explicit at, including both', () => {
    expect([...resolveVerifyPlacements({ maxRedos: 1, at: 'output' }, true)]).toEqual(['output']);
    expect([...resolveVerifyPlacements({ maxRedos: 1, at: 'both' }, false)].sort()).toEqual(['gate', 'output']);
  });
});

describe('renderGatePayload', () => {
  it('renders reference excerpt and changes content for the judge', async () => {
    const text = await renderGatePayload(gateInput);
    expect(text).toContain('Original tweet text.');
    expect(text).toContain('The draft reply text.');
    expect(text).toContain('Approve this reply?');
  });

  it('renders URLs, reviewer choices, and local artifact content', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-verify-gate-'));
    try {
      await writeFile(join(projectRoot, 'review.md'), '# Actual review artifact\nShip the complete surface.');
      const text = await renderGatePayload({
        prompt: 'Choose and approve?',
        artifact_url: 'https://example.test/primary',
        draft_url: 'https://example.test/draft',
        artifact_path: 'review.md',
        artifact_paths: ['review.md'],
        options: [
          { id: 'a', label: 'Candidate A', description: 'Faster', recommended: true },
          { id: 'b', label: 'Candidate B' },
        ],
        changes: [
          { label: 'Post B', content: 'birdc reply 1 "B"', optionId: 'b' },
        ],
      }, projectRoot);

      expect(text).toContain('Primary artifact: https://example.test/primary');
      expect(text).toContain('Draft artifact: https://example.test/draft');
      expect(text).toContain('Candidate A (recommended) [a]: Faster');
      expect(text).toContain('Candidate B [b]');
      expect(text).toContain('Reviewer choice: Candidate B [b]');
      expect(text).toContain('# Actual review artifact');
      expect(text.match(/### review\.md/g)).toHaveLength(1);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('does not read local artifacts outside the project root', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-verify-root-'));
    const outsideRoot = await mkdtemp(join(tmpdir(), 'agentuse-verify-outside-'));
    try {
      const outside = join(outsideRoot, 'secret.txt');
      await writeFile(outside, 'must-not-appear');
      const text = await renderGatePayload({
        artifact_path: outside,
      }, projectRoot);
      expect(text).not.toContain('must-not-appear');
      expect(text).toContain('content unavailable');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      await rm(outsideRoot, { recursive: true, force: true });
    }
  });

  it('does not embed secret and internal paths reached through in-project symlinks', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-verify-root-'));
    try {
      await writeFile(join(projectRoot, '.env'), 'DOTENV_SECRET=shh');
      await mkdir(join(projectRoot, '.git'), { recursive: true });
      await writeFile(join(projectRoot, '.git/config'), 'GIT_SECRET=shh');
      await mkdir(join(projectRoot, '.agentuse/store'), { recursive: true });
      await writeFile(join(projectRoot, '.agentuse/store/data.json'), 'STORE_SECRET=shh');
      await symlink(join(projectRoot, '.env'), join(projectRoot, 'env.md'));
      await symlink(join(projectRoot, '.git/config'), join(projectRoot, 'git.md'));
      await symlink(join(projectRoot, '.agentuse/store/data.json'), join(projectRoot, 'store.md'));

      const text = await renderGatePayload({
        artifact_paths: ['env.md', 'git.md', 'store.md'],
      }, projectRoot);
      expect(text).not.toContain('SECRET=shh');
      expect(text.match(/content unavailable/g)).toHaveLength(3);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('withGateVerify', () => {
  it('sends the next gate straight to the human after a real reviewer comment', async () => {
    const sessionManager = {
      getSessionMessages: async () => [{ id: 'message-1' }],
      getMessageParts: async () => [{
        type: 'tool',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Pick?', draft: 'Original slate' },
          output: {
            status: 'commented',
            comment: 'reply "very nice!"',
            reviewer: { username: 'web' },
          },
        },
      }],
      addPart: async () => 'verify-part',
    } as any;
    const { tool, suspend } = makeGateTool();
    const wrapped = withGateVerify(tool, {
      ...baseOptions,
      sessionManager,
      sessionID: 'session-1',
      agentId: 'agents/reply',
      messageID: 'message-2',
    });

    await expect((wrapped.execute as any)(gateInput, {})).rejects.toThrow('SUSPENDED');
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(judgeOutputMock).toHaveBeenCalledTimes(0);
  });

  it('does not let a machine pre-review bounce bypass the next judge', async () => {
    judgeOutputMock.mockImplementation(async () => ({ status: 'verdict', verdict: { pass: true } }));
    const sessionManager = {
      getSessionMessages: async () => [{ id: 'message-1' }],
      getMessageParts: async () => [{
        type: 'tool',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Draft?', draft: 'Failed draft' },
          output: {
            status: 'rejected',
            source: 'pre-review',
            comment: 'rewrite this',
            reviewer: { username: 'verify-judge' },
          },
        },
      }],
      addPart: async () => 'verify-part',
    } as any;
    const { tool, suspend } = makeGateTool();
    const wrapped = withGateVerify(tool, {
      ...baseOptions,
      sessionManager,
      sessionID: 'session-1',
      agentId: 'agents/reply',
      messageID: 'message-2',
    });

    await expect((wrapped.execute as any)(gateInput, {})).rejects.toThrow('SUSPENDED');
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(judgeOutputMock).toHaveBeenCalledTimes(1);
  });

  it('limits the human-comment bypass to the latest review cycle', () => {
    expect(shouldDeferGateReviewToHuman([
      { status: 'commented', comment: 'revise this' },
    ])).toBe(true);
    expect(shouldDeferGateReviewToHuman([
      { status: 'commented', comment: 'revise this' },
      { status: 'approved' },
    ])).toBe(false);
    expect(shouldDeferGateReviewToHuman([
      { status: 'commented' },
    ])).toBe(false);
  });

  it('suspends normally on a pass verdict', async () => {
    judgeOutputMock.mockImplementation(async () => ({ status: 'verdict', verdict: { pass: true } }));
    const { tool, suspend } = makeGateTool();
    const wrapped = withGateVerify(tool, baseOptions);
    await expect((wrapped.execute as any)(gateInput, {})).rejects.toThrow('SUSPENDED');
    expect(suspend).toHaveBeenCalledTimes(1);
  });

  it('returns a rejection-with-comment result on fail, without suspending', async () => {
    judgeOutputMock.mockImplementation(async () => ({
      status: 'verdict',
      verdict: { pass: false, critique: 'Restates the target; add a concrete example.' },
    }));
    const { tool, suspend } = makeGateTool();
    const wrapped = withGateVerify(tool, baseOptions);
    const result = await (wrapped.execute as any)(gateInput, {});
    expect(suspend).toHaveBeenCalledTimes(0);
    expect(result.status).toBe('rejected');
    expect(result.comment).toContain('Restates the target');
    expect(result.comment).toContain('Automated pre-review');
    expect(result.reviewer).toEqual({ username: 'verify-judge' });
    expect(result.source).toBe('pre-review');
  });

  it('fails open to the human after maxRedos rejections', async () => {
    judgeOutputMock.mockImplementation(async () => ({
      status: 'verdict',
      verdict: { pass: false, critique: 'Still not good.' },
    }));
    const { tool, suspend } = makeGateTool();
    const wrapped = withGateVerify(tool, { ...baseOptions, config: { criteria: 'q', maxRedos: 1 } });
    const first = await (wrapped.execute as any)(gateInput, {});
    expect(first.status).toBe('rejected');
    // Second gate call: budget exhausted, escalate to human (suspend) without judging.
    judgeOutputMock.mockClear();
    await expect((wrapped.execute as any)(gateInput, {})).rejects.toThrow('SUSPENDED');
    expect(judgeOutputMock).toHaveBeenCalledTimes(0);
    expect(suspend).toHaveBeenCalledTimes(1);
  });

  it('judges the initial candidate when maxRedos is zero, then escalates a failure', async () => {
    judgeOutputMock.mockImplementation(async () => ({
      status: 'verdict',
      verdict: { pass: false, critique: 'Initial draft misses the requirement.' },
    }));
    const { tool, suspend } = makeGateTool();
    const wrapped = withGateVerify(tool, { ...baseOptions, config: { criteria: 'q', maxRedos: 0 } });

    await expect((wrapped.execute as any)(gateInput, {})).rejects.toThrow('SUSPENDED');
    expect(judgeOutputMock).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(1);
  });

  it('fails open to the human on a judge error', async () => {
    judgeOutputMock.mockImplementation(async () => ({ status: 'error', detail: 'auth expired' }));
    const { tool, suspend } = makeGateTool();
    const wrapped = withGateVerify(tool, baseOptions);
    await expect((wrapped.execute as any)(gateInput, {})).rejects.toThrow('SUSPENDED');
    expect(suspend).toHaveBeenCalledTimes(1);
  });

  it('passes attempt count to the judge across bounces', async () => {
    const attempts: number[] = [];
    judgeOutputMock.mockImplementation(async (params: any) => {
      attempts.push(params.input.attempt);
      return { status: 'verdict', verdict: { pass: false, critique: 'no' } };
    });
    const { tool } = makeGateTool();
    const wrapped = withGateVerify(tool, { ...baseOptions, config: { criteria: 'q', maxRedos: 3 } });
    await (wrapped.execute as any)(gateInput, {});
    await (wrapped.execute as any)(gateInput, {});
    expect(attempts).toEqual([0, 1]);
  });

  it('passes bounded prior human decisions to a gate-aware judge prompt', async () => {
    let capturedInput: any;
    judgeOutputMock.mockImplementation(async (params: any) => {
      capturedInput = params.input;
      return { status: 'verdict', verdict: { pass: true } };
    });
    const sessionManager = {
      getSessionMessages: async () => [{ id: 'message-1' }],
      getMessageParts: async () => [{
        type: 'tool',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: {
            prompt: 'Pick one?',
            options: [{ id: 'b', label: 'Candidate B' }, { id: 'c', label: 'Candidate C' }],
            changes: [{ content: 'Chosen copy', optionId: 'b' }],
          },
          output: {
            status: 'approved',
            choice: 'b',
            comment: 'Keep the team-vs-solo framing',
            reviewer: { username: 'leon' },
          },
        },
      }],
      addPart: async () => 'verify-part',
    } as any;
    const { tool } = makeGateTool();
    const wrapped = withGateVerify(tool, {
      ...baseOptions,
      sessionManager,
      sessionID: 'session-1',
      agentId: 'agents/reply',
      messageID: 'message-2',
    });

    await expect((wrapped.execute as any)(gateInput, {})).rejects.toThrow('SUSPENDED');
    expect(capturedInput.kind).toBe('gate');
    expect(capturedInput.reviewHistory).toContain('Decision: approved');
    expect(capturedInput.reviewHistory).toContain('Selected option: b');
    expect(capturedInput.reviewHistory).toContain('Keep the team-vs-solo framing');
    expect(capturedInput.reviewHistory).toContain('choice: Candidate B [b]');
  });
});

describe('slate candidates', () => {
  let extractGateCandidates: typeof import('../src/verify/gate').extractGateCandidates;
  let reconcileCandidateVerdicts: typeof import('../src/verify/gate').reconcileCandidateVerdicts;
  beforeAll(async () => {
    ({ extractGateCandidates, reconcileCandidateVerdicts } = await import('../src/verify/gate'));
  });

  const slate = {
    prompt: 'Which post should be scheduled?',
    options: [{ id: 'A', label: 'Option A' }, { id: 'B', label: 'Option B' }, { id: 'C', label: 'Option C' }],
    changes: [
      { label: 'Post', optionId: 'A', content: 'post A' },
      { label: 'Post', optionId: 'B', content: 'post B' },
      { label: 'Post', optionId: 'C', content: 'post C' },
    ],
  };

  it('keys slate candidates by optionId and single drafts by position', () => {
    expect(extractGateCandidates(slate).map((c) => [c.id, c.label, c.text])).toEqual([
      ['A', 'Option A', 'post A'], ['B', 'Option B', 'post B'], ['C', 'Option C', 'post C'],
    ]);
    expect(extractGateCandidates(gateInput).map((c) => c.id)).toEqual(['change-1']);
    expect(extractGateCandidates({ draft: 'only a draft' }).map((c) => c.id)).toEqual(['draft']);
    expect(extractGateCandidates({ prompt: 'nothing reviewable' })).toEqual([]);
  });

  it('merges two changes under one option into one candidate', () => {
    const candidates = extractGateCandidates({
      options: [{ id: 'A', label: 'A' }],
      changes: [{ optionId: 'A', content: 'post' }, { optionId: 'A', content: 'first comment' }],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.text).toContain('first comment');
  });

  it('keeps a settled candidate passing even when the judge fails it again', () => {
    const candidates = extractGateCandidates(slate);
    const verdict = reconcileCandidateVerdicts(
      { pass: false, critique: 'A overclaims', candidates: [
        { id: 'A', pass: false, critique: 'A overclaims' }, { id: 'B', pass: true }, { id: 'C', pass: true },
      ] },
      candidates,
      new Set(['A'])
    );
    expect(verdict.pass).toBe(true);
    expect(verdict.candidates).toMatchObject([
      { id: 'A', pass: true, settled: true }, { id: 'B', pass: true }, { id: 'C', pass: true },
    ]);
    expect(verdict.candidates!.every((entry) => typeof entry.fingerprint === 'string')).toBe(true);
  });

  it('lists every failing candidate in one critique and inherits the slate verdict for skipped ones', () => {
    const candidates = extractGateCandidates(slate);
    const verdict = reconcileCandidateVerdicts(
      { pass: false, critique: 'slate fails', candidates: [
        { id: 'A', pass: false, critique: 'A too long' }, { id: 'C', pass: false, critique: 'C unsupported claim' },
      ] },
      candidates,
      new Set()
    );
    expect(verdict.pass).toBe(false);
    expect(verdict.critique).toBe('A: A too long\nB: slate fails\nC: C unsupported claim');
  });

  it('carries a passed candidate forward across bounces and skips the judge when nothing changed', async () => {
    const { tool, suspend } = makeGateTool();
    const parts: unknown[] = [];
    const sessionManager = { addPart: mock(async (_s: string, _a: string, _m: string, part: unknown) => { parts.push(part); }) } as any;
    const gated = withGateVerify(tool, {
      ...baseOptions,
      config: { criteria: 'high quality', maxRedos: 2 },
      sessionManager, sessionID: 'sess', agentId: 'agent', messageID: 'msg',
    });

    // Attempt 1: A and B pass, C fails.
    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: false, critique: 'C fails', candidates: [
      { id: 'A', pass: true }, { id: 'B', pass: true }, { id: 'C', pass: false, critique: 'C overclaims' },
    ] } });
    const first = await gated.execute(slate, {}) as { status: string; comment: string };
    expect(first.status).toBe('rejected');
    expect(first.comment).toContain('C: C overclaims');
    expect(first.comment).toContain('A, B passed');

    // Attempt 2: the agent revises C; the judge now fails A (which is unchanged).
    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: false, critique: 'A fails now', candidates: [
      { id: 'A', pass: false, critique: 'A changed my mind' }, { id: 'B', pass: true }, { id: 'C', pass: true },
    ] } });
    const revised = { ...slate, changes: slate.changes.map((c) => c.optionId === 'C' ? { ...c, content: 'post C v2' } : c) };
    await expect(gated.execute(revised, {})).rejects.toThrow('SUSPENDED');
    expect(suspend).toHaveBeenCalledTimes(1);

    const secondCall = judgeOutputMock.mock.calls[1]![0] as { input: { settledCandidateIds?: string[] } };
    expect(secondCall.input.settledCandidateIds?.sort()).toEqual(['A', 'B']);
    const passPart = parts[1] as { verdict: string; candidates: Array<{ id: string; pass: boolean; settled?: boolean }> };
    expect(passPart.verdict).toBe('pass');
    expect(passPart.candidates.find((c) => c.id === 'A')).toMatchObject({ id: 'A', pass: true, settled: true });
  });

  it('does not call the judge at all when every candidate already passed unchanged', async () => {
    const { tool, suspend } = makeGateTool();
    const gated = withGateVerify(tool, { ...baseOptions, config: { criteria: 'q', maxRedos: 2 } });
    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: true, candidates: [
      { id: 'A', pass: true }, { id: 'B', pass: true }, { id: 'C', pass: true },
    ] } });
    await expect(gated.execute(slate, {})).rejects.toThrow('SUSPENDED');
    await expect(gated.execute(slate, {})).rejects.toThrow('SUSPENDED');
    expect(judgeOutputMock).toHaveBeenCalledTimes(1);
    expect(suspend).toHaveBeenCalledTimes(2);
  });
});

describe('unjudged gates and verdict fingerprints', () => {
  let fingerprintText: typeof import('../src/verify/candidates').fingerprintText;
  beforeAll(async () => { ({ fingerprintText } = await import('../src/verify/candidates')); });

  const slate = {
    prompt: 'Which post?',
    options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
    changes: [{ optionId: 'A', content: 'post A' }, { optionId: 'B', content: 'post B' }],
  };

  it('stamps each recorded candidate with the fingerprint of the text it judged', async () => {
    const { tool } = makeGateTool();
    const parts: any[] = [];
    const sessionManager = { addPart: mock(async (_s: string, _a: string, _m: string, part: unknown) => { parts.push(part); }) } as any;
    const gated = withGateVerify(tool, { ...baseOptions, config: { criteria: 'q', maxRedos: 2 }, sessionManager, sessionID: 's', agentId: 'a', messageID: 'm' });
    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: false, critique: 'A bad', candidates: [{ id: 'A', pass: false, critique: 'A bad' }, { id: 'B', pass: true }] } });
    await gated.execute(slate, {});
    expect(parts[0].candidates.map((c: any) => [c.id, c.fingerprint])).toEqual([
      ['A', fingerprintText('post A')], ['B', fingerprintText('post B')],
    ]);
  });

  it('records a skipped marker when the redo budget is spent, so the card knows nothing judged the final text', async () => {
    const { tool, suspend } = makeGateTool();
    const parts: any[] = [];
    const sessionManager = { addPart: mock(async (_s: string, _a: string, _m: string, part: unknown) => { parts.push(part); }) } as any;
    const gated = withGateVerify(tool, { ...baseOptions, config: { criteria: 'q', maxRedos: 1 }, sessionManager, sessionID: 's', agentId: 'a', messageID: 'm' });
    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: false, critique: 'too long' } });
    await gated.execute(gateInput, {});
    await expect(gated.execute({ ...gateInput, changes: [{ label: 'Reply', content: 'shorter' }] }, {})).rejects.toThrow('SUSPENDED');
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(judgeOutputMock).toHaveBeenCalledTimes(1);
    expect(parts.map((p) => p.verdict)).toEqual(['fail', 'skipped']);
    expect(parts[1]).toMatchObject({ attempt: 1, maxRedos: 1 });
    expect(parts[1].critique).toContain('budget spent');
  });

  it('records a skipped marker when a reviewer comment routes the revision straight back', async () => {
    const parts: any[] = [];
    const sessionManager = {
      getSessionMessages: async () => [{ id: 'message-1' }],
      getMessageParts: async () => [{
        type: 'tool',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Pick?', draft: 'Original slate' },
          output: { status: 'commented', comment: 'Cut the second sentence', reviewer: { username: 'web' } },
        },
      }],
      addPart: async (_s: string, _a: string, _m: string, part: unknown) => { parts.push(part); },
    } as any;
    const { tool, suspend } = makeGateTool();
    const gated = withGateVerify(tool, { ...baseOptions, sessionManager, sessionID: 's', agentId: 'a', messageID: 'm' });
    await expect(gated.execute(gateInput, {})).rejects.toThrow('SUSPENDED');
    expect(suspend).toHaveBeenCalledTimes(1);
    expect(judgeOutputMock).not.toHaveBeenCalled();
    expect(parts.map((p) => p.verdict)).toEqual(['skipped']);
    expect(parts[0].critique).toContain('reviewer who commented');
  });
});

describe('fingerprintText', () => {
  it('is stable for equal text and differs on any change', async () => {
    const { fingerprintText } = await import('../src/verify/candidates');
    expect(fingerprintText('hello')).toBe(fingerprintText('hello'));
    expect(fingerprintText('hello')).not.toBe(fingerprintText('hello!'));
    expect(fingerprintText('hello')).toMatch(/^[0-9a-f]{8}:5$/);
  });
});

describe('judge session reuse across attempts', () => {
  const slate = {
    prompt: 'Which post?',
    options: [{ id: 'A', label: 'A' }, { id: 'B', label: 'B' }],
    changes: [{ optionId: 'A', content: 'post A' }, { optionId: 'B', content: 'post B' }],
  };
  const handle = { sessionID: 'judge-1', agentId: 'judge', messageID: 'm', judgePath: '/j.agentuse', firstAttempt: 0, lastAttempt: 0, historyChars: 100 };

  it('passes the previous judge session and the changed candidates on the next attempt, and drops it on suspend', async () => {
    const { tool } = makeGateTool();
    const gated = withGateVerify(tool, { ...baseOptions, config: { judge: './j.agentuse', maxRedos: 3 } });

    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: false, critique: 'B weak', candidates: [{ id: 'A', pass: true }, { id: 'B', pass: false, critique: 'B weak' }] }, session: handle });
    await gated.execute(slate, {});
    const firstCall = judgeOutputMock.mock.calls[0]![0] as { input: Record<string, unknown> };
    expect(firstCall.input.resume).toBeUndefined();

    const revised = { ...slate, changes: [{ optionId: 'A', content: 'post A' }, { optionId: 'B', content: 'post B v2' }] };
    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: true, candidates: [{ id: 'A', pass: true }, { id: 'B', pass: true }] }, session: { ...handle, lastAttempt: 1 } });
    await expect(gated.execute(revised, {})).rejects.toThrow('SUSPENDED');
    const secondCall = judgeOutputMock.mock.calls[1]![0] as { input: Record<string, unknown> };
    expect(secondCall.input.resume).toEqual(handle);
    expect(secondCall.input.changedCandidateIds).toEqual(['B']);
    expect(secondCall.input.settledCandidateIds).toEqual(['A']);

    // The gate suspended to the human: a later gate in the same segment starts a fresh judge.
    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: false, critique: 'x' } });
    await gated.execute({ ...slate, prompt: 'Confirm the exact command?' }, {});
    const thirdCall = judgeOutputMock.mock.calls[2]![0] as { input: Record<string, unknown> };
    expect(thirdCall.input.resume).toBeUndefined();
  });

  it('drops the judge session after a judge error', async () => {
    const { tool } = makeGateTool();
    const gated = withGateVerify(tool, { ...baseOptions, config: { judge: './j.agentuse', maxRedos: 3 } });
    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: false, critique: 'no' }, session: handle });
    await gated.execute(gateInput, {});
    judgeOutputMock.mockResolvedValueOnce({ status: 'error', detail: 'boom' });
    await expect(gated.execute({ ...gateInput, changes: [{ label: 'Reply', content: 'v2' }] }, {})).rejects.toThrow('SUSPENDED');
    judgeOutputMock.mockResolvedValueOnce({ status: 'verdict', verdict: { pass: true } });
    await expect(gated.execute({ ...gateInput, changes: [{ label: 'Reply', content: 'v3' }] }, {})).rejects.toThrow('SUSPENDED');
    const thirdCall = judgeOutputMock.mock.calls[2]![0] as { input: Record<string, unknown> };
    expect(thirdCall.input.resume).toBeUndefined();
  });
});
