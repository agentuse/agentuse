import { describe, test, expect } from 'bun:test';
import { looksEffectful } from '../src/tools/effectful-heuristic';

describe('looksEffectful heuristic (advisory nudge only)', () => {
  test('flags outward/irreversible verbs', () => {
    for (const cmd of ['birdc reply *', 'birdc tweet *', 'gh pr merge *', 'npm publish', 'terraform destroy']) {
      expect(looksEffectful(cmd)).toBe(true);
    }
  });

  test('flags dangerous command shapes', () => {
    for (const cmd of ['rm -rf *', 'git push *', 'curl -X POST *', 'kubectl delete *']) {
      expect(looksEffectful(cmd)).toBe(true);
    }
  });

  test('leaves read-only / benign commands alone', () => {
    for (const cmd of ['birdc read *', 'birdc search *', 'date *', 'ls tmp/*', 'cat tmp/*', 'git log', 'git status', 'curl -s *']) {
      expect(looksEffectful(cmd)).toBe(false);
    }
  });

  test('empty is not effectful', () => {
    expect(looksEffectful('')).toBe(false);
    expect(looksEffectful('   ')).toBe(false);
  });
});
