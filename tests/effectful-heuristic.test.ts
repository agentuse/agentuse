import { describe, test, expect } from 'bun:test';
import { looksEffectful, grantsUnnamedSubcommands, commandHead } from '../src/tools/effectful-heuristic';

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

describe('grantsUnnamedSubcommands (wildcard-tail blind spot)', () => {
  test('catches the grants looksEffectful reads as benign', () => {
    // The inversion this exists to fix: `birdc *` grants `birdc reply`, so the
    // broader entry must not draw the weaker warning.
    for (const cmd of ['birdc *', 'gh *', 'git *', 'kubectl *', 'cdp-browser *']) {
      expect(looksEffectful(cmd)).toBe(false);
      expect(grantsUnnamedSubcommands(cmd)).toBe(true);
    }
  });

  test('sees through env/sudo wrappers to the real program', () => {
    expect(grantsUnnamedSubcommands('env -u AUTH_TOKEN birdc *')).toBe(true);
    expect(grantsUnnamedSubcommands('sudo kubectl *')).toBe(true);
    expect(commandHead('env -u AUTH_TOKEN birdc *')).toBe('birdc');
  });

  test('quiet once a subcommand is named', () => {
    for (const cmd of ['birdc reply *', 'git -C /repo log *', 'gh release create *']) {
      expect(grantsUnnamedSubcommands(cmd)).toBe(false);
    }
  });

  test('quiet for read-only heads and programs without subcommands', () => {
    for (const cmd of ['ls *', 'cat *', 'date *', 'cd *', 'python3 *', 'node *', 'cp *']) {
      expect(grantsUnnamedSubcommands(cmd)).toBe(false);
    }
  });

  test('commandHead is undefined for substring-style patterns', () => {
    // Browser posting is usually gated this way; it cannot be attributed to a head.
    expect(commandHead('*tweetButton*')).toBeUndefined();
    expect(grantsUnnamedSubcommands('*tweetButton*')).toBe(false);
  });
});
