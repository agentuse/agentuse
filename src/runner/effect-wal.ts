import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolSet } from 'ai';
import { isSuspendSignal } from './suspend';
import type { EffectAuditSink } from '../tools/types.js';
import { logger } from '../utils/logger';

export const EFFECT_WAL_FILENAME = 'effect-wal.jsonl';

// Cap serialized inputs so one giant tool argument can't bloat the journal;
// forensics needs the command/first content, not megabytes of payload.
const MAX_INPUT_CHARS = 16384;

/**
 * Write-ahead log for tool effects, one append-only JSONL file per session.
 *
 * The session part journal is written by the STREAM CONSUMER, which the suspend
 * path abandons mid-step — that is exactly how the 2026-07-16 ghost posts became
 * invisible (agentuse-lab#165). This log is written synchronously at the effect
 * layer (tool execute entry/exit, bash spawn/exit), so any execution that
 * happens is on disk before it happens, no matter what the consumer does.
 *
 * The sink binds lazily: subagents load tools before their session exists, so
 * the file path is only known later. Records appended before `bind()` are
 * dropped with a debug log — tools cannot execute before the model runs, which
 * is always after session creation.
 */
export class EffectWAL implements EffectAuditSink {
  private dir: string | undefined;

  constructor(sessionDir?: string) {
    this.dir = sessionDir;
  }

  bind(sessionDir: string): void {
    this.dir = sessionDir;
  }

  get filePath(): string | undefined {
    return this.dir ? path.join(this.dir, EFFECT_WAL_FILENAME) : undefined;
  }

  /** Append one record synchronously. Never throws: the WAL must not be able to break a run. */
  append(record: Record<string, unknown>): void {
    const filePath = this.filePath;
    if (!filePath) {
      logger.debug(`[EffectWAL] dropped record (no session dir yet): ${String(record.event)}`);
      return;
    }
    const line = `${JSON.stringify({ ts: new Date().toISOString(), ...record })}\n`;
    try {
      fs.appendFileSync(filePath, line);
    } catch {
      try {
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        fs.appendFileSync(filePath, line);
      } catch (error) {
        logger.debug(`[EffectWAL] append failed: ${(error as Error).message}`);
      }
    }
  }
}

/** JSON-safe copy of a tool input, capped so the journal stays readable. */
export function sanitizeWALInput(input: unknown): unknown {
  let serialized: string;
  try {
    serialized = JSON.stringify(input) ?? 'undefined';
  } catch {
    serialized = String(input);
  }
  if (serialized.length <= MAX_INPUT_CHARS) return input;
  return { __truncated: true, preview: serialized.slice(0, MAX_INPUT_CHARS) };
}

/**
 * Wrap every tool's execute so entry/exit is journaled to the WAL,
 * consumer-independently. `callId` comes from the AI SDK's tool-call options
 * (second execute argument).
 */
export function wrapToolsWithWAL(tools: ToolSet, wal: EffectAuditSink): ToolSet {
  return Object.fromEntries(Object.entries(tools).map(([name, tool]) => {
    const originalExecute = (tool as Tool).execute;
    if (typeof originalExecute !== 'function') return [name, tool];

    return [name, {
      ...tool,
      execute: async (input: unknown, callOptions?: { toolCallId?: string }) => {
        const callId = callOptions?.toolCallId;
        const startedAt = Date.now();
        wal.append({
          event: 'tool-start',
          ...(callId && { callId }),
          tool: name,
          input: sanitizeWALInput(input),
        });
        try {
          const result = await (originalExecute as (...args: unknown[]) => unknown)(input, callOptions);
          wal.append({
            event: 'tool-end',
            ...(callId && { callId }),
            tool: name,
            ok: true,
            durationMs: Date.now() - startedAt,
          });
          return result;
        } catch (error) {
          wal.append(isSuspendSignal(error)
            ? {
                event: 'tool-suspend',
                ...(callId && { callId }),
                tool: name,
                durationMs: Date.now() - startedAt,
              }
            : {
                event: 'tool-error',
                ...(callId && { callId }),
                tool: name,
                error: (error as Error)?.message ?? String(error),
                durationMs: Date.now() - startedAt,
              });
          throw error;
        }
      },
    }];
  })) as ToolSet;
}
