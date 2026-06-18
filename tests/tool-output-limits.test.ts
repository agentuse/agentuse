import { describe, it, expect, afterEach } from 'bun:test';
import {
  createBoundedAccumulator,
  clampToolResultForModel,
  truncateHeadTail,
  getToolOutputLimits,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_MAX_LINES,
  DEFAULT_MAX_LINE_LENGTH,
  DEFAULT_HEAD_RATIO,
} from '../src/tools/tool-output-limits.js';

describe('truncateHeadTail', () => {
  it('returns input unchanged when within budget', () => {
    const text = 'a'.repeat(100);
    expect(truncateHeadTail(text, 200)).toBe(text);
  });

  it('returns input unchanged at exactly the budget', () => {
    const text = 'a'.repeat(100);
    expect(truncateHeadTail(text, 100)).toBe(text);
  });

  it('keeps head and tail with a marker when over budget', () => {
    const head = 'H'.repeat(40);
    const middle = 'M'.repeat(100);
    const tail = 'T'.repeat(60);
    const text = head + middle + tail; // 200 chars
    const out = truncateHeadTail(text, 100, 0.4); // headBytes=40, tailBytes=60

    expect(out.startsWith('H'.repeat(40))).toBe(true);
    expect(out.endsWith('T'.repeat(60))).toBe(true);
    expect(out).toContain('100 chars truncated of 200 total');
    expect(out).not.toContain('M'); // middle dropped
  });
});

describe('createBoundedAccumulator', () => {
  it('returns the full output verbatim when under budget', () => {
    const acc = createBoundedAccumulator(100);
    acc.append('hello ');
    acc.append('world');
    expect(acc.truncated).toBe(false);
    expect(acc.total).toBe(11);
    expect(acc.finalize()).toBe('hello world');
  });

  it('is not truncated at exactly the budget', () => {
    const acc = createBoundedAccumulator(10);
    acc.append('0123456789');
    expect(acc.truncated).toBe(false);
    expect(acc.finalize()).toBe('0123456789');
  });

  it('keeps head + tail and drops the middle when over budget', () => {
    const acc = createBoundedAccumulator(100, 0.4); // head 40, tail 60
    acc.append('H'.repeat(40));
    acc.append('M'.repeat(100));
    acc.append('T'.repeat(60));

    expect(acc.truncated).toBe(true);
    expect(acc.total).toBe(200);
    const out = acc.finalize();
    expect(out.startsWith('H'.repeat(40))).toBe(true);
    expect(out.endsWith('T'.repeat(60))).toBe(true);
    expect(out).toContain('100 chars truncated of 200 total');
    expect(out).not.toContain('M');
  });

  it('fills head correctly when a single chunk spans the head/tail boundary', () => {
    const acc = createBoundedAccumulator(10, 0.4); // head 4, tail 6
    // One chunk larger than the whole budget.
    acc.append('abcdefghijklmnop'); // 16 chars
    expect(acc.truncated).toBe(true);
    expect(acc.total).toBe(16);
    const out = acc.finalize();
    expect(out.startsWith('abcd')).toBe(true); // first 4 = head
    expect(out.endsWith('klmnop')).toBe(true); // last 6 = tail
  });

  it('keeps a rolling tail window across many small chunks', () => {
    const acc = createBoundedAccumulator(10, 0.4); // head 4, tail 6
    for (let i = 0; i < 100; i++) acc.append('x');
    acc.append('TAILEND'); // last chars should win the tail window
    expect(acc.truncated).toBe(true);
    const out = acc.finalize();
    expect(out.endsWith('AILEND')).toBe(true); // last 6 chars
  });
});

describe('getToolOutputLimits', () => {
  const saved = {
    bytes: process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES,
    lines: process.env.AGENTUSE_TOOL_MAX_LINES,
    lineLen: process.env.AGENTUSE_TOOL_MAX_LINE_LENGTH,
    ratio: process.env.AGENTUSE_TOOL_OUTPUT_HEAD_RATIO,
  };

  afterEach(() => {
    const set = (k: string, v: string | undefined) => {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    };
    set('AGENTUSE_TOOL_MAX_OUTPUT_BYTES', saved.bytes);
    set('AGENTUSE_TOOL_MAX_LINES', saved.lines);
    set('AGENTUSE_TOOL_MAX_LINE_LENGTH', saved.lineLen);
    set('AGENTUSE_TOOL_OUTPUT_HEAD_RATIO', saved.ratio);
  });

  it('returns defaults when no env vars are set', () => {
    delete process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
    delete process.env.AGENTUSE_TOOL_MAX_LINES;
    delete process.env.AGENTUSE_TOOL_MAX_LINE_LENGTH;
    delete process.env.AGENTUSE_TOOL_OUTPUT_HEAD_RATIO;
    expect(getToolOutputLimits()).toEqual({
      maxBytes: DEFAULT_MAX_OUTPUT_BYTES,
      maxLines: DEFAULT_MAX_LINES,
      maxLineLength: DEFAULT_MAX_LINE_LENGTH,
      headRatio: DEFAULT_HEAD_RATIO,
    });
  });

  it('reads valid env overrides', () => {
    process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES = '12345';
    process.env.AGENTUSE_TOOL_OUTPUT_HEAD_RATIO = '0.25';
    const limits = getToolOutputLimits();
    expect(limits.maxBytes).toBe(12345);
    expect(limits.headRatio).toBe(0.25);
  });

  it('falls back to defaults on invalid env values', () => {
    process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES = 'not-a-number';
    process.env.AGENTUSE_TOOL_MAX_LINES = '-5';
    process.env.AGENTUSE_TOOL_OUTPUT_HEAD_RATIO = '1.5'; // out of (0,1)
    const limits = getToolOutputLimits();
    expect(limits.maxBytes).toBe(DEFAULT_MAX_OUTPUT_BYTES);
    expect(limits.maxLines).toBe(DEFAULT_MAX_LINES);
    expect(limits.headRatio).toBe(DEFAULT_HEAD_RATIO);
  });
});

describe('clampToolResultForModel', () => {
  it('truncates plain string results', () => {
    const result = clampToolResultForModel('a'.repeat(200), { maxBytes: 50, headRatio: 0.5 });
    expect(result.truncated).toBe(true);
    expect(result.value).toContain('chars truncated');
  });

  it('preserves object shape when an output string is truncated', () => {
    const result = clampToolResultForModel(
      { output: 'x'.repeat(200), metadata: { exitCode: 0 } },
      { maxBytes: 60, headRatio: 0.5 }
    );
    expect(result.truncated).toBe(true);
    expect((result.value as any).output).toContain('chars truncated');
    expect((result.value as any).metadata.exitCode).toBe(0);
    expect((result.value as any).metadata.truncated).toBe(true);
  });

  it('replaces oversized structured results with a bounded preview envelope', () => {
    const result = clampToolResultForModel(
      { items: Array.from({ length: 20 }, (_, i) => ({ i, text: 'z'.repeat(50) })) },
      { maxBytes: 120, headRatio: 0.5 }
    );
    expect(result.truncated).toBe(true);
    expect((result.value as any).truncated).toBe(true);
    expect((result.value as any).preview.length).toBeLessThan(260);
  });
});
