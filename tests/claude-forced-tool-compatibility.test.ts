import { describe, expect, it } from 'bun:test';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, tool } from 'ai';
import type { ProviderOptions } from '@ai-sdk/provider-utils';
import { z } from 'zod';
import { parseAgentContent } from '../src/parser';
import { resolveReasoning } from '../src/runner/execution';

// The runner sends toolChoice 'required' on a missing-outcome recovery turn,
// and `reasoning: none` maps to disabled thinking. Claude Opus 5.5, Sonnet 5.5
// and Fable 5.1 reject both with a 400, so the installed adapter must rewrite them.
async function captureRequest(modelId: string) {
  let body: any;
  const provider = createAnthropic({ apiKey: 'test-only', fetch: (async (_input: RequestInfo | URL, init?: RequestInit) => {
    body = JSON.parse(String(init?.body));
    throw new Error('captured-request');
  }) as unknown as typeof fetch });
  const parsed = parseAgentContent(`---\nmodel: anthropic:${modelId}\nreasoning: none\n---\nTest`, 'claude-test');
  const resolved = resolveReasoning(parsed);
  await expect(generateText({
    model: provider(modelId),
    prompt: 'Test',
    maxRetries: 0,
    tools: { report_outcome: tool({ inputSchema: z.object({ status: z.string() }) }) },
    toolChoice: 'required',
    ...(resolved.reasoning && { reasoning: resolved.reasoning }),
    ...(resolved.providerOptions && { providerOptions: resolved.providerOptions as ProviderOptions }),
  })).rejects.toThrow('captured-request');
  return body;
}

describe('Claude models that reject forced tool use and disabled thinking', () => {
  for (const modelId of ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-fable-5-1']) {
    it(`${modelId} gets auto tool choice and no disabled thinking`, async () => {
      const body = await captureRequest(modelId);
      expect(body.tool_choice.type).toBe('auto');
      expect(body.thinking?.type).not.toBe('disabled');
    });
  }

  it('Sonnet 5.5 turns reasoning off with between_tools', async () => {
    expect((await captureRequest('claude-sonnet-5-5')).thinking).toEqual({ type: 'between_tools' });
  });

  it('Claude Sonnet 5 still accepts forced tool use', async () => {
    expect((await captureRequest('claude-sonnet-5')).tool_choice.type).toBe('any');
  });
});
