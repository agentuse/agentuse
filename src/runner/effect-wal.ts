import * as fs from 'fs';
import * as path from 'path';
import type { Tool, ToolSet } from 'ai';
import { isSuspendSignal } from './suspend';
import type { EffectAuditSink } from '../tools/types.js';
import { atomicWriteFileSync } from '../utils/atomic-write';
import { logger } from '../utils/logger';
import { toErrorMessage } from '../utils/error-message.js';

export const EFFECT_WAL_FILENAME = 'effect-wal.jsonl';
export const STRUCTURED_DELIVERY_CHECKPOINT = 'structured-delivery';

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
      try { logger.debug(`[EffectWAL] dropped record (no session dir yet): ${String(record?.event)}`); }
      catch { /* hostile diagnostic input must remain harmless */ }
      return;
    }
    let line = '{"ts":"unavailable","event":"audit-serialization-failed"}\n';
    try {
      // Build the line inside the no-throw boundary: BigInt, cycles and hostile
      // getters in a diagnostic record must never prevent the effect itself.
      const audited = sanitizeWALInput(record);
      // Never spread the caller's record: spread reads accessors before the
      // JSON boundary and used to let a hostile audit getter escape append().
      // A JSON round trip copies ordinary small records without changing their
      // shape; non-JSON values already have a tagged projection above.
      const fields = audited === record ? JSON.parse(JSON.stringify(record)) : audited;
      const payload = fields && typeof fields === 'object' && !Array.isArray(fields)
        ? { ts: new Date().toISOString(), ...(fields as Record<string, unknown>) }
        : { ts: new Date().toISOString(), event: 'audit-serialization-failed', record: fields };
      line = `${JSON.stringify(payload)}\n`;
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

  /** Atomically retain a validated structured handoff beside the effect WAL.
   * Unlike audit inputs this is intentionally not truncated: it is the durable
   * source of truth used to finish an internal job after a daemon restart. */
  checkpoint(name: string, payload: unknown): void {
    if (!this.dir || !/^[a-z0-9-]+$/u.test(name)) return;
    const target = path.join(this.dir, `${name}.json`);
    try {
      atomicWriteFileSync(target, JSON.stringify(payload));
    } catch (error) {
      logger.debug(`[EffectWAL] checkpoint failed: ${(error as Error).message}`);
    }
  }
}

/** JSON-safe copy of a tool input, capped so the journal stays readable. */
export function sanitizeWALInput(input: unknown, maxChars: number = MAX_INPUT_CHARS): unknown {
  // Preserve ordinary JSON-compatible inputs exactly for existing consumers,
  // but only after proving the whole graph is plain data. JSON.stringify turns
  // nested Map/Set/typed values into `{}`, which would silently erase the very
  // audit information this function is responsible for retaining.
  const plainSeen = new WeakSet<object>();
  let plainNodes = 0;
  const isPlainJsonGraph = (value: unknown): boolean => {
    if (++plainNodes > 10_000) return false;
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
    if (typeof value === 'number') return Number.isFinite(value);
    if (typeof value !== 'object' || plainSeen.has(value)) return false;
    plainSeen.add(value);
    if (Array.isArray(value)) return value.every(isPlainJsonGraph);
    if (Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
    try {
      return Object.values(Object.getOwnPropertyDescriptors(value)).every(descriptor =>
        'value' in descriptor && isPlainJsonGraph(descriptor.value)
      );
    } catch { return false; }
  };
  if (isPlainJsonGraph(input)) {
    try {
      const direct = JSON.stringify(input);
      if (direct !== undefined && direct.length <= maxChars) return input;
    } catch { /* use the tagged audit projection below */ }
  }
  const seen = new WeakSet<object>();
  let nodes = 0;
  const convert = (value: unknown): unknown => {
    if (++nodes > 10_000) return { __truncated: true, preview: '[audit value exceeded traversal limit]' };
    if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
    if (typeof value === 'number') return Number.isFinite(value) ? value : { __type: 'Number', value: String(value) };
    if (typeof value === 'bigint') return { __type: 'BigInt', value: value.toString() };
    if (typeof value === 'undefined') return { __type: 'Undefined' };
    if (typeof value === 'symbol' || typeof value === 'function') return { __type: typeof value };
    if (typeof value !== 'object') return String(value);
    if (seen.has(value)) return { __type: 'Cycle' };
    seen.add(value);
    try {
      if (value instanceof Date) return { __type: 'Date', value: value.toISOString() };
      if (value instanceof Map) return { __type: 'Map', entries: [...value].map(([k, v]) => [convert(k), convert(v)]) };
      if (value instanceof Set) return { __type: 'Set', values: [...value].map(convert) };
      if (ArrayBuffer.isView(value)) return { __type: value.constructor.name, values: Array.from(value as any).map(convert) };
      if (value instanceof ArrayBuffer) return { __type: 'ArrayBuffer', bytes: Buffer.from(value).toString('base64') };
      if (Array.isArray(value)) return value.map(convert);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(value)) {
        try { out[key] = convert((value as Record<string, unknown>)[key]); }
        catch { out[key] = { __type: 'Unreadable' }; }
      }
      return out;
    } catch { return { __type: 'Unreadable' }; }
  };
  const output = convert(input);
  let serialized: string;
  try { serialized = JSON.stringify(output); } catch { return { __truncated: true, preview: '[unserializable audit value]' }; }
  return serialized.length <= maxChars ? output : { __truncated: true, preview: serialized.slice(0, maxChars) };
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
                error: toErrorMessage(error),
                durationMs: Date.now() - startedAt,
              });
          throw error;
        }
      },
    }];
  })) as ToolSet;
}
