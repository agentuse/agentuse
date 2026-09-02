import { describe, expect, it } from 'bun:test';
import { revisionLineDiff } from '../src/cli/serve/web/lib/revision-diff';

describe('agent revision diff', () => {
  it('keeps unchanged frontmatter lines aligned around a removed schedule', () => {
    const before = [
      '---',
      'model: "@low"',
      'description: Daily digest',
      'schedule: "0 9 * * *"',
      'channels:',
      '  slack:',
      'body',
      '',
    ].join('\n');
    const after = before.replace('schedule: "0 9 * * *"\n', '');

    expect(revisionLineDiff(before, after)).toEqual([
      { kind: 'meta', text: '@@ -2,5 +2,4 @@' },
      { kind: 'same', text: 'model: "@low"' },
      { kind: 'same', text: 'description: Daily digest' },
      { kind: 'remove', text: 'schedule: "0 9 * * *"' },
      { kind: 'same', text: 'channels:' },
      { kind: 'same', text: '  slack:' },
    ]);
  });
});
