import { describe, expect, it } from 'bun:test';
import { parseJsonEnvVar, unescapeJsonEnvVar } from '../src/utils/env';

describe('JSON environment variables', () => {
  it('returns ordinary JSON unchanged and parses objects, arrays, and scalars', () => {
    const source = '{"enabled":true,"ports":[3000,3001]}';
    expect(unescapeJsonEnvVar(source)).toBe(source);
    expect(parseJsonEnvVar(source)).toEqual({ enabled: true, ports: [3000, 3001] });
    expect(parseJsonEnvVar<string>('"ready"')).toBe('ready');
    expect(parseJsonEnvVar<number>('42')).toBe(42);
  });

  it('recovers JSON whose quotes were escaped by an env-file layer', () => {
    expect(parseJsonEnvVar<{ message: string }>('{\\"message\\":\\"hello\\"}')).toEqual({ message: 'hello' });

    const withQuotedText = JSON.stringify({ message: 'say "hello"' }).replaceAll('"', '\\"');
    expect(parseJsonEnvVar<{ message: string }>(withQuotedText)).toEqual({ message: 'say "hello"' });
  });

  it('preserves JSON escape semantics for newline, carriage return, and tab', () => {
    expect(parseJsonEnvVar<{ value: string }>('{\\"value\\":\\"line\\nnext\\ttab\\rreturn\\"}')).toEqual({
      value: 'line\nnext\ttab\rreturn',
    });
  });

  it('reduces a double-escaped sequence by one layer', () => {
    expect(unescapeJsonEnvVar('path\\\\\\\\name')).toBe('path\\\\name');
    expect(unescapeJsonEnvVar('line\\\\\\\\nnext')).toBe('line\\\\nnext');
  });

  it('returns null for missing, empty, and invalid values', () => {
    expect(parseJsonEnvVar(undefined)).toBeNull();
    expect(parseJsonEnvVar('')).toBeNull();
    expect(parseJsonEnvVar('not-json')).toBeNull();
    expect(parseJsonEnvVar('{"unterminated":')).toBeNull();
  });

  it('leaves empty strings unchanged when unescaping directly', () => {
    expect(unescapeJsonEnvVar('')).toBe('');
  });
});
