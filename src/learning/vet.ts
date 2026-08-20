import { completeText } from '../complete-text';
import { helperSystemPrompt } from '../utils/anthropic';
import { logger } from '../utils/logger';
import { splitInstructions } from './contract';
import type { Learning, LearningDraft } from './types';

/**
 * The vet: every candidate is checked against the complete agent contract, the
 * rules already in force, and (for free-form candidates) the session trace,
 * BEFORE it can become active. This is the step the motivating production
 * failure was missing — both bad candidates there were mechanically detectable,
 * one duplicating the contract and one contradicting it, which is why this is
 * an automatic pass rather than a human approval queue nobody drains.
 *
 * What each verdict means downstream:
 * - pass: the candidate becomes active.
 * - duplicate: restates the contract or an active rule. Free-form candidates
 *   are rejected (nothing is lost — the rule already exists); human
 *   corrections are quarantined instead, because a human wrote them and
 *   silently dropping human input is never allowed.
 * - contradiction: conflicts with the contract or an active rule. Quarantined
 *   with the conflicting text named.
 * - ungrounded: the trace contradicts the claim or does not contain it.
 *   Rejected. Never raised for human corrections — a human authored the entry,
 *   which is grounding the trace cannot overrule.
 *
 * The duplicate and contradiction checks run against text the system already
 * possesses; grounding for typed channels is checked structurally in code
 * (see tool-errors) and typed candidates never come through here. This vet is
 * model-judged, so it reduces junk — the code-side checks are the hard
 * guarantees.
 */
export type VetVerdict =
  | { verdict: 'pass' }
  | { verdict: 'duplicate'; of: string }
  | { verdict: 'contradiction'; conflict: string }
  | { verdict: 'ungrounded'; reason: string };

interface RawVetVerdict {
  id?: string;
  verdict?: string;
  detail?: string;
}

const trunc = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}\n...(truncated)` : s);

/**
 * Vet candidates in one helper call. Returns a verdict per draft id; a draft
 * the model failed to rule on gets no entry, and the caller decides what a
 * missing verdict means for its channel (fail open for human corrections, fail
 * closed for free-form observation capture).
 *
 * The contract is passed COMPLETE — body and graduated block both — because a
 * vet that cannot see the whole contract cannot detect a duplicate of it. The
 * fixed truncation that blinded the old evaluator has no equivalent here.
 */
export async function vetCandidates(params: {
  drafts: LearningDraft[];
  /** The complete effective agent instructions. Never truncate before calling. */
  agentInstructions: string;
  /** Active rules already in force (for duplicate/contradiction checks). */
  activeRules: Learning[];
  /** Rendered trace of the run the candidates came from. Omit when re-vetting
   *  stored entries against a rewritten contract — grounding was already
   *  checked at capture, and the original trace is gone. */
  traceSummary?: string | undefined;
  /** Ids of drafts whose grounding must be checked against the trace. */
  groundedIds?: Set<string> | undefined;
  model: string;
}): Promise<Map<string, VetVerdict>> {
  const { drafts, agentInstructions, activeRules, traceSummary, groundedIds, model } = params;
  if (drafts.length === 0) return new Map();

  const { body, permanentText } = splitInstructions(agentInstructions);
  const contract = permanentText
    ? `${body.trim()}\n\n## Learned Guidelines (already permanent)\n${permanentText}`
    : body.trim();

  const rulesBlock = activeRules.length > 0
    ? `\n\n## Rules already in force (injected each run)\n${activeRules
        .map((l) => `- (id ${l.id}) ${l.title}: ${trunc(l.instruction, 300)}`)
        .join('\n')}`
    : '';

  const traceBlock = traceSummary
    ? `\n\n## What actually happened in the run these candidates came from\n${trunc(traceSummary, 12_000)}`
    : '';

  const grounded = groundedIds ?? new Set<string>();
  const candidatesBlock = drafts
    .map((d) => {
      const grounding = grounded.has(d.id) ? '' : ' (human-authored: never rule "ungrounded")';
      return `- (id ${d.id})${grounding} [${d.category}] ${d.title}: ${d.instruction}`;
    })
    .join('\n');

  const prompt = `You are vetting candidate rules before they are added to an AI agent's standing instructions. The agent's contract below is AUTHORITATIVE: a candidate that restates it adds cost without knowledge, and a candidate that contradicts it would leave the agent with no legal move.

## The agent's complete instructions (the contract)
${contract}${rulesBlock}${traceBlock}

## Candidate rules to vet
${candidatesBlock}

## Verdicts
For EACH candidate, exactly one verdict:
- "pass" — genuinely new, consistent with the contract and the rules in force${traceSummary ? ', and supported by what actually happened in the run' : ''}.
- "duplicate" — restates something the contract or a rule in force already says (same behaviour, any wording). In "detail", quote the sentence or rule it restates.
- "contradiction" — conflicts with the contract or a rule in force, or narrows it so far the two cannot both be satisfied. Two rules can collide while sharing no wording; check meaning, not vocabulary. In "detail", quote the conflicting text.
${traceSummary ? '- "ungrounded" — the run trace contradicts the claim, or does not contain the events the claim describes. Transient operational state and one-off tool defects are not durable policy. In "detail", say what the trace actually shows. Never use this verdict for a candidate marked human-authored.\n' : ''}
Be strict: a candidate must EARN "pass". When genuinely uncertain between "pass" and "duplicate", prefer "duplicate" — a lost restatement costs nothing.

Respond with ONLY a JSON array, one object per candidate:
[{"id": "<candidate id>", "verdict": "pass|duplicate|contradiction${traceSummary ? '|ungrounded' : ''}", "detail": "<required for every non-pass verdict: the quoted text or reason>"}]`;

  const system = helperSystemPrompt(
    model,
    'You vet candidate agent rules against the agent\'s authoritative instructions and reply with a JSON array of verdicts only.',
  );

  const responseText = await completeText(model, { ...system, prompt });

  let raw: RawVetVerdict[] = [];
  try {
    const text = responseText.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    raw = JSON.parse(jsonMatch[1] || text);
    if (!Array.isArray(raw)) raw = [];
  } catch {
    logger.debug(`[Learning] Vet returned unparseable verdicts: ${responseText.slice(0, 200)}`);
    return new Map();
  }

  const known = new Set(drafts.map((d) => d.id));
  const verdicts = new Map<string, VetVerdict>();
  for (const r of raw) {
    if (!r?.id || !known.has(r.id) || verdicts.has(r.id)) continue;
    const detail = typeof r.detail === 'string' && r.detail.trim() ? r.detail.trim() : '';
    switch (r.verdict) {
      case 'pass':
        verdicts.set(r.id, { verdict: 'pass' });
        break;
      case 'duplicate':
        verdicts.set(r.id, { verdict: 'duplicate', of: detail || 'an existing rule' });
        break;
      case 'contradiction':
        verdicts.set(r.id, { verdict: 'contradiction', conflict: detail || 'the agent contract' });
        break;
      case 'ungrounded':
        // A grounding verdict against a human-authored candidate is the model
        // overstepping its brief; treat it as no verdict so the channel's
        // fail-open default applies.
        if (grounded.has(r.id)) verdicts.set(r.id, { verdict: 'ungrounded', reason: detail || 'not supported by the session trace' });
        break;
    }
  }
  return verdicts;
}

/** Render a vet verdict as the stored quarantine reason. */
export function describeVetFailure(verdict: VetVerdict): string {
  switch (verdict.verdict) {
    case 'duplicate': return `duplicates the contract: ${verdict.of}`;
    case 'contradiction': return `contradicts the contract: ${verdict.conflict}`;
    case 'ungrounded': return `unsupported by the trace: ${verdict.reason}`;
    default: return '';
  }
}
