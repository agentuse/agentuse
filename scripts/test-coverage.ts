/**
 * Run every test file in its own Bun process, merge the resulting LCOV data,
 * and enforce suite-wide source line/function thresholds.
 *
 * Tests are intentionally isolated in package.json because Bun module mocks can
 * leak between files in a shared process. A single `bun test --coverage` would
 * change that isolation contract, so this runner preserves it and unions hits
 * from the per-file reports.
 */
import { spawnSync } from 'node:child_process';
import { mkdir, readFile, readdir, rm } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';

const root = resolve(import.meta.dir, '..');
const outputRoot = join(root, 'tmp', 'coverage');
const LINE_THRESHOLD = 55;
const FUNCTION_THRESHOLD = 65;

interface FileCoverage {
  lines: Map<number, number>;
  functionsFound: number;
  functionsHit: number;
}

const merged = new Map<string, FileCoverage>();

function sourceRecord(source: string): FileCoverage | null {
  const absolute = resolve(root, source);
  const repoPath = relative(root, absolute).replaceAll('\\', '/');
  if (!repoPath.startsWith('src/')) return null;
  let record = merged.get(repoPath);
  if (!record) {
    record = { lines: new Map(), functionsFound: 0, functionsHit: 0 };
    merged.set(repoPath, record);
  }
  return record;
}

function mergeLcov(raw: string): void {
  let current: FileCoverage | null = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith('SF:')) {
      current = sourceRecord(line.slice(3));
      continue;
    }
    if (line === 'end_of_record') {
      current = null;
      continue;
    }
    if (!current) continue;

    if (line.startsWith('FNF:')) {
      // Bun's LCOV omits per-function FN/FNDA identities. Maxima are therefore
      // the only non-inflating merge across isolated runs: they are a
      // conservative lower bound when different tests cover different
      // functions in the same file.
      current.functionsFound = Math.max(current.functionsFound, Number(line.slice(4)));
      continue;
    }
    if (line.startsWith('FNH:')) {
      current.functionsHit = Math.max(current.functionsHit, Number(line.slice(4)));
      continue;
    }
    if (line.startsWith('DA:')) {
      const comma = line.indexOf(',');
      if (comma <= 3) continue;
      const lineNumber = Number(line.slice(3, comma));
      const hits = Number(line.slice(comma + 1).split(',')[0]);
      current.lines.set(lineNumber, Math.max(current.lines.get(lineNumber) ?? 0, hits));
    }
  }
}

function percentage(covered: number, total: number): number {
  return total === 0 ? 100 : covered / total * 100;
}

async function main(): Promise<void> {
  await rm(outputRoot, { recursive: true, force: true });
  await mkdir(outputRoot, { recursive: true });

  const files = (await readdir(join(root, 'tests')))
    .filter((file) => /\.test\.tsx?$/.test(file))
    .map((file) => `tests/${file}`)
    .sort();
  const pluginIndex = files.indexOf('tests/plugin-manager.test.ts');
  if (pluginIndex >= 0) {
    files.splice(pluginIndex, 1);
    files.unshift('tests/plugin-manager.test.ts');
  }

  console.log(`Coverage: ${files.length} isolated test files`);
  for (const [index, file] of files.entries()) {
    const reportDir = join(outputRoot, String(index).padStart(3, '0'));
    const result = spawnSync(process.execPath, [
      'test',
      file,
      '--coverage',
      '--coverage-reporter=lcov',
      `--coverage-dir=${reportDir}`,
    ], {
      cwd: root,
      encoding: 'utf8',
      env: process.env,
      timeout: 120_000,
    });
    if (result.status !== 0) {
      console.error(`\n${file} failed while collecting coverage:\n${result.stdout}${result.stderr}`);
      process.exit(result.status ?? 1);
    }
    try {
      const lcov = await readFile(join(reportDir, 'lcov.info'), 'utf8');
      mergeLcov(lcov);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      // A black-box test may execute only a shell fixture and therefore
      // instrument no TypeScript source. It still has to pass, but contributes
      // no records to the merged coverage totals.
    }
    if ((index + 1) % 20 === 0 || index === files.length - 1) {
      console.log(`  ${index + 1}/${files.length}`);
    }
  }

  let coveredLines = 0;
  let totalLines = 0;
  let coveredFunctions = 0;
  let totalFunctions = 0;
  const fileRows: Array<{ file: string; covered: number; total: number }> = [];
  for (const [file, coverage] of merged) {
    const fileCovered = [...coverage.lines.values()].filter((hits) => hits > 0).length;
    coveredLines += fileCovered;
    totalLines += coverage.lines.size;
    coveredFunctions += coverage.functionsHit;
    totalFunctions += coverage.functionsFound;
    fileRows.push({ file, covered: fileCovered, total: coverage.lines.size });
  }

  const lines = percentage(coveredLines, totalLines);
  const functions = percentage(coveredFunctions, totalFunctions);
  console.log('\nMerged source coverage');
  console.log(`  lines      ${lines.toFixed(2)}% (${coveredLines}/${totalLines}) — minimum ${LINE_THRESHOLD}%`);
  console.log(`  functions  ${functions.toFixed(2)}% (${coveredFunctions}/${totalFunctions}) — minimum ${FUNCTION_THRESHOLD}% (conservative isolated-run merge)`);

  const weakest = fileRows
    .filter((row) => row.total >= 20)
    .sort((a, b) => percentage(a.covered, a.total) - percentage(b.covered, b.total))
    .slice(0, 8);
  if (weakest.length > 0) {
    console.log('\nLowest line coverage (files with at least 20 instrumented lines)');
    for (const row of weakest) {
      console.log(`  ${percentage(row.covered, row.total).toFixed(2).padStart(6)}%  ${row.file}`);
    }
  }

  if (lines < LINE_THRESHOLD || functions < FUNCTION_THRESHOLD) {
    console.error('\nCoverage threshold not met.');
    process.exit(1);
  }
}

await main();
