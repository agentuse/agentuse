import { afterEach, describe, expect, it } from 'bun:test';
import { logger } from '../src/utils/logger';
import { sdkTelemetryIntegration } from '../src/telemetry/sdk-telemetry';

const originalDebug = logger.debug.bind(logger);

afterEach(() => {
  logger.debug = originalDebug;
});

describe('SDK telemetry', () => {
  it('names tool calls and records per-model-call phase timing', async () => {
    const lines: string[] = [];
    logger.debug = (message: string) => { lines.push(message); };
    sdkTelemetryIntegration.onLanguageModelCallStart({ provider: 'openai', modelId: 'gpt-test', callId: 'model-1' });
    sdkTelemetryIntegration.onLanguageModelCallEnd({
      provider: 'openai', modelId: 'gpt-test', callId: 'model-1', finishReason: 'tool-calls',
      usage: { inputTokens: 120, outputTokens: 30 },
      performance: { responseTimeMs: 1_234.4, timeToFirstOutputMs: 456.2 },
    });
    sdkTelemetryIntegration.onToolExecutionStart({ toolCall: { toolName: 'tools__bash', toolCallId: 'tool-1' } });
    sdkTelemetryIntegration.onToolExecutionEnd({
      toolCall: { toolName: 'tools__bash', toolCallId: 'tool-1' },
      success: true,
      toolExecutionMs: 789.4,
    });

    expect(lines).toContain('[SDKTelemetry] model-call-start openai:gpt-test callId=model-1');
    expect(lines).toContain('[SDKTelemetry] model-call-end openai:gpt-test callId=model-1 finish=tool-calls duration=1234ms ttft=456ms input=120 output=30');
    expect(lines).toContain('[SDKTelemetry] tool-execution-start tools__bash callId=tool-1');
    expect(lines).toContain('[SDKTelemetry] tool-execution-end tools__bash callId=tool-1 ok duration=789ms');
  });
});
