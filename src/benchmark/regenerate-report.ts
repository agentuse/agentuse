import { readFile, writeFile } from 'fs/promises';
import { dirname } from 'path';
import { generateMarkdownReport, generateHtmlReport, isRawBenchmarkResult } from './reporter/index.js';
import { calculateMetrics } from './calculator.js';

/**
 * Regenerate HTML and Markdown reports from existing JSON result
 */
export async function regenerateReports(jsonPath: string): Promise<string[]> {
  const json = await readFile(jsonPath, 'utf-8');
  const parsed = JSON.parse(json);

  if (!isRawBenchmarkResult(parsed)) {
    throw new Error('Incompatible JSON format. Re-run benchmark to generate new format.');
  }

  const result = calculateMetrics(parsed);
  const outputDir = dirname(jsonPath);
  const baseName = `${result.suiteId}-${result.runId}`;

  const savedFiles: string[] = [];

  // Generate Markdown
  const mdPath = `${outputDir}/${baseName}.md`;
  await writeFile(mdPath, generateMarkdownReport(result), 'utf-8');
  savedFiles.push(mdPath);

  // Generate HTML
  const htmlPath = `${outputDir}/${baseName}.html`;
  await writeFile(htmlPath, generateHtmlReport(result), 'utf-8');
  savedFiles.push(htmlPath);

  return savedFiles;
}
