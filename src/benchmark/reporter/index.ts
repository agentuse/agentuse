import { generateJsonReport, saveJsonReport, isRawBenchmarkResult } from './json.js';
import { generateMarkdownReport, saveMarkdownReport } from './markdown.js';
import { generateHtmlReport, saveHtmlReport } from './html.js';
import type { SuiteResult } from '../types.js';

// Re-export shared utilities for external consumers
export {
  type ReportData,
  generateReportData,
  formatDuration,
  formatCost,
  formatPercent,
  formatTokens,
  GLOSSARY_ITEMS,
} from './shared.js';

export {
  generateJsonReport,
  saveJsonReport,
  isRawBenchmarkResult,
  generateMarkdownReport,
  saveMarkdownReport,
  generateHtmlReport,
  saveHtmlReport,
};

export type ReportFormat = 'json' | 'markdown' | 'html';

/**
 * Save reports in specified formats
 */
export async function saveReports(
  result: SuiteResult,
  outputDir: string,
  formats: ReportFormat[] = ['json', 'markdown', 'html']
): Promise<string[]> {
  const savedFiles: string[] = [];

  for (const format of formats) {
    switch (format) {
      case 'json':
        savedFiles.push(await saveJsonReport(result, outputDir));
        break;
      case 'markdown':
        savedFiles.push(await saveMarkdownReport(result, outputDir));
        break;
      case 'html':
        savedFiles.push(await saveHtmlReport(result, outputDir));
        break;
    }
  }

  return savedFiles;
}
