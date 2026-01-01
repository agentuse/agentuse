import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { SuiteResult, RawBenchmarkResult } from '../types.js';
import { extractRawData } from '../calculator.js';

/**
 * Generate JSON report from suite results
 * Saves only raw trial data - metrics are computed on load
 */
export function generateJsonReport(result: SuiteResult): string {
  const rawData = extractRawData(result);
  return JSON.stringify(rawData, null, 2);
}

/**
 * Save JSON report to file
 */
export async function saveJsonReport(
  result: SuiteResult,
  outputDir: string
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const filename = `${result.suiteId}-${result.runId}.json`;
  const filepath = join(outputDir, filename);

  await writeFile(filepath, generateJsonReport(result), 'utf-8');

  return filepath;
}

/**
 * Type guard to check if loaded JSON is raw format
 */
export function isRawBenchmarkResult(data: unknown): data is RawBenchmarkResult {
  return (
    typeof data === 'object' &&
    data !== null &&
    'version' in data &&
    (data as RawBenchmarkResult).version === 2 &&
    'trials' in data &&
    Array.isArray((data as RawBenchmarkResult).trials)
  );
}
