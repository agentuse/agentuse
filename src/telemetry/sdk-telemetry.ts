// Namespace import: test suites mock the 'ai' module with a partial export
// set, and a named import of a missing export is a load-time error in ESM.
import * as ai from 'ai';
import { logger } from '../utils/logger';

/**
 * SDK-layer execution witness (agentuse-lab#165, Phase 2).
 *
 * The AI SDK v7 publishes lifecycle events (steps, model calls, tool
 * executions) through its telemetry integration API (backed by the
 * `ai:telemetry` node:diagnostics_channel). Registering this integration gives
 * a second, SDK-side record of every tool execution - independent of both the
 * stream consumer (which a suspension abandons) and our own execute wrapper
 * (which future tool sources might bypass). It complements the effect WAL; it
 * does not replace it.
 *
 * Debug-level only: the WAL is the durable journal, this is the live trace.
 */
let registered = false;

function toolIdentity(event: any): { name: string; callId?: string } {
  const call = event?.toolCall;
  const name = typeof call?.toolName === 'string'
    ? call.toolName
    : typeof event?.toolName === 'string'
      ? event.toolName
      : 'unknown';
  const callId = typeof call?.toolCallId === 'string'
    ? call.toolCallId
    : typeof event?.toolCallId === 'string'
      ? event.toolCallId
      : undefined;
  return { name, ...(callId && { callId }) };
}

function finiteMetric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? Math.round(value) : undefined;
}

/** Exported for deterministic contract tests; production registers this exact
 * object once with the AI SDK. */
export const sdkTelemetryIntegration = {
  onLanguageModelCallStart: (event: any) => {
    const model = [event?.provider, event?.modelId].filter(Boolean).join(':') || 'unknown';
    logger.debug(
      `[SDKTelemetry] model-call-start ${model}${event?.callId ? ` callId=${event.callId}` : ''}`
    );
  },
  onLanguageModelCallEnd: (event: any) => {
    const model = [event?.provider, event?.modelId].filter(Boolean).join(':') || 'unknown';
    const responseMs = finiteMetric(event?.performance?.responseTimeMs);
    const ttftMs = finiteMetric(event?.performance?.timeToFirstOutputMs);
    const input = finiteMetric(event?.usage?.inputTokens);
    const output = finiteMetric(event?.usage?.outputTokens);
    logger.debug([
      `[SDKTelemetry] model-call-end ${model}`,
      event?.callId ? `callId=${event.callId}` : undefined,
      event?.finishReason ? `finish=${event.finishReason}` : undefined,
      responseMs !== undefined ? `duration=${responseMs}ms` : undefined,
      ttftMs !== undefined ? `ttft=${ttftMs}ms` : undefined,
      input !== undefined ? `input=${input}` : undefined,
      output !== undefined ? `output=${output}` : undefined,
    ].filter(Boolean).join(' '));
  },
  onToolExecutionStart: (event: any) => {
    const tool = toolIdentity(event);
    logger.debug(
      `[SDKTelemetry] tool-execution-start ${tool.name}${tool.callId ? ` callId=${tool.callId}` : ''}`
    );
  },
  onToolExecutionEnd: (event: any) => {
    const tool = toolIdentity(event);
    const outcome = event?.success === false ? `error=${String(event?.error ?? 'unknown')}` : 'ok';
    logger.debug(
      `[SDKTelemetry] tool-execution-end ${tool.name}${tool.callId ? ` callId=${tool.callId}` : ''} ${outcome}${typeof event?.toolExecutionMs === 'number' ? ` duration=${Math.round(event.toolExecutionMs)}ms` : ''}`
    );
  },
  onAbort: () => {
    logger.debug('[SDKTelemetry] generation aborted');
  },
};

export function registerSDKTelemetryOnce(): void {
  if (registered) return;
  registered = true;
  const registerTelemetry = (ai as { registerTelemetry?: (integration: unknown) => void }).registerTelemetry;
  if (typeof registerTelemetry !== 'function') return;
  try {
    registerTelemetry(sdkTelemetryIntegration);
  } catch (error) {
    logger.debug(`[SDKTelemetry] registration failed: ${(error as Error).message}`);
  }
}
