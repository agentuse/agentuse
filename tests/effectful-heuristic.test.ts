import { describe, test, expect } from 'bun:test';
import { looksEffectful, grantsUnnamedSubcommands, grantsArbitraryCode, commandHead } from '../src/tools/effectful-heuristic';

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

describe('grantsArbitraryCode (unpinned interpreter grants)', () => {
  test('flags interpreters that pin nothing', () => {
    for (const cmd of ['python3 *', 'python *', 'node *', 'npx *', 'uvx *', 'uv run *']) {
      expect(grantsArbitraryCode(cmd)).toBe(true);
    }
  });

  test('flags inline-code flags even when other tokens are concrete', () => {
    expect(grantsArbitraryCode('python3 -c *')).toBe(true);
    expect(grantsArbitraryCode('bash -c *')).toBe(true);
  });

  test('accepts a pinned script', () => {
    for (const cmd of [
      'python3 /Users/x/scripts/revenuecat_query.py *',
      'python3 utils/token-usage-auditor.py *',
      'sh scripts/deploy.sh *',
      'node dist/cli.js *',
      'uv run --python 3.13 --with firebase-admin python3 /Users/x/firebase_query.py *',
    ]) {
      expect(grantsArbitraryCode(cmd)).toBe(false);
    }
  });

  test('package runners pin on a package name, not on a flag value', () => {
    expect(grantsArbitraryCode('uvx ruff *')).toBe(false);
    expect(grantsArbitraryCode('npx tsx script.ts')).toBe(false);
    // "run" is the runner's own subcommand, and 3.13 is --python's value: neither pins.
    expect(grantsArbitraryCode('uv run *')).toBe(true);
    expect(grantsArbitraryCode('uv run --python 3.13 *')).toBe(true);
  });

  test('ignores non-interpreters', () => {
    for (const cmd of ['birdc *', 'git *', 'date *', 'gh *']) {
      expect(grantsArbitraryCode(cmd)).toBe(false);
    }
  });
});
