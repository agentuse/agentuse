import { describe, expect, it } from 'bun:test';
import { ALLOWED_ROOTS, unexpectedPaths } from '../scripts/release-brief.ts';

describe('release brief package contents', () => {
  it('recognizes the packaged third-party notices as an expected root file', () => {
    expect(ALLOWED_ROOTS).toContain('THIRD_PARTY_NOTICES.md');
    expect(ALLOWED_ROOTS).toContain('src/plugin/types.ts');
    expect(unexpectedPaths([
      { path: 'README.md', size: 10 },
      { path: 'THIRD_PARTY_NOTICES.md', size: 10 },
      { path: 'src/plugin/types.ts', size: 10 },
      { path: 'dist/index.js', size: 10 },
      { path: 'README.md.extra', size: 10 },
      { path: 'src/plugin/types.ts.bak', size: 10 },
      { path: 'unexpected.txt', size: 10 },
    ]).map((file) => file.path)).toEqual([
      'README.md.extra',
      'src/plugin/types.ts.bak',
      'unexpected.txt',
    ]);
  });
});
