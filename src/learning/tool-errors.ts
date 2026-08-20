import type { ToolCallTrace } from '../plugin/types';
import type { LearningDraft } from './types';
import { generateLearningId } from './store';

/**
 * The `tool-errors` capture addon: learns a failed tool call followed by a
 * corrected call and a confirmed successful outcome.
 *
 * This channel's value is structural verification IN CODE, not in the prompt:
 * a candidate is stored only when the trace contains the failed call, the
 * corrected call, and the success. It cannot conflict with instructions
 * because it captures mechanics, not policy — which is why its records skip
 * the model-judged vet. Records dedupe by (tool, failure signature) and
 * supersede structurally in the store; they never go through the free-text
 * merge path.
 */
export interface ToolErrorRecovery {
  tool: string;
  failureSignature: string;
  failed: ToolCallTrace;
  succeeded: ToolCallTrace;
}

const asText = (value: unknown): string => {
  if (value === undefined || value === null) return '';
  return typeof value === 'string' ? value : JSON.stringify(value);
};

/**
 * Normalize a failure output into the dedupe signature: first meaningful line,
 * lowercased, run-specific noise (numbers, hex ids, quoted paths) collapsed so
 * the same failure mode observed across runs keys the same record. Derived in
 * code, deterministically — a model-worded signature would vary run to run and
 * dedupe would never fire.
 */
export function failureSignature(output: unknown): string {
  const text = asText(output);
  const firstLine = text.split('\n').find((line) => line.trim().length > 0) ?? '';
  return firstLine
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, '#')   // hashes, uuids, session ids
    .replace(/\d+/g, '#')            // counts, ports, timestamps
    .replace(/(["'`])[^"'`]*\1/g, '"…"') // quoted values (paths, names)
    .replace(/\|/g, '/')             // metadata-comment safety
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 100);
}

/**
 * Scan a run's traces for failure→recovery pairs: a failed call of a tool,
 * followed later by a successful call of the SAME tool with different input.
 * One record per (tool, signature) per run — the first failure and the first
 * success after it are the evidence.
 */
export function detectToolErrorRecoveries(traces: ToolCallTrace[] | undefined): ToolErrorRecovery[] {
  if (!traces || traces.length === 0) return [];
  const recoveries: ToolErrorRecovery[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < traces.length; i++) {
    const failed = traces[i]!;
    if (failed.type !== 'tool' || failed.success !== false) continue;
    const signature = failureSignature(failed.output);
    if (!signature) continue;
    const key = `${failed.name}\0${signature}`;
    if (seen.has(key)) continue;

    const succeeded = traces.slice(i + 1).find((t) =>
      t.type === 'tool'
      && t.name === failed.name
      && t.success === true
      // The recovery must be a CORRECTED call: a retry with identical input
      // that happened to work is flakiness, not a lesson.
      && asText(t.input) !== asText(failed.input));
    if (!succeeded) continue;

    seen.add(key);
    recoveries.push({ tool: failed.name, failureSignature: signature, failed, succeeded });
  }
  return recoveries;
}

const truncate = (text: string, max: number): string =>
  text.length > max ? `${text.slice(0, max)}…` : text;

/**
 * Turn a structurally-verified recovery into a stored draft. The wording is
 * built in code, deterministically: the instruction names the failure and
 * points at the corrected call, and the evidence line carries both calls so a
 * reader (or the tidy pass) can judge it later.
 */
export function toolErrorDraft(
  recovery: ToolErrorRecovery,
  now: string,
): LearningDraft {
  const failedInput = truncate(asText(recovery.failed.input), 160);
  const successInput = truncate(asText(recovery.succeeded.input), 200);
  return {
    id: generateLearningId(),
    category: 'error-fix',
    title: `${recovery.tool}: ${truncate(recovery.failureSignature, 60)}`,
    instruction: `When ${recovery.tool} fails with "${recovery.failureSignature}", use the corrected call shape that succeeded: ${successInput}`,
    // Structurally verified, not a model's guess — the trace contains the
    // failed call, the corrected call, and the success.
    confidence: 1,
    injectedCount: 0,
    extractedAt: now,
    source: 'auto',
    channel: 'tool-errors',
    tool: recovery.tool,
    failureSignature: recovery.failureSignature,
    evidence: `failed: ${failedInput} → succeeded: ${successInput}`,
    reasserted: 0,
    approvedRuns: 0,
  };
}
