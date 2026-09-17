import { describe, expect, it } from 'bun:test';
import { createRequestFingerprinter } from '../src/telemetry/request-fingerprint';

describe('request fingerprints', () => {
  const body = (input: unknown[], extra = {}) => JSON.stringify({model:'test', instructions:'private text', tools:[{name:'read'}], input, ...extra});
  it('matches a growing request prefix to the previous whole request', () => {
    const track = createRequestFingerprinter();
    const a = track(body([{role:'user',content:'secret'}]))!;
    const b = track(body([{role:'user',content:'secret'},{role:'assistant',content:'OK'}]))!;
    expect(a.prefixHash).toBeUndefined();
    expect(b.prefixHash).toBe(a.allHash);
    expect(b.allHash).not.toBe(a.allHash);
    expect(b.prefixUnchanged).toBe(true);
    expect(JSON.stringify(b)).not.toContain('secret');
    expect(JSON.stringify(b)).not.toContain('private text');
  });
  it('detects changed instructions, tools, reordered items and shorter history', () => {
    for (const next of [body([2,1]), body([1]), body([1,2],{instructions:'changed'}), body([1,2],{tools:[]})]) {
      const track = createRequestFingerprinter(); track(body([1,2]));
      expect(track(next)?.prefixUnchanged).toBe(false);
    }
  });
  it('ignores JSON key order, supports chat messages, and resets independently', () => {
    const track = createRequestFingerprinter();
    const first = track('{"model":"x","messages":[{"a":1,"b":2}]}')!;
    expect(track('{"messages":[{"b":2,"a":1}],"model":"x"}')?.allHash).toBe(first.allHash);
    expect(createRequestFingerprinter()('{"messages":[]}')?.sequence).toBe(1);
    expect(track('invalid')).toBeUndefined();
    expect(track('{}')).toBeUndefined();
  });
});
