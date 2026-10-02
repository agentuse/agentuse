import { describe, expect, it } from 'bun:test';
import {
  assertManifestVersionsCoupled,
  assertTriggeredCommitBelongsToRemoteMain,
  githubReleaseCreateArgs,
} from '../scripts/release.ts';

describe('release version coupling', () => {
  it('requires npm and Desktop to ship the same version', () => {
    expect(() => assertManifestVersionsCoupled('0.19.1', '0.19.0')).toThrow(
      'Package version 0.19.1 and Desktop version 0.19.0 differ',
    );
    expect(() => assertManifestVersionsCoupled('0.19.1', '0.19.1')).not.toThrow();
  });
});

describe('release tag branch gate', () => {
  it('does nothing outside a CI tag run', () => {
    let calls = 0;
    assertTriggeredCommitBelongsToRemoteMain({}, () => {
      calls += 1;
      return '';
    });
    assertTriggeredCommitBelongsToRemoteMain({ GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: 'branch' }, () => {
      calls += 1;
      return '';
    });

    expect(calls).toBe(0);
  });

  it('accepts a tag whose peeled commit is an ancestor of freshly fetched origin/main', () => {
    const calls: string[][] = [];
    const outputs = ['', 'abc123', 'def456', 'abc123'];

    assertTriggeredCommitBelongsToRemoteMain(
      { GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: 'tag', GITHUB_SHA: 'tag-object' },
      (args) => {
        calls.push(args);
        return outputs[calls.length - 1] ?? '';
      },
    );

    expect(calls).toEqual([
      ['fetch', '--quiet', '--no-tags', 'origin', 'main'],
      ['rev-parse', '--verify', 'tag-object^{commit}'],
      ['rev-parse', '--verify', 'FETCH_HEAD^{commit}'],
      ['merge-base', 'abc123', 'def456'],
    ]);
  });

  it('rejects a tag commit that is not in origin/main history', () => {
    const outputs = ['', 'aaaaaaaaaaaa1111', 'bbbbbbbbbbbb2222', 'cccccccccccc3333'];
    let call = 0;

    expect(() =>
      assertTriggeredCommitBelongsToRemoteMain(
        { GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: 'tag', GITHUB_SHA: 'tag-object' },
        () => outputs[call++] ?? '',
      ),
    ).toThrow('Release tag commit aaaaaaaaaaaa is not in origin/main history at bbbbbbbbbbbb');
  });

  it('fails closed when GitHub omits the triggering SHA', () => {
    expect(() =>
      assertTriggeredCommitBelongsToRemoteMain(
        { GITHUB_ACTIONS: 'true', GITHUB_REF_TYPE: 'tag' },
        () => '',
      ),
    ).toThrow('GITHUB_SHA is missing');
  });
});

describe('GitHub Release creation', () => {
  it('creates a stable release from notes without attaching integration archives', () => {
    expect(githubReleaseCreateArgs('0.22.0', 'agentuse/agentuse', '/tmp/notes.md')).toEqual([
      'release',
      'create',
      'v0.22.0',
      '-R',
      'agentuse/agentuse',
      '--title',
      'v0.22.0',
      '--notes-file',
      '/tmp/notes.md',
    ]);
  });

  it('marks prereleases without adding assets', () => {
    const args = githubReleaseCreateArgs('0.22.0-rc.1', 'agentuse/agentuse', '/tmp/notes.md');
    expect(args.at(-1)).toBe('--prerelease');
    expect(args.some((arg) => /\.(?:zip|tgz)$/.test(arg))).toBe(false);
  });
});

describe('release entry points', () => {
  it('routes every release script through scripts/release*.ts', async () => {
    const pkg = (await Bun.file(new URL('../package.json', import.meta.url)).json()) as {
      scripts: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const releaseScripts = Object.entries(pkg.scripts).filter(([name]) => name === 'release' || name.startsWith('release:'));

    for (const [name, command] of releaseScripts) {
      expect({ name, command }).toEqual({ name, command: expect.stringMatching(/^bun scripts\/release[\w-]*\.ts\b/) });
    }
    expect(pkg.devDependencies?.np).toBeUndefined();
  });
});
