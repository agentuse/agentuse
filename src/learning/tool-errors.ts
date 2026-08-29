import { createHash } from 'crypto';
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
 * the normal contract vet. Records dedupe by (tool, failure signature) and
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
  const normalized = firstLine
    .toLowerCase()
    .replace(/[0-9a-f]{8,}/g, '#')
    .replace(/\d+/g, '#')
    .replace(/(["'`])[^"'`]*\1/g, '"…"')
    .replace(/\s+/g, ' ')
    .trim();
  // Persist only an opaque dedupe token: tool output may contain credentials or
  // adversarial text and must never become a future prompt instruction.
  return normalized ? createHash('sha256').update(normalized).digest('hex').slice(0, 12) : '';
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

    // Only the next tool call can be called a retry. Pairing with any later
    // success confuses unrelated uses of a common tool for a recovery.
    const succeeded = traces.slice(i + 1).find((t) => t.type === 'tool');
    if (
      !succeeded
      || succeeded.name !== failed.name
      || succeeded.success !== true
      // The recovery must be a CORRECTED call: a retry with identical input
      // that happened to work is flakiness, not a lesson.
      || asText(succeeded.input) === asText(failed.input)
    ) continue;

    seen.add(key);
    recoveries.push({ tool: failed.name, failureSignature: signature, failed, succeeded });
  }
  return recoveries;
}

const safeName = (text: string): string => text.replace(/[^a-zA-Z0-9_.:-]/g, '_').slice(0, 80) || 'tool';

const safeFieldName = (name: string): string | undefined => {
  if (!/^[a-zA-Z_][a-zA-Z0-9_.-]{0,63}$/.test(name)) return undefined;
  return name;
};

const valueType = (value: unknown): string =>
  Array.isArray(value) ? 'array' : value === null ? 'null' : typeof value;

const inputShape = (input: unknown): string => {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return typeof input;
  const fields = Object.entries(input as Record<string, unknown>)
    .map(([name, value]) => ({ name: safeFieldName(name), type: valueType(value) }))
    .filter((field): field is { name: string; type: string } => field.name !== undefined)
    .sort((a, b) => a.name.localeCompare(b.name));
  return fields.length === 0
    ? 'object(no safe fields)'
    : fields.map(({ name, type }) => `\`${name}\`: ${type}`).join(', ');
};

/**
 * Turn a structurally-verified recovery into a stored draft. Only argument
 * names and value types survive; raw tool inputs/outputs may contain secrets or
 * adversarial text and are never persisted.
 */
export function toolErrorDraft(
  recovery: ToolErrorRecovery,
  now: string,
): LearningDraft {
  const tool = safeName(recovery.tool);
  const failedShape = inputShape(recovery.failed.input);
  const successShape = inputShape(recovery.succeeded.input);
  return {
    id: generateLearningId(),
    category: 'error-fix',
    title: 'Correct rejected tool arguments',
    instruction: `For tool \`${tool}\`, after this argument-shape failure, retry only when the agent instructions and current task permit it, using corrected fields: ${successShape}.`,
    // Structurally verified and strictly constrained in code; no trace text or
    // argument value reaches the stored prompt.
    confidence: 1,
    injectedCount: 0,
    extractedAt: now,
    source: 'auto',
    channel: 'tool-errors',
    tool,
    failureSignature: recovery.failureSignature,
    evidence: `failed shape: ${failedShape} → succeeded shape: ${successShape}`,
    reasserted: 0,
    approvedRuns: 0,
  };
}
