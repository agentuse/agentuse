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

export function registerSDKTelemetryOnce(): void {
  if (registered) return;
  registered = true;
  const registerTelemetry = (ai as { registerTelemetry?: (integration: unknown) => void }).registerTelemetry;
  if (typeof registerTelemetry !== 'function') return;
  try {
    registerTelemetry({
      onToolExecutionStart: (event: any) => {
        logger.debug(
          `[SDKTelemetry] tool-execution-start ${event?.toolName ?? 'unknown'}${event?.toolCallId ? ` callId=${event.toolCallId}` : ''}`
        );
      },
      onToolExecutionEnd: (event: any) => {
        const outcome = event?.success === false ? `error=${String(event?.error ?? 'unknown')}` : 'ok';
        logger.debug(
          `[SDKTelemetry] tool-execution-end ${event?.toolName ?? 'unknown'}${event?.toolCallId ? ` callId=${event.toolCallId}` : ''} ${outcome}${typeof event?.toolExecutionMs === 'number' ? ` ${Math.round(event.toolExecutionMs)}ms` : ''}`
        );
      },
      onAbort: () => {
        logger.debug('[SDKTelemetry] generation aborted');
      },
    });
  } catch (error) {
    logger.debug(`[SDKTelemetry] registration failed: ${(error as Error).message}`);
  }
}
