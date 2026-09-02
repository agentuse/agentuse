import { describe, expect, it } from 'bun:test';
import { join } from 'node:path';
import { isBlockedReviewPath, isPathInside } from '../src/utils/path-policy';

describe('shared path policy', () => {
  const root = join(process.cwd(), 'project');

  it('distinguishes same-path and strict-child containment', () => {
    expect(isPathInside(root, root)).toBe(true);
    expect(isPathInside(root, root, { allowEqual: false })).toBe(false);
    expect(isPathInside(root, join(root, 'nested', 'file.txt'))).toBe(true);
    expect(isPathInside(root, join(root, '..', 'secret.txt'))).toBe(false);
    expect(isPathInside(root, `${root}-copy/file.txt`)).toBe(false);
  });

  it('applies one denylist to every reviewer-visible project surface', () => {
    expect(isBlockedReviewPath(root, join(root, '.env.example'))).toBe(true);
    expect(isBlockedReviewPath(root, join(root, '.git', 'config'))).toBe(true);
    expect(isBlockedReviewPath(root, join(root, '.agentuse', 'sessions', 'run.json'))).toBe(true);
    expect(isBlockedReviewPath(root, join(root, 'reports', 'summary.md'))).toBe(false);
  });
});
