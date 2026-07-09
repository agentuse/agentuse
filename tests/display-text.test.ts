import { describe, expect, it } from 'bun:test';
import { repairEscapedText } from '../src/utils/display-text';

describe('repairEscapedText', () => {
  it('unescapes a fully double-escaped string (no real newlines)', () => {
    const escaped = '**Target:** Edward Grundy, ~1d old.\\n\\n**Revision:**\\n- First feedback: \\"concise\\"';
    expect(repairEscapedText(escaped)).toBe(
      '**Target:** Edward Grundy, ~1d old.\n\n**Revision:**\n- First feedback: "concise"'
    );
  });

  it('leaves a string with real newlines untouched, even if it mentions \\n', () => {
    const mixed = 'Split lines with \\n in code.\nSecond real line.';
    expect(repairEscapedText(mixed)).toBe(mixed);
  });

  it('leaves plain single-line strings untouched', () => {
    expect(repairEscapedText('no escapes here')).toBe('no escapes here');
  });

  it('handles \\r\\n and \\t sequences', () => {
    expect(repairEscapedText('a\\r\\nb\\tc')).toBe('a\nb\tc');
  });
});
