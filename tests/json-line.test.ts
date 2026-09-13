import { describe, expect, it } from 'bun:test';
import { stringifyJsonLine } from '../src/utils/json-line.js';

describe('JSON-line framing', () => {
  it('escapes Unicode line and paragraph separators inside payload strings', () => {
    const payload = { text: `before\u2028middle\u2029after` };
    const wire = stringifyJsonLine(payload);

    expect(wire.endsWith('\n')).toBe(true);
    expect(wire.slice(0, -1)).not.toContain('\u2028');
    expect(wire.slice(0, -1)).not.toContain('\u2029');
    expect(wire.split('\n')).toHaveLength(2);
    expect(JSON.parse(wire)).toEqual(payload);
  });

  it('rejects values JSON.stringify cannot represent as a record', () => {
    expect(() => stringifyJsonLine(undefined)).toThrow('JSON-line value is not serializable');
  });
});
