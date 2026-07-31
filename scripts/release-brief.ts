/**
 * Build the release review brief.
 *
 * Everything a human needs to approve or reject a release, on one screen, so the
 * decision never requires opening a job log. Written to stdout, and appended to
 * $GITHUB_STEP_SUMMARY when running in Actions so it renders at the top of the
 * run page, next to the Approve button.
 *
 * The brief only reports. It never gates: a red line here is information for the
 * reviewer, and the decision stays theirs.
 */
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { sectionFor } from './lib/changelog.ts';

const root = resolve(import.meta.dir, '..');

/** Paths the published tarball is allowed to contain, from package.json "files". */
const ALLOWED_ROOTS = ['bin/', 'dist/', 'skills/', 'skill-data/', 'README.md', 'LICENSE', 'package.json'];

/** Tarball growth beyond this fraction gets called out rather than stated quietly. */
const SIZE_ALERT = 0.2;

interface PackFile {
  path: string;
  size: number;
}

interface PackResult {
  version: string;
  size: number;
  unpackedSize: number;
  entryCount: number;
  files: PackFile[];
}

function run(cmd: string, args: string[], cwd = root): string {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  if (result.status !== 0) {
    throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stderr || result.stdout}`);
  }
  return result.stdout.trim();
}

function tryRun(cmd: string, args: string[], cwd = root): string | null {
  const result = spawnSync(cmd, args, { cwd, encoding: 'utf8' });
  return result.status === 0 ? result.stdout.trim() : null;
}

function mb(bytes: number): string {
  return `${(bytes / 1_000_000).toFixed(2)} MB`;
}

/**
 * `--ignore-scripts` skips `prepack`, so this measures the dist the gate just
 * built rather than rebuilding it. Rebuilding here would report on bytes nobody
 * tested.
 */
function pack(): PackResult {
  const raw = run('npm', ['pack', '--dry-run', '--json', '--ignore-scripts']);
  return JSON.parse(raw)[0] as PackResult;
}

/** Published size of the current latest, so growth is visible at a glance. */
function publishedBaseline(): { version: string; unpackedSize: number; entryCount: number } | null {
  const raw = tryRun('npm', ['view', 'agentuse@latest', 'version', 'dist.unpackedSize', 'dist.fileCount', '--json']);
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return {
      version: parsed.version,
      unpackedSize: parsed['dist.unpackedSize'],
      entryCount: parsed['dist.fileCount'],
    };
  } catch {
    return null;
  }
}

/** Anything the tarball carries that package.json "files" does not explain. */
function unexpectedPaths(files: PackFile[]): PackFile[] {
  return files.filter((f) => !ALLOWED_ROOTS.some((root) => f.path === root || f.path.startsWith(root)));
}

/** Largest contributors by extension, so a size jump has an immediate suspect. */
function sizeByKind(files: PackFile[]): Array<[string, number, number]> {
  const totals = new Map<string, { bytes: number; count: number }>();
  for (const file of files) {
    const kind = file.path.endsWith('.js.map')
      ? '.map'
      : file.path.endsWith('.br') || file.path.endsWith('.gz')
        ? 'precompressed'
        : `.${file.path.split('.').pop()}`;
    const entry = totals.get(kind) ?? { bytes: 0, count: 0 };
    entry.bytes += file.size;
    entry.count += 1;
    totals.set(kind, entry);
  }
  return [...totals.entries()]
    .map(([kind, { bytes, count }]) => [kind, bytes, count] as [string, number, number])
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5);
}

/**
 * Install the real tarball into a throwaway prefix and run the binary.
 *
 * The existing `smoke:cli` runs the CLI from the repo, which proves the repo
 * works, not that the package does: a wrong "files" array ships a broken tarball
 * while that check stays green. This is the only step that exercises what a user
 * actually receives.
 */
function installSmoke(): { ok: boolean; detail: string } {
  const dir = mkdtempSync(join(tmpdir(), 'agentuse-smoke-'));
  try {
    const tgz = run('npm', ['pack', '--ignore-scripts', '--pack-destination', dir]);
    const installed = spawnSync('npm', ['install', '--no-save', '--prefix', dir, join(dir, tgz)], {
      cwd: root,
      encoding: 'utf8',
    });
    if (installed.status !== 0) {
      return { ok: false, detail: `install failed: ${(installed.stderr || '').split('\n').slice(-3).join(' ')}` };
    }
    const bin = join(dir, 'node_modules', '.bin', 'agentuse');
    const version = spawnSync(bin, ['--version'], { encoding: 'utf8' });
    if (version.status !== 0) {
      return { ok: false, detail: `binary failed: ${(version.stderr || version.stdout || '').trim().split('\n')[0]}` };
    }
    return { ok: true, detail: version.stdout.trim() };
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Gate results, read from the file `release.ts verify` writes.
 *
 * A file rather than the workflow's step outcomes, because verify is one step:
 * if it fails partway, the outcome is just "failed" and the reviewer has to open
 * the log to learn where. The file names the step that stopped it and marks the
 * ones that never got to run.
 */
function gateRows(): Array<[string, string]> {
  const gatePath = join(root, 'tmp', 'release-gate.json');
  const coveragePath = join(root, 'tmp', 'coverage', 'summary.json');
  const rows: Array<[string, string]> = [];
  if (existsSync(gatePath)) {
    const gate = JSON.parse(readFileSync(gatePath, 'utf8')) as {
      steps: Array<{ name: string; status: string; seconds: number | null }>;
    };
    for (const step of gate.steps) {
      rows.push([step.name, step.seconds === null ? step.status : `${step.status} (${step.seconds}s)`]);
    }
  } else {
    rows.push(['gate', 'not run']);
  }
  if (existsSync(coveragePath)) {
    const c = JSON.parse(readFileSync(coveragePath, 'utf8'));
    const lineOk = c.lines >= c.lineThreshold;
    const fnOk = c.functions >= c.functionThreshold;
    rows.push([
      'coverage',
      `${lineOk ? 'pass' : 'FAIL'} lines ${c.lines.toFixed(1)}% (min ${c.lineThreshold}%), ` +
        `${fnOk ? 'pass' : 'FAIL'} functions ${c.functions.toFixed(1)}% (min ${c.functionThreshold}%)`,
    ]);
  } else {
    rows.push(['coverage', process.env.GATE_COVERAGE ?? 'not run']);
  }
  rows.push(['e2e (advisory, never blocks)', process.env.GATE_E2E ?? 'not run']);
  return rows;
}

function main(): void {
  const manifestVersion = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).version as string;
  const version = process.argv[2]?.startsWith('--') ? manifestVersion : (process.argv[2] ?? manifestVersion);
  const skipSmoke = process.argv.includes('--no-smoke');

  const packed = pack();
  const baseline = publishedBaseline();
  const unexpected = unexpectedPaths(packed.files);
  const notes = sectionFor(root, version);
  const sha = run('git', ['rev-parse', '--short', 'HEAD']);
  const lastTag = tryRun('git', ['describe', '--tags', '--abbrev=0', 'HEAD^']) ?? tryRun('git', ['describe', '--tags', '--abbrev=0']);
  const commits = lastTag ? tryRun('git', ['rev-list', '--count', `${lastTag}..HEAD`]) : null;
  const actor = process.env.GITHUB_ACTOR ?? run('git', ['log', '-1', '--format=%an']);
  const repo = process.env.GITHUB_REPOSITORY ?? 'agentuse/agentuse';

  const out: string[] = [];
  const w = (line = '') => out.push(line);

  w(`## Release review: agentuse ${baseline ? `${baseline.version} → ` : ''}${version}`);
  w();
  w(`\`${sha}\` pushed by **${actor}**${commits ? ` · ${commits} commits since ${lastTag}` : ''}`);
  if (commits && lastTag) w(`[Compare ${lastTag}...${version}](https://github.com/${repo}/compare/${lastTag}...v${version})`);
  w();

  // The tag being released and the version in the manifest are set by different
  // steps, so they can disagree. That ships a package whose contents announce a
  // version nobody asked for, and it is invisible unless something checks.
  if (version !== manifestVersion) {
    w(`> **Version mismatch.** Releasing \`${version}\` but package.json says \`${manifestVersion}\`. Do not approve until this is explained.`);
    w();
  }

  w('### Gate');
  w();
  w('| check | result |');
  w('| --- | --- |');
  for (const [name, result] of gateRows()) w(`| ${name} | ${result} |`);
  w();

  w('### Package');
  w();
  const sizeDelta = baseline ? packed.unpackedSize / baseline.unpackedSize - 1 : 0;
  const fileDelta = baseline ? packed.entryCount - baseline.entryCount : 0;
  w('| | this release | published |');
  w('| --- | --- | --- |');
  w(`| unpacked | ${mb(packed.unpackedSize)} | ${baseline ? mb(baseline.unpackedSize) : 'n/a'} |`);
  w(`| files | ${packed.entryCount} | ${baseline ? baseline.entryCount : 'n/a'} |`);
  w(`| tarball | ${mb(packed.size)} | |`);
  w();
  if (baseline && Math.abs(sizeDelta) >= SIZE_ALERT) {
    w(
      `> **Size changed ${sizeDelta > 0 ? 'up' : 'down'} ${Math.abs(sizeDelta * 100).toFixed(0)}%** ` +
        `(${fileDelta >= 0 ? '+' : ''}${fileDelta} files). Worth knowing why before approving.`,
    );
    w();
  }
  w('<details><summary>Largest contributors</summary>');
  w();
  w('| kind | size | files |');
  w('| --- | --- | --- |');
  for (const [kind, bytes, count] of sizeByKind(packed.files)) {
    w(`| ${kind} | ${mb(bytes)} (${((bytes / packed.unpackedSize) * 100).toFixed(0)}%) | ${count} |`);
  }
  w();
  w('</details>');
  w();

  if (unexpected.length > 0) {
    w(`> **${unexpected.length} unexpected path(s) in the tarball.** These are outside package.json \`files\`:`);
    w();
    for (const file of unexpected.slice(0, 20)) w(`> - \`${file.path}\``);
    w();
  } else {
    w('Contents match package.json `files`, nothing unexpected.');
    w();
  }

  if (skipSmoke) {
    w('Install smoke: skipped.');
  } else {
    const smoke = installSmoke();
    w(`Install smoke (clean install of the real tarball): ${smoke.ok ? `**pass**, prints \`${smoke.detail}\`` : `**FAIL**, ${smoke.detail}`}`);
  }
  w();

  w('### Release notes to be published');
  w();
  if (notes) {
    w('<details><summary>Preview</summary>');
    w();
    w(notes);
    w();
    w('</details>');
  } else {
    w(`> **No changelog section found for ${version}.** The GitHub Release would have an empty body.`);
  }

  const brief = out.join('\n');
  console.log(brief);
  if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${brief}\n`);
}

main();
