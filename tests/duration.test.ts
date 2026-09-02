import { describe, expect, it } from 'bun:test';
import {
  formatApproximateDuration,
  formatCompactDuration,
  formatShortDuration,
  parseDurationMs,
  parseDurationSeconds,
} from '../src/utils/duration';

const secondsField = { bareUnit: 'seconds' as const, field: 'timeout' };
const msField = { bareUnit: 'milliseconds' as const, field: 'tools.bash.timeout' };

describe('parseDurationMs', () => {
  it('parses suffixed strings regardless of bare unit', () => {
    expect(parseDurationMs('500ms', secondsField)).toBe(500);
    expect(parseDurationMs('30s', secondsField)).toBe(30_000);
    expect(parseDurationMs('2m', msField)).toBe(120_000);
    expect(parseDurationMs('1h', secondsField)).toBe(3_600_000);
    expect(parseDurationMs('1d', secondsField)).toBe(86_400_000);
  });

  it('accepts case-insensitive suffixes and internal whitespace', () => {
    expect(parseDurationMs('30S', secondsField)).toBe(30_000);
    expect(parseDurationMs('2 M', secondsField)).toBe(120_000);
    expect(parseDurationMs(' 45s ', secondsField)).toBe(45_000);
  });

  it('supports decimal amounts', () => {
    expect(parseDurationMs('1.5m', secondsField)).toBe(90_000);
    expect(parseDurationMs('0.5s', secondsField)).toBe(500);
  });

  it('applies bareUnit to bare numbers and numeric strings', () => {
    expect(parseDurationMs(30, secondsField)).toBe(30_000);
    expect(parseDurationMs('30', secondsField)).toBe(30_000);
    expect(parseDurationMs(30, msField)).toBe(30);
    expect(parseDurationMs('30000', msField)).toBe(30_000);
  });

  it('invokes onBareNumber only for suffix-less values', () => {
    let seen: number | undefined;
    const opts = { ...msField, onBareNumber: (v: number) => (seen = v) };
    parseDurationMs('30s', opts);
    expect(seen).toBeUndefined();
    parseDurationMs(120000, opts);
    expect(seen).toBe(120000);
  });

  it('throws on invalid input', () => {
    expect(() => parseDurationMs('abc', secondsField)).toThrow(/Invalid duration for timeout/);
    expect(() => parseDurationMs('30x', secondsField)).toThrow();
    expect(() => parseDurationMs('-5s' as string, secondsField)).toThrow();
    expect(() => parseDurationMs(0, secondsField)).toThrow(/positive/);
    expect(() => parseDurationMs(-10, secondsField)).toThrow(/positive/);
    expect(() => parseDurationMs(Number.NaN, secondsField)).toThrow(/positive/);
  });
});

describe('parseDurationSeconds', () => {
  it('returns whole seconds, rounding up sub-second values', () => {
    expect(parseDurationSeconds('90s', secondsField)).toBe(90);
    expect(parseDurationSeconds('2m', secondsField)).toBe(120);
    expect(parseDurationSeconds('500ms', secondsField)).toBe(1);
    expect(parseDurationSeconds(300, secondsField)).toBe(300);
  });
});

describe('duration formatting', () => {
  it('formats short operational durations', () => {
    expect(formatShortDuration(-1)).toBe('0ms');
    expect(formatShortDuration(999)).toBe('999ms');
    expect(formatShortDuration(1_499)).toBe('1s');
  });

  it('formats compact CLI durations', () => {
    expect(formatCompactDuration(0)).toBe('0s');
    expect(formatCompactDuration(61_000)).toBe('1m 1s');
    expect(formatCompactDuration(3_600_000)).toBe('1h');
    expect(formatCompactDuration(3_660_000)).toBe('1h 1m');
  });

  it('formats approximate visual durations', () => {
    expect(formatApproximateDuration(89_000)).toBe('89s');
    expect(formatApproximateDuration(90_000)).toBe('2m');
    expect(formatApproximateDuration(5_400_000)).toBe('2h');
  });
});
