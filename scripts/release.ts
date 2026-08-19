/**
 * Drive a release.
 *
 * One code path, run identically on a laptop and on a CI runner, so "it worked
 * locally" and "it worked in the workflow" mean the same thing. The workflow
 * file holds only the machine setup and the approval gate; every decision about
 * what a release *is* lives here, where it can be read, tested, and run without
 * pushing anything.
 *
 *   bun scripts/release.ts preflight [bump]   assertions only, writes nothing
 *   bun scripts/release.ts prepare <bump>     date the changelog, bump, commit, tag
 *   bun scripts/release.ts verify             the blocking gate
 *   bun scripts/release.ts notes [version]    changelog section to stdout
 *   bun scripts/release.ts publish            npm publish (OIDC in CI, 2FA locally)
 *   bun scripts/release.ts finish [version]   create the GitHub Release
 *
 * `prepare` is the only subcommand that writes to the repo, and it pushes
 * nothing: the tag sitting unpushed on the laptop is the last point where a
 * release is still free to abandon.
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { sectionFor, unreleasedBody } from './lib/changelog.ts';

const root = resolve(import.meta.dir, '..');

/** Releases are cut from here, and nowhere else without an explicit override. */
const RELEASE_BRANCH = 'main';

/**
 * The public repo is where provenance and OIDC have to run from, because npm
 * requires package.json's `repository` to be public and to match the repo
 * publishing from. `origin` is the private working mirror.
 */
const PUBLIC_REPO = 'agentuse/agentuse';
const REMOTES = ['origin', 'origin-public'];

/** Written by `verify`, read by the review brief so a failed gate still reports. */
const GATE_FILE = join(root, 'tmp', 'release-gate.json');

const SEMVER = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?$/;

class ReleaseError extends Error {}

function fail(message: string): never {
  throw new ReleaseError(message);
}

function note(message: string): void {
  console.log(message);
}

function warn(message: string): void {
  console.log(`! ${message}`);
}

/** Capture output; a non-zero exit is a bug in the caller's assumptions. */
function capture(cmd: string, args: string[]): string {
  const result = spawnSync(cmd, args, { cwd: root, encoding: 'utf8' });
  if (result.status !== 0) {
    fail(`${cmd} ${args.join(' ')} failed:\n${(result.stderr || result.stdout || '').trim()}`);
  }
  return result.stdout.trim();
}

/** Run with the caller's stdio, so npm's 2FA prompt and test output work. */
function stream(cmd: string, args: string[]): void {
  const result = spawnSync(cmd, args, { cwd: root, stdio: 'inherit' });
  if (result.status !== 0) fail(`${cmd} ${args.join(' ')} exited ${result.status}`);
}

function manifest(): { version: string; name: string; repository?: { url?: string } } {
  return JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
}

function isCI(): boolean {
  return process.env.GITHUB_ACTIONS === 'true';
}

// ---------------------------------------------------------------- versioning

function nextVersion(current: string, bump: string): string {
  if (SEMVER.test(bump)) return bump;

  const parsed = SEMVER.exec(current);
  if (!parsed) fail(`package.json version "${current}" is not semver.`);
  if (parsed[4]) {
    fail(
      `Current version ${current} is a prerelease, so "${bump}" is ambiguous. ` +
        `Name the target version explicitly, e.g. bun scripts/release.ts prepare 0.17.0`,
    );
  }
  const [major, minor, patch] = [Number(parsed[1]), Number(parsed[2]), Number(parsed[3])];
  switch (bump) {
    case 'major':
      return `${major + 1}.0.0`;
    case 'minor':
      return `${major}.${minor + 1}.0`;
    case 'patch':
      return `${major}.${minor}.${patch + 1}`;
    default:
      fail(`Unknown bump "${bump}". Use major, minor, patch, or an explicit version like 0.17.0-rc.0.`);
  }
}

/**
 * Pick the npm dist-tag from the version itself rather than from a flag.
 *
 * `latest` is what a bare `npm install agentuse` resolves to, so a prerelease
 * landing there reaches every user the moment it publishes, and unpublishing
 * does not take it back. Deriving the tag from the version makes that mistake
 * unreachable: anything with a prerelease component gets its own channel.
 */
function distTag(version: string): string {
  const prerelease = SEMVER.exec(version)?.[4];
  if (!prerelease) return 'latest';
  const channel = prerelease.split('.')[0] ?? '';
  if (!/^[a-z][a-z0-9-]*$/.test(channel)) {
    fail(`Cannot derive a dist-tag from prerelease "${version}". Expected a leading channel like rc, beta, next.`);
  }
  return channel;
}

// ---------------------------------------------------------------- preflight

function assertCleanTree(): void {
  const dirty = capture('git', ['status', '--porcelain']);
  if (dirty) fail(`Working tree is not clean (untracked files count):\n${dirty}`);
}

function assertBranch(anyBranch: boolean): void {
  const branch = capture('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
  if (branch === RELEASE_BRANCH) return;
  if (!anyBranch) {
    fail(`Releases are cut from ${RELEASE_BRANCH}; currently on ${branch}. Pass --any-branch for a test run.`);
  }
  warn(`On ${branch}, not ${RELEASE_BRANCH}. --any-branch given, so branch and remote checks are skipped.`);
}

/**
 * Both remotes must already hold this commit.
 *
 * The public repo is what CI builds from and what provenance attests to; the
 * private mirror is where the work actually happens. Releasing while they
 * disagree tags one history and publishes another.
 */
function assertRemotesInSync(): void {
  const configured = capture('git', ['remote']).split('\n').filter(Boolean);
  const head = capture('git', ['rev-parse', 'HEAD']);
  for (const remote of REMOTES) {
    if (!configured.includes(remote)) fail(`Remote "${remote}" is not configured.`);
    capture('git', ['fetch', '--quiet', remote, RELEASE_BRANCH]);
    const tracked = capture('git', ['rev-parse', 'FETCH_HEAD']);
    if (tracked !== head) {
      fail(
        `${remote}/${RELEASE_BRANCH} is at ${tracked.slice(0, 7)} but HEAD is ${head.slice(0, 7)}. ` +
          `Push or pull before releasing.`,
      );
    }
  }
}

function assertChangelogReady(): void {
  const body = unreleasedBody(root);
  if (body === null) fail('CHANGELOG.md has no `## [Unreleased]` heading.');
  if (body === '') fail('CHANGELOG.md `## [Unreleased]` is empty. Write the notes before releasing.');
}

function assertUnpublished(version: string): void {
  const { name } = manifest();
  const result = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { cwd: root, encoding: 'utf8' });
  if (result.status === 0 && result.stdout.trim()) {
    fail(`${name}@${version} is already published. npm version numbers are permanent; pick another.`);
  }
}

/** In CI, a pushed tag is the release intent and must name the manifest exactly. */
function assertTriggeredTagMatchesManifest(): void {
  if (!isCI() || process.env.GITHUB_REF_TYPE !== 'tag') return;
  const version = manifest().version;
  const tag = process.env.GITHUB_REF_NAME;
  if (tag !== `v${version}`) {
    fail(`Triggered by tag ${tag || '(missing)'} but package.json says ${version}. Refusing this release run.`);
  }
}

type GitCapture = (args: string[]) => string;

/**
 * A release tag must point at a commit in the current main history.
 *
 * `prepare` already requires HEAD to equal both remotes' main branches before
 * it creates the tag. Repeating that invariant against CI's freshly fetched
 * `origin/main` prevents a tag on an unmerged commit from reaching the
 * privileged publish job, while allowing main to advance after the tag push.
 * Peeling both revisions keeps annotated tags and lightweight tags equivalent
 * for this check.
 */
export function assertTriggeredCommitBelongsToRemoteMain(
  env: NodeJS.ProcessEnv = process.env,
  git: GitCapture = (args) => capture('git', args),
): void {
  if (env.GITHUB_ACTIONS !== 'true' || env.GITHUB_REF_TYPE !== 'tag') return;

  const sha = env.GITHUB_SHA;
  if (!sha) fail('GITHUB_SHA is missing for a tag-triggered release run.');

  git(['fetch', '--quiet', '--no-tags', 'origin', RELEASE_BRANCH]);
  const taggedCommit = git(['rev-parse', '--verify', `${sha}^{commit}`]);
  const remoteMain = git(['rev-parse', '--verify', 'FETCH_HEAD^{commit}']);
  const commonAncestor = git(['merge-base', taggedCommit, remoteMain]);
  if (commonAncestor !== taggedCommit) {
    fail(
      `Release tag commit ${taggedCommit.slice(0, 12)} is not in origin/${RELEASE_BRANCH} history at ` +
        `${remoteMain.slice(0, 12)}. Refusing this release run.`,
    );
  }
}

/**
 * The pinned bun is what the published artifact is built with. A mismatch means
 * the tarball a reviewer approves was produced by a different compiler than the
 * one this repo claims to use.
 */
function assertToolchain(): void {
  const pinned = readFileSync(join(root, '.tool-versions'), 'utf8').match(/^bun\s+(\S+)/m)?.[1];
  if (!pinned) fail('.tool-versions does not pin bun.');
  const running = process.versions.bun;
  if (running !== pinned) {
    fail(
      `bun ${running} is running but .tool-versions pins ${pinned}. ` +
        `Install the pinned version, or update .tool-versions if the pin is the stale one.`,
    );
  }
}

/** A leftover tag from an abandoned attempt, which `git tag -a` would reject anyway. */
function assertTagFree(version: string): void {
  const existing = spawnSync('git', ['rev-parse', '--verify', `refs/tags/v${version}`], {
    cwd: root,
    encoding: 'utf8',
  });
  if (existing.status === 0) {
    fail(`Tag v${version} already exists locally. Delete it first: git tag -d v${version}`);
  }
}

function preflight(bump: string | undefined, anyBranch: boolean): string | null {
  assertCleanTree();
  assertBranch(anyBranch);
  if (!anyBranch) assertRemotesInSync();
  assertChangelogReady();
  assertToolchain();

  if (!bump) {
    note('Preflight passed. No bump given, so no target version was checked against npm.');
    return null;
  }
  const version = nextVersion(manifest().version, bump);
  assertTagFree(version);
  assertUnpublished(version);
  note(`Preflight passed. Target version ${version} (dist-tag ${distTag(version)}).`);
  return version;
}

// ------------------------------------------------------------------ prepare

function today(): string {
  const now = new Date();
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function dateChangelog(version: string): void {
  const path = join(root, 'CHANGELOG.md');
  const text = readFileSync(path, 'utf8');
  const heading = '## [Unreleased]';
  const index = text.indexOf(heading);
  if (index === -1) fail('CHANGELOG.md has no `## [Unreleased]` heading.');
  if (text.indexOf(heading, index + 1) !== -1) fail('CHANGELOG.md has more than one `## [Unreleased]` heading.');

  const dated = `${heading}\n\n## [${version}] - ${today()}`;
  writeFileSync(path, `${text.slice(0, index)}${dated}${text.slice(index + heading.length)}`);
}

function bumpManifest(version: string): void {
  const path = join(root, 'package.json');
  const text = readFileSync(path, 'utf8');
  const bumped = text.replace(/^(\s*"version":\s*")[^"]+(",)$/m, `$1${version}$2`);
  if (bumped === text) fail('Could not rewrite the version field in package.json.');
  writeFileSync(path, bumped);
  if (manifest().version !== version) fail(`package.json still reads ${manifest().version} after the bump.`);
}

function prepare(bump: string | undefined, anyBranch: boolean): void {
  if (!bump) fail('prepare needs a bump: major, minor, patch, or an explicit version.');
  const version = preflight(bump, anyBranch);
  if (!version) fail('prepare could not determine a target version.');

  dateChangelog(version);
  bumpManifest(version);

  // The files are already rewritten by this point. Track the commit boundary so
  // recovery advice remains correct if `git tag` fails after a successful commit.
  let committed = false;
  try {
    capture('git', ['add', 'CHANGELOG.md', 'package.json']);
    capture('git', ['commit', '-m', `Release v${version}`]);
    committed = true;
    capture('git', ['tag', '-a', `v${version}`, '-m', `Release v${version}`]);
  } catch (error) {
    const recovery = committed
      ? `The release commit was created but the tag was not. Retry the tag with:\n` +
        `  git tag -a v${version} -m "Release v${version}"\n\n` +
        `Or abandon both commit and edits with:\n` +
        `  git reset --soft HEAD~1\n` +
        `  git restore --staged CHANGELOG.md package.json\n` +
        `  git restore CHANGELOG.md package.json`
      : `CHANGELOG.md and package.json were rewritten but no release commit was created. Undo with:\n` +
        `  git restore --staged CHANGELOG.md package.json\n` +
        `  git restore CHANGELOG.md package.json`;
    fail(
      `${(error as Error).message}\n\n` +
        recovery,
    );
  }

  note('');
  note(`Prepared v${version}. Nothing has been pushed.`);
  note('');
  note('  git show                                    # review the commit');
  note('  git push origin main --follow-tags          # private mirror, triggers nothing');
  note('  git push origin-public main --follow-tags   # public repo, THIS starts the release');
  note('');
  note(`To abandon: git reset --hard HEAD~1 && git tag -d v${version}`);
}

// ------------------------------------------------------------------- verify

interface GateStep {
  name: string;
  status: 'pass' | 'FAIL' | 'not run';
  seconds: number | null;
}

/**
 * The blocking gate.
 *
 * `test:coverage` is deliberately the only test entry: it runs every test file
 * in its own bun process (the isolation the suite requires) and enforces the
 * thresholds, so it is a strict superset of `test`. Running both would double
 * the slowest part of the release for no extra signal.
 *
 * `test:e2e` is absent on purpose. It drives a real browser and never blocks a
 * release; it runs as its own advisory job.
 */
function verify(): void {
  const steps: Array<{ name: string; run: () => void }> = [
    { name: 'tag commit / origin main history', run: assertTriggeredCommitBelongsToRemoteMain },
    { name: 'tag / package version', run: assertTriggeredTagMatchesManifest },
    { name: 'typecheck', run: () => stream('bun', ['run', 'typecheck']) },
    { name: 'typecheck:scripts', run: () => stream('bun', ['run', 'typecheck:scripts']) },
    { name: 'build', run: () => stream('bun', ['run', 'build']) },
    { name: 'tests + coverage', run: () => stream('bun', ['run', 'test:coverage']) },
  ];
  const results: GateStep[] = steps.map((step) => ({ name: step.name, status: 'not run', seconds: null }));

  const writeGate = (ok: boolean) => {
    mkdirSync(join(root, 'tmp'), { recursive: true });
    writeFileSync(GATE_FILE, `${JSON.stringify({ ok, steps: results }, null, 2)}\n`);
  };

  for (const [index, step] of steps.entries()) {
    note(`\n=== ${step.name} ===`);
    const started = Date.now();
    try {
      step.run();
      const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      results[index] = { name: step.name, status: 'pass', seconds };
    } catch (error) {
      const seconds = Number(((Date.now() - started) / 1000).toFixed(1));
      results[index] = { name: step.name, status: 'FAIL', seconds };
      writeGate(false);
      fail(`Gate failed at ${step.name}: ${(error as Error).message}`);
    }
  }

  writeGate(true);
  note(`\nGate passed: ${results.map((r) => `${r.name} ${r.seconds}s`).join(', ')}`);
}

// -------------------------------------------------------------------- notes

function notes(version: string): void {
  const section = sectionFor(root, version);
  if (section === null) fail(`CHANGELOG.md has no ## [${version}] section.`);
  process.stdout.write(`${section}\n`);
}

// ------------------------------------------------------------------ publish

/**
 * npm attaches provenance only when package.json's `repository` names the repo
 * the publish is running from. When it does not, npm fails with a message about
 * provenance rather than about the field that is actually wrong, which is a
 * miserable thing to debug at the one moment a release is half-done.
 */
function assertRepositoryMatches(): void {
  const publishing = process.env.GITHUB_REPOSITORY;
  if (!publishing) return;
  const url = manifest().repository?.url ?? '';
  const declared = /github\.com[:/]([^/]+\/[^/.]+)/.exec(url)?.[1];
  if (declared !== publishing) {
    fail(
      `package.json repository is "${url}" but this is publishing from ${publishing}. ` +
        `Provenance requires them to match, case included.`,
    );
  }
}

function publish(): void {
  const { name, version } = manifest();
  const tag = distTag(version);

  // The tag that triggered the run and the version in the tree are set by
  // different steps and can disagree. Publishing on that disagreement burns a
  // version number that nobody chose.
  const ref = process.env.GITHUB_REF_NAME;
  if (ref && ref !== `v${version}`) {
    fail(`Triggered by tag ${ref} but package.json says ${version}. Refusing to publish.`);
  }

  if (isCI() && !process.env.ACTIONS_ID_TOKEN_REQUEST_URL) {
    fail('No OIDC token available. The publish job needs `permissions: id-token: write`.');
  }
  assertRepositoryMatches();

  // A failed `finish` leaves npm published but the GitHub Release absent. A
  // normal Actions rerun starts this job from its first step, so recognize the
  // exact published version and continue to finish instead of stopping on npm's
  // immutable-version error. The tag/version check above still prevents a tag
  // from silently claiming a different manifest.
  const existing = spawnSync('npm', ['view', `${name}@${version}`, 'version'], { cwd: root, encoding: 'utf8' });
  if (existing.status === 0 && existing.stdout.trim() === version) {
    note(`${name}@${version} is already published; continuing to GitHub Release recovery.`);
    return;
  }

  note(`Publishing ${name}@${version} under dist-tag "${tag}".`);
  stream('npm', ['publish', '--access', 'public', '--tag', tag]);
}

// ------------------------------------------------------------------- finish

/**
 * Create the GitHub Release. Deliberately does not push tags.
 *
 * The tag push to the public repo is what triggered this run, so by the time
 * this executes the tag is already there. Mirroring it back to the private repo
 * from here would mean giving a public-repo workflow a write credential for a
 * private one, which is a bad trade for a `git push` that happens on the laptop
 * anyway.
 */
function finish(version: string): void {
  const section = sectionFor(root, version);
  if (section === null) fail(`CHANGELOG.md has no ## [${version}] section, so the Release would have an empty body.`);

  const repo = process.env.GITHUB_REPOSITORY ?? PUBLIC_REPO;
  const existing = spawnSync('gh', ['release', 'view', `v${version}`, '-R', repo], { cwd: root, encoding: 'utf8' });
  if (existing.status === 0) {
    note(`GitHub Release v${version} already exists on ${repo}; nothing to finish.`);
    return;
  }

  mkdirSync(join(root, 'tmp'), { recursive: true });
  const bodyPath = join(root, 'tmp', `release-notes-${version}.md`);
  writeFileSync(bodyPath, `${section}\n`);
  try {
    const args = ['release', 'create', `v${version}`, '-R', repo, '--title', `v${version}`, '--notes-file', bodyPath];
    if (distTag(version) !== 'latest') args.push('--prerelease');
    stream('gh', args);
    note(`GitHub Release v${version} created on ${repo}.`);
  } finally {
    if (existsSync(bodyPath)) rmSync(bodyPath, { force: true });
  }
}

// --------------------------------------------------------------------- main

function main(): void {
  const argv = process.argv.slice(2);
  const anyBranch = argv.includes('--any-branch');
  const positional = argv.filter((arg) => !arg.startsWith('--'));
  const [command, argument] = positional;
  const version = argument ?? manifest().version;

  switch (command) {
    case 'preflight':
      preflight(argument, anyBranch);
      return;
    case 'prepare':
      prepare(argument, anyBranch);
      return;
    case 'verify':
      verify();
      return;
    case 'notes':
      notes(version);
      return;
    case 'publish':
      publish();
      return;
    case 'finish':
      finish(version);
      return;
    default:
      fail(
        `Usage: bun scripts/release.ts <preflight|prepare|verify|notes|publish|finish> [arg] [--any-branch]\n` +
          (command ? `Unknown command "${command}".` : ''),
      );
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    if (error instanceof ReleaseError) {
      console.error(`\n✗ ${error.message}`);
      process.exit(1);
    }
    throw error;
  }
}
