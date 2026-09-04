/**
 * Gate candidates and text fingerprints.
 *
 * Pure module, no node imports: the gate uses it to decide what the judge is
 * looking at, and the browser bundle uses the same code to tell whether the
 * text on an approval card is still the text a recorded verdict judged. Both
 * sides must compose a candidate's text identically, so the composition lives
 * here once.
 */

import type { GateCandidate } from './types.js';

/** The reviewable candidates on a gate. Slate gates key each `changes[]`
 * entry by its `optionId`; single-draft gates key by position. A gate with no
 * changes but a `draft` is one candidate. Empty when nothing is reviewable. */
export function extractGateCandidates(input: Record<string, unknown>): GateCandidate[] {
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;
  const options = Array.isArray(input.options) ? input.options as Array<Record<string, unknown>> : [];
  const optionLabels = new Map<string, string>();
  for (const option of options) {
    const id = str(option?.id);
    if (id) optionLabels.set(id, str(option?.label) ?? id);
  }
  const changes = Array.isArray(input.changes)
    ? input.changes as Array<{ label?: unknown; content?: unknown; displayContent?: unknown; optionId?: unknown }>
    : [];
  const candidates: GateCandidate[] = [];
  const seen = new Set<string>();
  changes.forEach((change, index) => {
    const text = str(change?.displayContent) ?? str(change?.content);
    if (!text) return;
    const optionId = str(change?.optionId);
    const id = optionId ?? `change-${index + 1}`;
    // Two changes under one option (post + first comment) are one candidate:
    // the reviewer picks the option, not the individual action.
    if (seen.has(id)) {
      const existing = candidates.find((candidate) => candidate.id === id)!;
      existing.text = `${existing.text}\n\n${text}`;
      return;
    }
    seen.add(id);
    const label = optionId
      ? optionLabels.get(optionId) ?? str(change?.label) ?? optionId
      : str(change?.label) ?? `Action ${index + 1}`;
    candidates.push({ id, label, text });
  });
  if (candidates.length === 0) {
    const draft = str(input.draft);
    if (draft) candidates.push({ id: 'draft', label: 'Draft', text: draft });
  }
  return candidates;
}

/**
 * Short, stable fingerprint of a candidate's text (FNV-1a, 32-bit, hex). Not a
 * security hash: it only has to tell "same text" from "revised text" between
 * the moment the judge looked and the moment a reviewer opens the card, and it
 * has to run synchronously in both node and the browser.
 */
export function fingerprintText(text: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16).padStart(8, '0')}:${text.length}`;
}
