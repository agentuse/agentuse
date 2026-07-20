import { describe, it, expect, beforeAll, beforeEach, mock } from 'bun:test';

// Ensure no module mocks leak from other files
mock.restore();

const completeTextMock = mock(async (_model: string, _options?: unknown) => '{"pass": true, "critique": ""}');

mock.module('../src/complete-text', () => ({
  completeText: completeTextMock,
}));

let judgeOutput: typeof import('../src/verify/judge').judgeOutput;
let extractVerdict: typeof import('../src/verify/judge').extractVerdict;

beforeAll(async () => {
  ({ judgeOutput, extractVerdict } = await import('../src/verify/judge'));
});

beforeEach(() => {
  completeTextMock.mockReset();
});

describe('extractVerdict', () => {
  it('parses a bare verdict object', () => {
    expect(extractVerdict('{"pass": true, "critique": ""}')).toEqual({ pass: true });
  });

  it('prefers the trailing verdict after free-form reasoning', () => {
    const text = `## Reply Judge Verdict
Candidate 1: REJECT - restates the target's framing.

{"pass": false, "critique": "The reply restates the target's own point. Add one distinct layer: a concrete counter-example from practice."}`;
    const verdict = extractVerdict(text);
    expect(verdict?.pass).toBe(false);
    expect(verdict?.critique).toContain('distinct layer');
  });

  it('returns null when no verdict JSON exists', () => {
    expect(extractVerdict('all good, ship it')).toBeNull();
  });

  it('normalizes an empty critique to undefined', () => {
    expect(extractVerdict('{"pass": true, "critique": "   "}')).toEqual({ pass: true });
  });
});

describe('judgeOutput (built-in judge)', () => {
  const input = { task: 'Write a summary', output: 'A summary.', attempt: 0 };
  const config = { criteria: 'complete and grounded', maxRedos: 1 };

  it('returns a pass verdict', async () => {
    completeTextMock.mockImplementation(async () => 'Looks solid.\n{"pass": true, "critique": ""}');
    const outcome = await judgeOutput({ input, config, agentModel: 'anthropic:claude-sonnet-4-0' });
    expect(outcome).toEqual({ status: 'verdict', verdict: { pass: true } });
  });

  it('returns a fail verdict with the critique', async () => {
    completeTextMock.mockImplementation(async () =>
      '{"pass": false, "critique": "Missing the second section; add the risks list."}');
    const outcome = await judgeOutput({ input, config, agentModel: 'anthropic:claude-sonnet-4-0' });
    expect(outcome.status).toBe('verdict');
    if (outcome.status === 'verdict') {
      expect(outcome.verdict.pass).toBe(false);
      expect(outcome.verdict.critique).toContain('risks list');
    }
  });

  it('treats a fail without critique as a judge error', async () => {
    completeTextMock.mockImplementation(async () => '{"pass": false}');
    const outcome = await judgeOutput({ input, config, agentModel: 'anthropic:claude-sonnet-4-0' });
    expect(outcome.status).toBe('error');
  });

  it('treats unparseable output as a judge error', async () => {
    completeTextMock.mockImplementation(async () => 'PASS');
    const outcome = await judgeOutput({ input, config, agentModel: 'anthropic:claude-sonnet-4-0' });
    expect(outcome).toEqual({ status: 'error', detail: 'judge returned no parseable verdict JSON' });
  });

  it('degrades a thrown model error to an error outcome', async () => {
    completeTextMock.mockImplementation(async () => { throw new Error('auth expired'); });
    const outcome = await judgeOutput({ input, config, agentModel: 'anthropic:claude-sonnet-4-0' });
    expect(outcome).toEqual({ status: 'error', detail: 'auth expired' });
  });

  it('uses the agent model by default and the config model when set', async () => {
    const calls: string[] = [];
    completeTextMock.mockImplementation(async (model: string) => {
      calls.push(model);
      return '{"pass": true}';
    });
    await judgeOutput({ input, config, agentModel: 'anthropic:claude-sonnet-4-0' });
    await judgeOutput({
      input,
      config: { ...config, model: 'openai:gpt-5.2-mini' },
      agentModel: 'anthropic:claude-sonnet-4-0',
    });
    expect(calls).toEqual(['anthropic:claude-sonnet-4-0', 'openai:gpt-5.2-mini']);
  });
});
