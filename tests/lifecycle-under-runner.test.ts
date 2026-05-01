import { describe, expect, it } from 'bun:test';
import { runPostLifecycle } from '../src/runner/run';
import type { ParsedAgent } from '../src/parser';
import type { AgentCompleteEvent } from '../src/plugin';

describe('runner lifecycle', () => {
  it('emits the shared completion lifecycle event from the runner layer', async () => {
    const agent: ParsedAgent = {
      name: 'lifecycle-test',
      instructions: 'Return the response.',
      config: {
        model: 'demo:welcome'
      }
    };

    let event: AgentCompleteEvent | undefined;
    const pluginManager = {
      emitAgentComplete: async (next: AgentCompleteEvent) => {
        event = next;
      }
    } as any;

    await runPostLifecycle({
      agent,
      pluginManager,
      consoleOutput: 'captured output',
      result: {
        status: 'completed',
        text: 'Welcome',
        toolCallCount: 1,
        hasTextOutput: true,
        finishReason: 'stop'
      }
    });

    expect(event?.agent.name).toBe('lifecycle-test');
    expect(event?.result.text).toBe('Welcome');
    expect(event?.result.hasTextOutput).toBe(true);
    expect(event?.consoleOutput).toBe('captured output');
  });
});
