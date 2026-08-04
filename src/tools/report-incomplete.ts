/**
 * Compatibility re-export. The per-run outcome slot grew a second writer
 * (`report_complete`), so the implementation moved to ./report-outcome.ts.
 */
export {
  createReportIncompleteTool,
  createReportCompleteTool,
  normalizeHeadline,
  MAX_HEADLINE_LENGTH,
  type RunOutcome,
} from './report-outcome.js';
