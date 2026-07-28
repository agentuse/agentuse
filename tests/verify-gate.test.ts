import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
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

beforeAll(async () => {
  ({ withGateVerify, resolveVerifyPlacements, renderGatePayload } = await import('../src/verify/gate'));
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
      }, projectRoot);

      expect(text).toContain('Primary artifact: https://example.test/primary');
      expect(text).toContain('Draft artifact: https://example.test/draft');
      expect(text).toContain('Candidate A (recommended) [a]: Faster');
      expect(text).toContain('Candidate B [b]');
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
});

describe('withGateVerify', () => {
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
});
