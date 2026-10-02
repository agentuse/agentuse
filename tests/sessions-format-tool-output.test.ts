import { describe, expect, it } from 'bun:test';
import { formatToolOutput } from '../src/cli/sessions';

describe('formatToolOutput', () => {
  it('cuts a long line at the width for plain text', () => {
    const line = 'x'.repeat(12);

    expect(formatToolOutput(line, 10)).toBe(`${'x'.repeat(10)}… [12 chars]`);
  });

  it('never splits an emoji when a long line is cut inside it', () => {
    // The emoji occupies UTF-16 units 9 and 10, so a cut at 10 lands between them.
    const line = `${'x'.repeat(9)}😀${'y'.repeat(5)}`;

    expect(formatToolOutput(line, 10)).toBe(`${'x'.repeat(9)}… [${line.length} chars]`);
  });
});
