import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { EffectWAL, EFFECT_WAL_FILENAME, wrapToolsWithWAL, sanitizeWALInput } from '../src/runner/effect-wal';
import { SuspendSignal } from '../src/runner/suspend';

function readRecords(dir: string): Array<Record<string, unknown>> {
  const file = path.join(dir, EFFECT_WAL_FILENAME);
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8')
    .split('\n')
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line));
}

describe('EffectWAL', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-wal-test-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('appends JSONL records with a timestamp once bound', () => {
    const wal = new EffectWAL(dir);
    wal.append({ event: 'tool-start', tool: 'tools__bash', input: { command: 'echo hi' } });
    wal.append({ event: 'tool-end', tool: 'tools__bash', ok: true });

    const records = readRecords(dir);
    expect(records).toHaveLength(2);
    expect(records[0].event).toBe('tool-start');
    expect(records[0].tool).toBe('tools__bash');
    expect(typeof records[0].ts).toBe('string');
    expect(Number.isNaN(Date.parse(records[0].ts as string))).toBe(false);
    expect(records[1].event).toBe('tool-end');
  });

  test('drops records silently while unbound, then records after bind()', () => {
    const wal = new EffectWAL();
    expect(() => wal.append({ event: 'tool-start', tool: 'x' })).not.toThrow();

    wal.bind(dir);
    wal.append({ event: 'tool-start', tool: 'y' });

    const records = readRecords(dir);
    expect(records).toHaveLength(1);
    expect(records[0].tool).toBe('y');
  });

  test('creates the directory if it does not exist yet', () => {
    const nested = path.join(dir, 'not', 'yet', 'created');
    const wal = new EffectWAL(nested);
    wal.append({ event: 'tool-start', tool: 'x' });
    expect(readRecords(nested)).toHaveLength(1);
  });

  test('never throws even when the path is unwritable', () => {
    const wal = new EffectWAL('/dev/null/definitely-not-a-dir');
    expect(() => wal.append({ event: 'tool-start' })).not.toThrow();
  });
});

describe('sanitizeWALInput', () => {
  test('passes small inputs through untouched', () => {
    const input = { command: 'echo hi' };
    expect(sanitizeWALInput(input)).toBe(input);
  });

  test('truncates oversized inputs to a preview', () => {
    const input = { blob: 'x'.repeat(64 * 1024) };
    const result = sanitizeWALInput(input) as Record<string, unknown>;
    expect(result.__truncated).toBe(true);
    expect((result.preview as string).length).toBeLessThanOrEqual(16384);
  });

  test('handles unserializable inputs without throwing', () => {
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    expect(() => sanitizeWALInput(circular)).not.toThrow();
  });
});

describe('wrapToolsWithWAL', () => {
  let dir: string;
  let wal: EffectWAL;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'effect-wal-wrap-'));
    wal = new EffectWAL(dir);
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('journals execute entry and exit with the SDK callId', async () => {
    const tools = {
      my_tool: {
        description: 'test',
        execute: async (input: unknown) => ({ output: `got ${JSON.stringify(input)}` }),
      },
    } as any;

    const wrapped = wrapToolsWithWAL(tools, wal);
    const result = await (wrapped.my_tool as any).execute({ value: 42 }, { toolCallId: 'call-123' });
    expect(result.output).toContain('42');

    const records = readRecords(dir);
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({ event: 'tool-start', callId: 'call-123', tool: 'my_tool' });
    expect((records[0].input as Record<string, unknown>).value).toBe(42);
    expect(records[1]).toMatchObject({ event: 'tool-end', callId: 'call-123', tool: 'my_tool', ok: true });
    expect(typeof records[1].durationMs).toBe('number');
  });

  test('the start record exists BEFORE the effect completes (write-ahead)', async () => {
    let recordsAtEffectTime: Array<Record<string, unknown>> = [];
    const tools = {
      effect_tool: {
        description: 'test',
        execute: async () => {
          recordsAtEffectTime = readRecords(dir);
          return { output: 'done' };
        },
      },
    } as any;

    await (wrapToolsWithWAL(tools, wal).effect_tool as any).execute({}, { toolCallId: 'c1' });
    expect(recordsAtEffectTime.some((r) => r.event === 'tool-start' && r.callId === 'c1')).toBe(true);
  });

  test('journals tool-error and rethrows on failure', async () => {
    const tools = {
      failing: {
        description: 'test',
        execute: async () => {
          throw new Error('boom');
        },
      },
    } as any;

    const wrapped = wrapToolsWithWAL(tools, wal);
    await expect((wrapped.failing as any).execute({}, { toolCallId: 'c2' })).rejects.toThrow('boom');

    const records = readRecords(dir);
    expect(records[1]).toMatchObject({ event: 'tool-error', callId: 'c2', tool: 'failing', error: 'boom' });
  });

  test('journals tool-suspend (not tool-error) for SuspendSignal and rethrows', async () => {
    const tools = {
      gate: {
        description: 'test',
        execute: async () => {
          throw new SuspendSignal({ kind: 'await_human', prompt: 'ok?' });
        },
      },
    } as any;

    const wrapped = wrapToolsWithWAL(tools, wal);
    await expect((wrapped.gate as any).execute({}, { toolCallId: 'c3' })).rejects.toThrow('Agent execution suspended');

    const records = readRecords(dir);
    expect(records[1]).toMatchObject({ event: 'tool-suspend', callId: 'c3', tool: 'gate' });
  });

  test('leaves tools without execute untouched', () => {
    const tool = { description: 'provider-side tool' } as any;
    const wrapped = wrapToolsWithWAL({ passive: tool } as any, wal);
    expect(wrapped.passive).toBe(tool);
  });
});
