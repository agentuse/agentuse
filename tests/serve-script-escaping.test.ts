import { describe, expect, it } from 'bun:test';
import { jsonForScript } from '../src/cli/serve/ui';

describe('jsonForScript', () => {
  it('neutralizes closing-script and comment-opener sequences', () => {
    const out = jsonForScript({ body: '</scr' + 'ipt><img onerror=alert(1)>', c: '<!--' });
    // No literal "<" survives, so the HTML parser cannot end the <script> early.
    expect(out).not.toContain('<');
    expect(out).toContain('\\u003c');
    // Still valid JSON that round-trips to the original value.
    expect(JSON.parse(out)).toEqual({ body: '</scr' + 'ipt><img onerror=alert(1)>', c: '<!--' });
  });
});
