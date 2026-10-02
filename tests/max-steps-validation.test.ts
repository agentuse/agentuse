import { describe, expect, it } from 'bun:test';
import { PassThrough } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import { parseAgentContent } from '../src/parser';
import { InvalidRunRequestError, parseRequestBody } from '../src/cli/serve/run-request';

// A fractional step budget never matches the SDK's step-count stop condition
// (the run is unbounded) and zero or negative budgets are silently clamped, so
// every place a step budget enters a run rejects them the same way.

const invalid = [1.5, 0, -2];

function agentWith(frontmatter: string): string {
  return `---\nmodel: demo:test\n${frontmatter}\n---\nWork.`;
}

function requestWith(body: unknown): IncomingMessage {
  const stream = new PassThrough();
  stream.end(JSON.stringify(body));
  return stream as unknown as IncomingMessage;
}

describe('maxSteps validation', () => {
  for (const value of invalid) {
    it(`rejects subagents[].maxSteps ${value} like the agent's own maxSteps`, () => {
      expect(() => parseAgentContent(agentWith(`maxSteps: ${value}`), 'agent')).toThrow();
      expect(() => parseAgentContent(agentWith(`subagents:\n  - path: ./worker.agentuse\n    maxSteps: ${value}`), 'agent'))
        .toThrow();
    });

    it(`rejects a POST /run maxSteps of ${value}`, async () => {
      await expect(parseRequestBody(requestWith({ agent: 'a.agentuse', maxSteps: value })))
        .rejects.toBeInstanceOf(InvalidRunRequestError);
    });
  }

  it('rejects a non-numeric POST /run maxSteps', async () => {
    await expect(parseRequestBody(requestWith({ agent: 'a.agentuse', maxSteps: '10' })))
      .rejects.toBeInstanceOf(InvalidRunRequestError);
  });

  it('accepts positive integer budgets', async () => {
    const agent = parseAgentContent(agentWith('subagents:\n  - path: ./worker.agentuse\n    maxSteps: 7'), 'agent');
    expect(agent.config.subagents?.[0]?.maxSteps).toBe(7);
    expect(await parseRequestBody(requestWith({ agent: 'a.agentuse', maxSteps: 5 }))).toMatchObject({ maxSteps: 5 });
    expect(await parseRequestBody(requestWith({ agent: 'a.agentuse' }))).toEqual({ agent: 'a.agentuse' });
  });
});
