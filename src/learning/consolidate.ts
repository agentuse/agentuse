import { readFile, mkdir, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename, relative, isAbsolute } from 'path';
import { createHash } from 'crypto';
import { isDeepStrictEqual } from 'node:util';
import { completeText } from '../complete-text';
import { logger } from '../utils/logger';
import { unifiedDiff } from '../utils/diff';
import { getProjectDirSync } from '../storage/paths';
import { ANTHROPIC_IDENTITY_PROMPT, isAnthropicModel } from '../utils/anthropic';
import { LearningStore, withLearningFileLock } from './store';
import { activeLearnings, effectiveCap, rankLearnings } from './ranking';
import { LEARNED_BLOCK_END, LEARNED_BLOCK_START, agentFileIsWritable, parseLearnedBlock, spliceLearnedBlock } from './graduate';
import type { PermanentRule } from './graduate';
import type { Learning, LearningCategory, LearningConfig } from './types';
import { atomicWriteFile } from '../utils/atomic-write';

/**
 * The tidy-up pass: bring an agent's stored corrections back under the per-run
 * injection cap without losing anything.
 *
 * Four moves:
 * - MERGE near-duplicates into a single rule
 * - REWRITE a rule a human has repeated (a repeat means the wording is not
 *   landing, so restating it more sharply is the fix; retiring it is not)
 * - RETIRE what has been superseded (archived in the same file, never deleted)
 * - GRADUATE what has proven itself into the agent's own instructions, where it
 *   applies on every run and costs no cap slot
 *
 * Run in two passes, because the two halves of the job have opposite shapes.
 *
 * DECIDING what relates to what is expensive in REASONING and cheap in output:
 * a handful of ids. WRITING the merged rules is the reverse. Fused, as this
 * started out, every correction paid both costs at once and the batches ran
 * one after another: one real 43-correction file took 180s.
 *
 * Split, each half can be sized and scheduled for what it actually costs.
 * Decide calls stay small, because thinking cost climbs superlinearly with how
 * many things must be compared and falls off a cliff (see DECIDE_BATCH_SIZE);
 * write calls stay tiny, one group each. Both run concurrently, so the wall
 * time is the slowest single call rather than the sum of all of them.
 *
 * The model proposes; this module decides. Every constraint below is enforced in
 * code rather than asked for in the prompt, because this rewrites a user's agent
 * file and a persuasive-sounding JSON blob is not a good enough reason to.
 */

/** A correction younger than this has not had a fair chance to prove itself and
 *  is never retired, however stale the model judges it. */
const RETIRE_MIN_AGE_DAYS = 14;

/** Approved, uncommented runs a rule must survive before it may be considered
 *  permanent. Strong evidence, and rare: measured across a 22-agent fleet, not
 *  one rule of 750 had ever reached 1, because the counter only moves when a
 *  human approves a whole run without leaving a single comment — which never
 *  happens on an agent whose reviewer steers it. Kept as one route in, not the
 *  only one. */
const GRADUATE_MIN_APPROVED_RUNS = 3;

/** Runs a rule has been in force as the alternative route in.
 *
 * Under the injection cap a rule is only applied when it is inside the set, so
 * surviving N runs means N rounds of newer rules arriving and failing to
 * displace it. That is the cheapest honest evidence available, and unlike
 * {@link GRADUATE_MIN_APPROVED_RUNS} it is actually reachable. It is a floor for
 * being CONSIDERED, never a reason to promote on its own — the decide pass still
 * has to judge the rule against everything else, permanent rules included. */
const GRADUATE_MIN_APPLIED_RUNS = 10;

/**
 * Most recent snapshots kept per agent for undo.
 *
 * Raised from 5 when retirement became deletion. A retired rule used to linger
 * in the file as a ghost entry, so a bad merge noticed late was still readable
 * somewhere; now the snapshot is the only copy. Snapshots capture both files
 * byte-for-byte, which is a better record than the ghost ever was — there just
 * need to be enough of them that "I noticed six tidy-ups later" is still
 * recoverable. A snapshot is two text files; depth is cheap.
 */
const UNDO_HISTORY = 20;

/**
 * Output budget for a decide call.
 *
 * Generous relative to the ids-and-reasons it asks for, because on a reasoning
 * model the budget covers thinking too, and thinking is nearly all of it. Given
 * too many corrections at once a model will spend the ENTIRE allowance
 * reasoning and return zero text, `finishReason: max_tokens` with an empty
 * completion, which is indistinguishable from a dead model unless you are
 * counting chunk types. Raising this does not fix that; a smaller batch does.
 */
const DECIDE_MAX_OUTPUT_TOKENS = 8_000;

/** Output budget for writing one merged or sharpened rule. One rule of prose. */
const WRITE_MAX_OUTPUT_TOKENS = 2_000;

/**
 * Output budget for rewriting the permanent block.
 *
 * Generous because this call returns the entire block, not one rule: it must be
 * able to restate every rule it was given in full. Truncation here is not a
 * partial answer that degrades gracefully — a block cut off mid-rule fails the
 * coverage check and the whole rewrite is discarded, which is the safe outcome
 * but wastes the call. Measured against the largest real block in the fleet
 * (~15,000 characters), with room to grow.
 */
const BLOCK_MAX_OUTPUT_TOKENS = 32_000;

/**
 * Corrections weighed against each other in one decide call.
 *
 * Small because the cost of deciding is superlinear in how many things must be
 * compared, and it is spent on THINKING, not on output. Measured on one real
 * agent (Opus 5, ids-only output, 8k budget):
 *
 *   15 corrections -> 38s, a usable plan
 *   25 corrections -> 87s, a usable plan
 *   42 corrections -> 98s, ZERO text: the budget went entirely on reasoning
 *
 * So a wide decide call is not just slow, it falls off a cliff and returns
 * nothing. Batches run concurrently, so keeping them small costs tokens rather
 * than the user's time. Corrections in different batches are never compared,
 * which is what {@link orderForBatching} exists to mitigate.
 */
const DECIDE_BATCH_SIZE = 15;

/**
 * Model calls in flight at once.
 *
 * Bounded because a fleet-sized file would otherwise open thirty connections and
 * earn a rate limit, which costs far more time than the concurrency saved.
 */
const TIDY_CONCURRENCY = 6;

/**
 * Passes over the file one press will make.
 *
 * One pass is deliberately cautious — it merges only what it is sure about, and
 * it compares corrections in small groups (see {@link DECIDE_BATCH_SIZE}), so
 * two duplicates that never shared a group both survive it. On a big file that
 * left the user pressing the same button five times, with nothing on screen
 * saying how many more presses were coming or whether any of them would help.
 *
 * So a press keeps going by itself. Each round re-groups whatever is left, which
 * is exactly what pressing again used to do, and it all happens in memory: the
 * files are written once at the end, so one press is still one undo.
 *
 * Bounded, because rounds pay off less each time — by the fourth there is rarely
 * a duplicate left to find — and every round is about a minute of waiting.
 */
const MAX_ROUNDS = 5;

/** Where a running tidy-up has got to.
 *
 * Reported per unit of work rather than at the end, because the wait is the
 * whole problem this exists to solve: a pass over a large corrections file is
 * minutes of model work, and a button that just sits there looks broken long
 * before it is. */
export interface TidyProgress {
  phase: 'deciding' | 'writing' | 'applying' | 'done';
  /** Units of this phase finished. */
  step: number;
  /** Units in this phase; 0 when there is nothing to do in it. */
  total: number;
  /** Which pass over the file this is, counting from 1. */
  round: number;
  /** Most rounds this press can make. */
  maxRounds: number;
  /** Corrections that would still be active if the pass stopped here. */
  projectedActive: number;
  cap: number;
}

export interface ConsolidationChange {
  kind: 'merge' | 'rewrite' | 'retire' | 'graduate' | 'drop-permanent' | 'merge-permanent' | 'rewrite-permanent';
  /** Titles involved, for the human-readable summary. */
  titles: string[];
  why: string;
}

/**
 * Why the corrections still in force are still in force.
 *
 * Present only when a press ends above the cap, which is the moment the whole
 * feature looks broken: the user sees "42 → 30", a cap of 10, and no reason for
 * the gap. The rules that produced that gap already exist ({@link retireBlocked},
 * {@link isGraduationEligible}) — they were just never shown to anyone but the
 * model. Every remaining correction lands in exactly one bucket, so the counts
 * add up to the number on screen.
 *
 * Sentences rather than codes because both surfaces render this verbatim, and
 * the web bundle cannot import this module to phrase it itself.
 */
export interface TidyRemaining {
  /** Corrections still in force. */
  active: number;
  cap: number;
  /** True when the press stopped at its round limit rather than because nothing
   *  more could be done: pressing again really will get further. */
  moreToDo: boolean;
  /** One clause per group, rendered as "{count} {because}". */
  reasons: { count: number; because: string }[];
  /** What would let more of these become permanent. Absent when some already
   *  can, since then the wait is not what is holding the file up. */
  graduationWait?: string;
}

export interface ConsolidationResult {
  /** False when there was nothing over the cap to fix. */
  ran: boolean;
  model?: string;
  activeBefore: number;
  activeAfter: number;
  cap: number;
  /** Passes over the file this press made. */
  rounds: number;
  /** Why the file is still over the cap; absent when it reached it. */
  remaining?: TidyRemaining;
  changes: ConsolidationChange[];
  merged: number;
  rewritten: number;
  retired: number;
  /** Titles of the rules that are now permanent — named because this is the only
   *  part of a tidy-up that edits a file the user considers theirs. */
  graduated: string[];
  /** Permanent rules removed from the agent file, with why. Named individually
   *  for the same reason: this edits the human's own file, and dropping a rule
   *  they accepted is the one change here they are most likely to want to
   *  argue with. */
  droppedPermanent: { instruction: string; why: string }[];
  /** Why graduation was skipped, when it was. */
  graduationSkipped?: string;
  diffs: { learnings: string; agentFile?: string };
  /** Snapshot id for {@link undoConsolidation}; absent when nothing was written. */
  undoId?: string;
  /** Set when the pass was attempted but produced no usable plan. */
  note?: string;
}

/** What a decide call is allowed to say: ids and one-line reasons, never prose. */
interface RawDecisions {
  merge?: { ids?: string[]; keep?: string; why?: string }[];
  rewrite?: { id?: string; why?: string }[];
  retire?: { id?: string; why?: string }[];
  graduate?: { id?: string; why?: string }[];
}

/**
 * What the block pass returns: the permanent block, rewritten whole.
 *
 * Per-rule surgery could not do this job. The only move against the block used
 * to be "drop rule N", and on a real agent the model correctly declined to use
 * it even once — of twelve permanent rules none deserved deletion, but three
 * pairs said the same thing twice. Dropping either half of a pair loses a
 * constraint; the fix is to write the pair as one rule, which needs the whole
 * block on the table at once, not a delete key.
 */
interface RawBlockRewrite {
  rules?: { category?: string; instruction?: string; covers?: number[]; why?: string }[];
  dropped?: { index?: number; why?: string }[];
}

/** One rule of a proposed block, still carrying which originals it claims. */
interface ProposedRule extends PermanentRule {
  /** Indices into the block this replaces. */
  covers: number[];
  /** The one-line reason given for changing it, for the change list. */
  why?: string;
}

/** A structurally sound proposal, before anything has checked what it means. */
interface CheckedRewrite {
  rules: ProposedRule[];
  dropped: { instruction: string; why: string }[];
}

/** A block rewrite that has also been audited: the new set, what it removed,
 *  and what it changed. */
interface BlockRewrite {
  rules: PermanentRule[];
  dropped: { instruction: string; why: string }[];
  edited: ConsolidationChange[];
  /** Proposed edits kept out for losing an instruction, with what went missing.
   *  Diagnostic only — the rules they targeted are in `rules` unchanged. */
  refused: string[];
}

/** What a merge audit returns: the instructions it could not find. */
interface RawAudit {
  missing?: string[];
}

/** What a write call returns for one group. */
interface RawWrite {
  category?: string;
  title?: string;
  instruction?: string;
}

const CATEGORIES: LearningCategory[] = ['tip', 'warning', 'pattern', 'tool-usage', 'error-fix'];

function ageInDays(learning: Learning, now: number): number {
  const parsed = Date.parse(learning.extractedAt);
  if (Number.isNaN(parsed)) return Number.POSITIVE_INFINITY; // undated entries are old
  return (now - parsed) / 86_400_000;
}

/**
 * Whether a correction may be considered for a permanent place in the agent
 * file.
 *
 * Deliberately NOT a proof test any more, and deliberately not satisfied by who
 * wrote the rule. It used to return true for every `manual` entry, on the
 * reasoning that a human typing a rule is a human vouching for it. That reads
 * well and produced the exact failure it was meant to prevent: a human rule and
 * the later human rule correcting it were both auto-eligible, both promoted, and
 * ended up four lines apart in one agent's permanent instructions, with the
 * second announcing itself as a correction of the first.
 *
 * Who wrote a rule says how much it should weigh. It cannot say whether the rule
 * is still true, because the person who wrote it is also the person who later
 * changed their mind. Only comparing it against the rest of the set can say
 * that, so eligibility is now a floor — old enough to have been observed — and
 * the judgement of whether it belongs is made in the decide pass, against
 * everything else, including the rules already permanent.
 */
export function isGraduationEligible(learning: Learning): boolean {
  return learning.approvedRuns >= GRADUATE_MIN_APPROVED_RUNS
    || learning.reasserted > 0
    || learning.appliedCount >= GRADUATE_MIN_APPLIED_RUNS;
}

/**
 * Entries this pass is forbidden to retire, with the reason, for the prompt.
 *
 * `manual` is no longer among them. A rule a human wrote is strong evidence and
 * is weighted as such in the prompt, but a veto is not evidence — it is an
 * instruction to stop thinking, and it is what left one agent holding 85
 * corrections that could be neither applied nor consolidated. A newer correction
 * can only retire the older one it overrules if the older one is touchable.
 *
 * What remains is not about authorship: a rule a human has REPEATED is evidence
 * the wording is not landing (rewrite it, do not drop it), and a rule too young
 * to have been observed has not yet earned a verdict either way.
 */
function retireBlocked(learning: Learning, now: number): string | undefined {
  if (learning.reasserted > 0) return 'a human has repeated this; rewrite it instead';
  if (ageInDays(learning, now) < RETIRE_MIN_AGE_DAYS) return `less than ${RETIRE_MIN_AGE_DAYS} days old`;
  return undefined;
}

/** One correction as the decide pass sees it: the full text plus the evidence
 *  that decides what may be done to it. */
function inventoryEntry(learning: Learning, now: number): string {
  const weight = learning.source === 'manual'
    ? 'src:manual (a human wrote this one deliberately — weigh it heavily)'
    : learning.source === 'approval'
      ? 'src:approval (from a human reviewer comment — weigh it heavily)'
      : 'src:auto (the agent extracted this from its own run — weigh it lightly)';
  const flags: string[] = [weight];
  if (learning.reasserted > 0) flags.push(`repeated by a human ${learning.reasserted}x`);
  if (learning.approvedRuns > 0) flags.push(`in force across ${learning.approvedRuns} approved runs`);
  if (learning.appliedCount > 0) flags.push(`applied in ${learning.appliedCount} runs`);
  flags.push(`${Math.round(ageInDays(learning, now))}d old`);
  const blocked = retireBlocked(learning, now);
  if (blocked) flags.push(`CANNOT RETIRE: ${blocked}`);
  if (isGraduationEligible(learning)) flags.push('may be graduated');
  return `- id:${learning.id} [${learning.category}] ${learning.title} (${flags.join('; ')})\n  ${learning.instruction}`;
}

/** Content words of a correction, for the crude similarity below. Four letters
 *  and up, which drops the articles and prepositions without needing a stopword
 *  list to maintain. */
function contentWords(learning: Learning): Set<string> {
  return new Set(`${learning.title} ${learning.instruction}`.toLowerCase().match(/[a-z][a-z0-9_-]{3,}/g) ?? []);
}

/** How much of the smaller correction's vocabulary the larger one already
 *  carries. Containment rather than Jaccard: a short rule fully covered by a
 *  long one is exactly the pair worth putting in front of the same call, and
 *  Jaccard would score it low for being short. */
function overlap(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const word of a) if (b.has(word)) shared++;
  return shared / Math.min(a.size, b.size);
}

/**
 * Order corrections so similar ones end up in the same decide call.
 *
 * Batches have to be small (see {@link DECIDE_BATCH_SIZE}), and two duplicates
 * that land either side of a batch boundary are never compared, so they survive
 * the pass. Chaining each correction to its nearest unplaced neighbour costs
 * nothing (no model call, a few thousand set lookups) and it only decides who
 * shares a call — never what may be done to anything.
 */
export function orderForBatching(ranked: Learning[]): Learning[] {
  const words = new Map(ranked.map((l) => [l.id, contentWords(l)]));
  const remaining = ranked.slice(1);
  const ordered: Learning[] = [];
  let current = ranked[0];

  while (current) {
    ordered.push(current);
    if (remaining.length === 0) break;
    let bestIndex = 0;
    let bestScore = -1;
    for (let i = 0; i < remaining.length; i++) {
      const score = overlap(words.get(current.id)!, words.get(remaining[i]!.id)!);
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }
    current = remaining.splice(bestIndex, 1)[0];
  }
  return ordered;
}

/**
 * Pass one: which corrections relate to which.
 *
 * Asks for ids and one-line reasons ONLY. The replacement wording is written
 * later, one group per call, in parallel — see the module comment for why that
 * split is the difference between three minutes and under one.
 */
export function buildDecidePrompt(
  learnings: Learning[],
  agentInstructions: string,
  cap: number,
  now: number,
): string {
  const inventory = learnings.map((l) => inventoryEntry(l, now)).join('\n');

  // The already-permanent rules are pulled out and shown IN FULL, separately
  // from the truncated body.
  //
  // They live in a marked block that graduation appends to the END of the agent
  // file, and the body is cut at 6000 characters — so on any real agent the
  // block fell outside the cut and the model never saw it. Measured on a
  // 56k-character agent file: the block started at character 30,685. Every
  // instruction telling this pass to check a candidate against the rules already
  // permanent was unfollowable, which is exactly how a rule and the later
  // correction overruling it both ended up in that block.
  const blockStart = agentInstructions.indexOf(LEARNED_BLOCK_START);
  const blockEnd = agentInstructions.indexOf(LEARNED_BLOCK_END);
  const hasBlock = blockStart !== -1 && blockEnd > blockStart;
  // Truncate the BODY only, with the block excised so it cannot be cut in half.
  const body = hasBlock
    ? `${agentInstructions.slice(0, blockStart)}${agentInstructions.slice(blockEnd + LEARNED_BLOCK_END.length)}`
    : agentInstructions;

  // Shown but not addressable. This pass decides what happens to STAGED
  // corrections; the block itself is rewritten whole by a later pass, so giving
  // these ids here would only invite a move this pass cannot make.
  //
  // They still have to be visible: a rule the block already states must not be
  // graduated a second time, and that check is impossible without the text.
  const permanentRules = parseLearnedBlock(agentInstructions);
  const permanentSection = permanentRules.length > 0
    ? `

## Rules already PERMANENT in this agent (part of the same ruleset)
Graduated by an earlier pass. They apply on EVERY run and cost no slot, so they are the most expensive rules here to get wrong.
${permanentRules.map((r) => `- [${r.category}] ${r.instruction}`).join('\n')}`
    : '';

  return `An agent has accumulated ${learnings.length} stored corrections, but only the top ${cap} are put in front of the model on any run. The rest have no effect. Your job is to decide how to get the active set to ${cap} or fewer without losing anything the agent needs.

## The agent's own instructions
${body.slice(0, 6000)}${permanentSection}

## Stored corrections
${inventory}

## Moves available

1. **merge** — two or more corrections saying substantially the same thing become one. Name the ids and which one to keep; someone else writes the merged wording.
2. **rewrite** — a correction a human has REPEATED is not wrong, it is not landing. Name it and it will be restated more sharply. Prefer this over retiring anything marked as repeated.
3. **retire** — a correction that another one now fully covers, or that the agent's own instructions above already state. Only entries with no "CANNOT RETIRE" flag.
4. **graduate** — a correction moves into the agent's permanent instructions above, where it applies on every run and never competes for a slot. Only entries marked "may be graduated", and only after step 1 below.

The permanent rules above are not yours to edit in this pass — a later pass rewrites that block as a whole. Read them, and never graduate something they already cover.

## How to decide, in order

1. **Reconcile before you promote anything.** Read the whole list, plus the agent's own instructions above, as ONE ruleset the agent has to obey all at once. Look for pairs that say the same thing, and for pairs that CONTRADICT — where a later correction overrules an earlier one, or narrows it so far they cannot both be followed. Contradictions are the most important thing on this page and the easiest to miss, because two rules can collide while sharing no wording at all. Resolve those first, by merging them or by retiring the one that was overruled.
2. **Only then graduate.** A rule earns permanence AFTER it has been checked against everything else, not instead of being checked. Never graduate a rule that another correction in this list overrules, and never graduate one that restates or contradicts something already in the agent's instructions above — that block is part of the ruleset, and a second permanent copy of a rule you cannot later reconcile is the worst outcome available here.

## Rules
- Every id you name must come from the list. Each id may appear in AT MOST ONE move.
- **Who wrote a rule is evidence, not a verdict.** A rule marked src:manual or src:approval came from a human and should weigh heavily — but the same human wrote the correction that may now overrule it, so authorship cannot decide whether a rule is still true. Judge each one on whether it still earns a place: is it current, is it covered by another, has it been superseded? A newer human correction retiring an older human rule is exactly the right outcome, not something to avoid.
- Merge two corrections whenever both can be stated as one rule, even when they constrain different situations. Merging is not discarding: the merged wording must carry every case the originals covered, and whoever writes it sees all of them. Leaving a pair alone is right only when no single rule can hold both without losing a constraint — a judgement about the wording, not about whether the subjects match.
- This set is over its limit, so some of these corrections do not reach the agent at all. Leaving a pair alone is not the safe choice; it is a choice to leave something dormant.
- Do NOT write any replacement text. Ids and a one-line reason each, nothing more.
- If nothing can be safely improved, return empty arrays.

Respond with ONLY a JSON object, no other text:
{
  "merge":    [{"ids": ["ab12cd34", "ef56gh78"], "keep": "ab12cd34", "why": "one line"}],
  "rewrite":  [{"id": "ij90kl12", "why": "reviewer repeated this 3 times; sharpen it"}],
  "retire":   [{"id": "mn34op56", "why": "superseded by ab12cd34"}],
  "graduate": [{"id": "qr78st90", "why": "in force across 12 approved runs"}]
}`;
}

/** Pass two, merge: the group's full text in, one correction out. */
export function buildMergePrompt(group: Learning[]): string {
  const parts = group.map((l) => `- id:${l.id} [${l.category}] ${l.title}\n  ${l.instruction}`).join('\n');
  return `These stored corrections for an agent say substantially the same thing:

${parts}

Write ONE correction that replaces them. It must cover everything all of them covered — do not just pick the best one and drop the rest, and do not invent guidance none of them gave.

Respond with ONLY a JSON object, no other text:
{"category": "tip|warning|pattern|tool-usage|error-fix", "title": "short title", "instruction": "the merged instruction"}`;
}

/** Pass two, rewrite: one repeated correction in, a sharper one out. */
export function buildRewritePrompt(learning: Learning, why: string): string {
  return `A human has repeated this correction to an agent, which means the wording is not landing:

- [${learning.category}] ${learning.title}
  ${learning.instruction}

Reason it was flagged: ${why}

Restate it more concretely and more specifically, so the agent cannot follow it and still make the mistake. Keep it to the same rule — do not broaden it or add guidance it did not carry.

Respond with ONLY a JSON object, no other text:
{"title": "short title", "instruction": "the sharper instruction"}`;
}

/**
 * Pass three, the block: every permanent rule in, the whole block back out.
 *
 * This is the only pass that reads the agent's permanent rules as a single
 * document rather than a list of independent items, and it is the only thing
 * that ever makes that block smaller. Whole-document is the point. On a real
 * agent the twelve permanent rules held three separate redundancies that no
 * per-rule move could resolve: gate handling split across two rules that each
 * cross-referenced the other for its missing half, a definition and the
 * correction to that definition sitting side by side, and "write simpler"
 * stated three times. Every one of those is a rewrite, not a deletion.
 *
 * Newly graduated rules are folded in here too, so a promotion lands wherever
 * it belongs in the ruleset instead of being appended to the end.
 */
export function buildBlockRewritePrompt(rules: PermanentRule[], freshCount: number): string {
  const listed = rules.map((r, i) => `${i}. [${r.category}] ${r.instruction}`).join('\n\n');
  const fresh = freshCount > 0
    ? `\n\nThe last ${freshCount} ${freshCount === 1 ? 'rule was' : 'rules were'} just promoted into this set and have never been edited alongside the others. They are the most likely to duplicate something already here.`
    : '';

  return `Below are the permanent rules in one agent's instruction file. They apply on EVERY run of this agent. Rewrite them as one coherent set.${fresh}

## The rules
${listed}

## What to change

Combine, tighten, and reorder freely. Specifically look for:
- **Two rules that are halves of one procedure** — especially a pair that reference each other ("see the rule about X", "otherwise use the handling below"). A reader has to hold both to act on either. Make them one.
- **A rule and the correction to that rule** — where a later rule redefines a term or overrules a case in an earlier one. The correction belongs inside the rule it corrects, not beside it.
- **The same instruction stated more than once** in different words or different scopes.
- **Leftovers from staging** — phrases like "CORRECTION of an auto-learning from this session", "on the 2026-07-14 run", or an id like "id:a37rttpa". These made sense while the rule was a pending correction. In a permanent rule they are noise: state the rule, keep the concrete evidence that makes it credible, drop the bookkeeping.

## Be concise, but lose nothing

Aim for the shortest text that still tells the agent every single thing its sources told it. Those are two demands at once and both are real:

- **Cut words freely.** Repetition, throat-clearing, the same point made twice in different sentences, narration of how the rule came to exist. A merged rule that is half the length of its sources is a good outcome when the removed words were not carrying an instruction.
- **Cut instructions never.** Every case, exception, threshold, trigger, named failure and worked example is load-bearing. A 24h cutoff, a reviewer's verbatim complaint, "do X but NOT when Y" — those are the rule. Drop one and the agent behaves differently, which is the whole cost of getting this wrong.

The failure to avoid is writing the topic instead of the instruction. "Keep the two senses of 'connect' apart" names a subject; it does not tell anyone what either sense is or what to do about them, so it replaces a rule with a label. If your merged text would leave a reader asking "yes, but what do I actually do?", it is too short — not because of its length, but because an instruction went missing.

Each merged rule is checked against its sources afterwards, instruction by instruction. Anything found missing puts the originals back unchanged, so a merge that quietly drops a case buys nothing.

Two more:
- Do not add guidance none of the sources gave.
- Leave a rule exactly as written when nothing above applies to it. Rewording a rule that is already fine is churn in a human's own file. Most rules in a healthy set should come back untouched.

## How to answer

Return the complete new set. Every input rule must be accounted for exactly once, either inside some output rule's "covers" or in "dropped":
- "covers" lists the input numbers a rule now carries. One number and identical text means untouched — omit "why". Any other case needs a one-line "why".
- "dropped" is only for a rule with nothing left to carry, because another rule fully states it. Losing content is a bug; if in doubt, carry it.

Respond with ONLY a JSON object, no other text:
{
  "rules": [
    {"category": "pattern", "instruction": "full text of the rule", "covers": [0]},
    {"category": "warning", "instruction": "full text of the combined rule", "covers": [3, 4], "why": "two halves of one gate procedure"}
  ],
  "dropped": [{"index": 7, "why": "rule covering 3 and 4 now states this outright"}]
}`;
}

/**
 * Pass three, the audit: one rewritten rule against the originals it claims.
 *
 * Asked separately, and asked backwards. The pass that wrote the rule cannot
 * be trusted to mark its own work — it has just argued to itself that the merge
 * was sound — so this call sees only the sources and the result, is never told
 * the reasoning, and is asked what is MISSING rather than whether the merge is
 * good. "Is this faithful?" collects yes; "what did it drop?" collects a list.
 *
 * The question is about instructions, not text. A merge that halves the wording
 * while keeping every case should pass; one that keeps the length but silently
 * drops an exception should fail. Length was the previous test here and it got
 * both of those backwards — it blocked real compression and would have waved
 * through any padded rewrite.
 */
export function buildMergeAuditPrompt(sources: PermanentRule[], merged: string): string {
  const listed = sources.map((s, i) => `SOURCE ${i + 1}:\n${s.instruction}`).join('\n\n');
  return `An agent's rules were rewritten. Your only job is to find what the rewrite lost.

${listed}

REWRITTEN:
${merged}

Go through the sources one instruction at a time. An instruction is anything that would change what the agent does: a rule, a case, an exception, a threshold or number, a trigger condition, a named failure to avoid, a required output, a worked example that shows what the rule means in practice.

For each one, decide whether the rewritten text still tells the agent that same thing. Different wording is fine — shorter is fine — as long as an agent following only the rewritten text would behave the same way.

List every instruction you cannot find. Be specific: name the instruction, not the topic. Report it as missing when the rewrite mentions the subject but no longer says what to do about it, when it generalises a specific threshold or example into a vague principle, or when it keeps one side of a "do X but not when Y" and drops the other.

Do not list wording changes, reordering, removed repetition, or removed narration about how the rule came to exist. Those are the point of the rewrite. Only list things an agent would now get wrong.

If nothing is missing, return an empty list. Empty is a real answer — say so when the rewrite genuinely carries everything.

Respond with ONLY a JSON object, no other text:
{"missing": ["the 24h cutoff that decides abandoned vs live", "what to do when the reviewer leaves no comment"]}`;
}

/**
 * Check the SHAPE of a proposed block against the one it replaces.
 *
 * Coverage only: every rule that went in comes out inside something, or is
 * named as dropped with a reason. A model rewriting twelve rules into eleven
 * while quietly forgetting the twelfth is the one failure that would be
 * invisible in review — the block reads perfectly well, and the missing rule
 * surfaces only the next time the agent makes the mistake it used to prevent.
 * An unaccounted input rejects the whole rewrite rather than the offending
 * rule, because a partial rewrite of a set reorganised as a whole is not
 * something to salvage.
 *
 * Whether the surviving text still SAYS what its sources said is a different
 * question, and not one any property of a string can answer. {@link auditEdits}
 * asks it directly.
 */
export function validateBlockRewrite(
  raw: RawBlockRewrite,
  before: PermanentRule[],
): CheckedRewrite | { rejected: string } {
  const proposed = Array.isArray(raw.rules) ? raw.rules : [];
  if (proposed.length === 0) return { rejected: 'returned no rules' };

  const claimed = new Map<number, string>();
  const rules: ProposedRule[] = [];

  for (const r of proposed) {
    const instruction = typeof r.instruction === 'string' ? r.instruction.trim() : '';
    if (!instruction) return { rejected: 'a rule came back with no text' };
    const category = CATEGORIES.includes(r.category as LearningCategory)
      ? (r.category as LearningCategory)
      : 'pattern';
    const covers = Array.isArray(r.covers) ? r.covers.filter((i) => Number.isInteger(i)) : [];
    if (covers.length === 0) return { rejected: `a rule claims to cover nothing: "${instruction.slice(0, 60)}"` };

    for (const index of covers) {
      if (index < 0 || index >= before.length) return { rejected: `rule ${index} does not exist` };
      const owner = claimed.get(index);
      if (owner !== undefined) return { rejected: `rule ${index} is claimed twice` };
      claimed.set(index, instruction);
    }

    // Structure only. Whether the text still SAYS everything its sources said
    // is a question about meaning, and no property of this string answers it —
    // see auditEdits, which asks about the instructions rather than the prose.
    rules.push({ category, instruction, covers, ...(r.why ? { why: r.why } : {}) });
  }

  const dropped: { instruction: string; why: string }[] = [];
  for (const d of raw.dropped ?? []) {
    const index = d.index;
    if (!Number.isInteger(index) || index! < 0 || index! >= before.length) {
      return { rejected: `dropped rule ${d.index} does not exist` };
    }
    if (claimed.has(index!)) return { rejected: `rule ${index} is both kept and dropped` };
    claimed.set(index!, '');
    dropped.push({ instruction: before[index!]!.instruction, why: d.why?.trim() || 'covered by another rule' });
  }

  const missing = before.map((_, i) => i).filter((i) => !claimed.has(i));
  if (missing.length > 0) {
    return { rejected: `rule${missing.length === 1 ? '' : 's'} ${missing.join(', ')} vanished — neither kept nor dropped` };
  }

  return { rules, dropped };
}

/**
 * Read a JSON object out of a model response.
 *
 * Tries the response as-is, then a fenced code block, then the outermost
 * `{...}` span. The last fallback matters in practice: models routinely preface
 * a JSON answer with a sentence of explanation however firmly the prompt asks
 * them not to, and throwing away an otherwise perfect answer over a leading
 * "Here's the consolidation:" would make the whole feature look broken.
 */
function parseJsonObject<T>(responseText: string): T | null {
  const text = responseText.trim();
  if (!text) return null;

  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/)?.[1];
  const firstBrace = text.indexOf('{');
  const lastBrace = text.lastIndexOf('}');
  const braced = firstBrace >= 0 && lastBrace > firstBrace ? text.slice(firstBrace, lastBrace + 1) : undefined;

  for (const candidate of [text, fenced, braced]) {
    if (!candidate) continue;
    try {
      const parsed = JSON.parse(candidate);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as T;
    } catch {
      // try the next shape
    }
  }
  return null;
}

/** A plan of ids, before any replacement text exists. */
interface DecidedPlan {
  merges: { keep: Learning; absorbed: Learning[]; why: string }[];
  rewrites: { target: Learning; why: string }[];
  retires: { target: Learning; why: string }[];
  graduates: { target: Learning; why: string }[];
  rejected: string[];
}

/**
 * Apply every guardrail to a proposed set of decisions.
 *
 * Rejections are collected rather than thrown: one bad entry in an otherwise
 * good plan should cost that entry, not the whole tidy-up. They are logged at
 * debug so a model that keeps proposing forbidden moves is diagnosable.
 */
export function validateDecisions(
  raw: RawDecisions,
  learnings: Learning[],
  now: number,
): DecidedPlan {
  const byId = new Map(learnings.map((l) => [l.id, l]));
  const claimed = new Set<string>();
  const out: DecidedPlan = { merges: [], rewrites: [], retires: [], graduates: [], rejected: [] };

  const claim = (id: string | undefined, label: string): Learning | undefined => {
    if (!id) {
      out.rejected.push(`${label}: missing id`);
      return undefined;
    }
    const learning = byId.get(id);
    if (!learning) {
      out.rejected.push(`${label}: unknown id ${id}`);
      return undefined;
    }
    if (claimed.has(id)) {
      out.rejected.push(`${label}: id ${id} already used by another move`);
      return undefined;
    }
    return learning;
  };

  for (const m of raw.merge ?? []) {
    const ids = Array.isArray(m.ids) ? m.ids : [];
    if (ids.length < 2) {
      out.rejected.push('merge: needs at least two ids');
      continue;
    }
    const group = ids.map((id) => claim(id, 'merge'));
    if (group.some((l) => !l)) continue;
    const members = group as Learning[];
    const keep = members.find((l) => l.id === m.keep) ?? members[0]!;
    for (const l of members) claimed.add(l.id);
    out.merges.push({
      keep,
      absorbed: members.filter((l) => l.id !== keep.id),
      why: m.why ?? 'merged near-duplicates',
    });
  }

  for (const r of raw.rewrite ?? []) {
    const target = claim(r.id, 'rewrite');
    if (!target) continue;
    claimed.add(target.id);
    out.rewrites.push({ target, why: r.why ?? 'sharpened a repeated correction' });
  }

  for (const r of raw.retire ?? []) {
    const target = claim(r.id, 'retire');
    if (!target) continue;
    const blocked = retireBlocked(target, now);
    if (blocked) {
      out.rejected.push(`retire ${target.id}: ${blocked}`);
      continue;
    }
    claimed.add(target.id);
    out.retires.push({ target, why: r.why ?? 'superseded' });
  }

  for (const g of raw.graduate ?? []) {
    const target = claim(g.id, 'graduate');
    if (!target) continue;
    if (!isGraduationEligible(target)) {
      out.rejected.push(
        `graduate ${target.id}: not observed enough yet `
        + `(${target.approvedRuns} approved runs, needs ${GRADUATE_MIN_APPROVED_RUNS}; `
        + `or ${target.appliedCount} runs in force, needs ${GRADUATE_MIN_APPLIED_RUNS})`
      );
      continue;
    }
    claimed.add(target.id);
    out.graduates.push({ target, why: g.why ?? 'held up across runs' });
  }

  return out;
}

/**
 * Run `worker` over `items` with at most `limit` in flight, preserving order.
 *
 * The whole point of the two-pass split: eleven merges written concurrently cost
 * the slowest single merge, not the sum of eleven. A rejected item resolves to
 * `null` so one failure costs its own group and nothing else.
 */
async function mapConcurrent<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<(R | null)[]> {
  const results: (R | null)[] = new Array(items.length).fill(null);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      try {
        results[index] = await worker(items[index]!, index);
      } catch (err) {
        logger.debug(`[Learning] Tidy-up item ${index} failed: ${(err as Error).message}`);
        results[index] = null;
      }
    }
  });
  await Promise.all(runners);
  return results;
}

/** Snapshot both files before writing, so undo can restore the exact prior bytes.
 *  Half a tidy-up lands in a file the user owns; an undo that only rolled back
 *  the store would leave the agent file quietly rewritten. */
interface Snapshot {
  id: string;
  files: { path: string; content: string }[];
}

/**
 * Undo history lives per agent FILE, not per file name.
 *
 * The hash is load-bearing: `agents/blog/write.agentuse` and
 * `agents/x/write.agentuse` share a basename, and a shared directory would let
 * `undo` on one restore the other's snapshot — writing agent B's old content
 * back over agent B while the user was undoing agent A.
 *
 * Kept in the per-project state directory, beside the corrections file the
 * snapshots roll back and the session logs, rather than in the user's repo: a
 * snapshot is generated state with a bounded life, and `{stateRoot}/.agentuse/`
 * put a `?? .agentuse/consolidations/` in `git status` after every tidy-up.
 * Nothing migrates the old location — history is pruned to {@link UNDO_HISTORY}
 * anyway, and an absent snapshot already reports as "nothing to undo".
 */
function snapshotDir(stateRoot: string, agentFilePath: string): string {
  const digest = createHash('sha256').update(agentFilePath).digest('hex').slice(0, 8);
  const label = basename(agentFilePath).replace(/[^\w.-]/g, '_');
  return join(getProjectDirSync(stateRoot), 'consolidations', `${label}-${digest}`);
}

/** The one file in the snapshot directory that is NOT a snapshot; excluded
 *  everywhere the snapshots are listed, or undo would try to restore it and the
 *  retention sweep would delete it. */
const RECORD_FILE = 'last-tidy.json';

async function listSnapshots(dir: string): Promise<string[]> {
  return (await readdir(dir)).filter((f) => f.endsWith('.json') && f !== RECORD_FILE).sort();
}

async function writeSnapshot(stateRoot: string, agentFilePath: string, snapshot: Snapshot): Promise<void> {
  const dir = snapshotDir(stateRoot, agentFilePath);
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(join(dir, `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2));

  const entries = await listSnapshots(dir);
  for (const stale of entries.slice(0, Math.max(0, entries.length - UNDO_HISTORY))) {
    await unlink(join(dir, stale)).catch(() => {});
  }
}

/**
 * The last tidy-up this agent had, kept on disk beside its undo snapshot.
 *
 * A tidy-up rewrites two files and the only way back is Undo, so the result has
 * to outlive the browser tab that started it. Held in memory alone, closing the
 * tab or restarting the daemon would leave a user who wanted to undo with a
 * changed agent file and no idea what changed.
 */
export interface TidyRecord {
  jobId: string;
  agentFilePath: string;
  startedAt: number;
  finishedAt: number;
  result: ConsolidationResult;
}

/**
 * Apply a tidy plan to the latest file without erasing work that landed while
 * the model was thinking.
 *
 * New and independently-changed entries are preserved. If both the tidy pass
 * and another writer changed the same entry, neither version is silently
 * chosen: the pass aborts and can be retried against the new source of truth.
 */
export function reconcileConcurrentLearnings(
  original: Learning[],
  proposed: Learning[],
  latest: Learning[],
): Learning[] {
  const originalById = new Map(original.map((learning) => [learning.id, learning]));
  const proposedById = new Map(proposed.map((learning) => [learning.id, learning]));
  const latestById = new Map(latest.map((learning) => [learning.id, learning]));
  const reconciled: Learning[] = [];
  const conflicts: string[] = [];

  for (const current of latest) {
    const before = originalById.get(current.id);
    if (!before) {
      reconciled.push(current); // captured after tidy started
      continue;
    }

    const planned = proposedById.get(current.id);
    if (!planned) {
      if (!isDeepStrictEqual(current, before)) conflicts.push(current.id);
      // A proposal may remove an entry in a future tidy implementation.
      continue;
    }

    const currentChanged = !isDeepStrictEqual(current, before);
    const plannedChanged = !isDeepStrictEqual(planned, before);
    if (currentChanged && plannedChanged && !isDeepStrictEqual(current, planned)) {
      conflicts.push(current.id);
      continue;
    }
    reconciled.push(plannedChanged ? planned : current);
  }

  // A concurrent deletion wins over the stale tidy proposal. Proposed entries
  // that genuinely did not exist at planning time are still retained.
  for (const planned of proposed) {
    if (!originalById.has(planned.id) && !latestById.has(planned.id)) reconciled.push(planned);
  }

  if (conflicts.length > 0) {
    throw new Error(
      `Learnings changed while tidy-up was running (conflicting ids: ${conflicts.join(', ')}). `
      + 'Nothing was overwritten; run tidy-up again.'
    );
  }
  return reconciled;
}

export async function writeTidyRecord(stateRoot: string, agentFilePath: string, record: TidyRecord): Promise<void> {
  const dir = snapshotDir(stateRoot, agentFilePath);
  await mkdir(dir, { recursive: true });
  await atomicWriteFile(join(dir, RECORD_FILE), JSON.stringify(record, null, 2));
}

export async function readTidyRecord(stateRoot: string, agentFilePath: string): Promise<TidyRecord | null> {
  const path = join(snapshotDir(stateRoot, agentFilePath), RECORD_FILE);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(await readFile(path, 'utf-8')) as TidyRecord;
  } catch {
    return null; // a truncated record is not worth failing a page load over
  }
}

/** Drop the record once its change has been undone: there is nothing left to
 *  offer an undo for. */
export async function clearTidyRecord(stateRoot: string, agentFilePath: string): Promise<void> {
  await unlink(join(snapshotDir(stateRoot, agentFilePath), RECORD_FILE)).catch(() => {});
}

/** Restore the most recent tidy-up. Returns the files it put back. */
export async function undoConsolidation(
  stateRoot: string,
  agentFilePath: string,
): Promise<{ restored: string[] } | null> {
  const dir = snapshotDir(stateRoot, agentFilePath);
  if (!existsSync(dir)) return null;
  const entries = await listSnapshots(dir);
  const latest = entries[entries.length - 1];
  if (!latest) return null;

  const snapshot: Snapshot = JSON.parse(await readFile(join(dir, latest), 'utf-8'));
  const learningPath = snapshot.files[0]?.path;
  const restore = async () => {
    for (const file of snapshot.files) {
      await mkdir(dirname(file.path), { recursive: true });
      await atomicWriteFile(file.path, file.content);
    }
    // Keep the snapshot until every destination has been durably replaced. A
    // failed partial restore can then be retried instead of becoming permanent.
    await unlink(join(dir, latest)).catch(() => {});
  };
  if (learningPath) await withLearningFileLock(learningPath, restore);
  else await restore();
  return { restored: snapshot.files.map((f) => f.path) };
}

/**
 * Account for every correction a press left in force.
 *
 * The order of the checks is the order of the guardrails in
 * {@link retireBlocked}, so the bucket a correction lands in is the FIRST reason
 * it could not be retired rather than an arbitrary one of several.
 */
export function explainRemaining(
  active: Learning[],
  cap: number,
  now: number,
  moreToDo: boolean,
): TidyRemaining {
  let repeated = 0;
  let tooNew = 0;
  let distinct = 0;
  let eligible = 0;
  let closest = 0;

  for (const learning of active) {
    if (isGraduationEligible(learning)) eligible++;
    else closest = Math.max(closest, learning.appliedCount);

    // First reason wins, so order is the claim. Authorship is no longer among
    // them: a rule a human wrote is weighed heavily but can be retired by a
    // later human correction, so "you wrote it" no longer explains why anything
    // stayed.
    if (learning.reasserted > 0) repeated++;
    else if (ageInDays(learning, now) < RETIRE_MIN_AGE_DAYS) tooNew++;
    else distinct++;
  }

  const reasons: TidyRemaining['reasons'] = [];
  if (distinct > 0) reasons.push({ count: distinct, because: 'say different things, so there is nothing left to merge them into' });
  if (tooNew > 0) {
    reasons.push({
      count: tooNew,
      because: `are less than ${RETIRE_MIN_AGE_DAYS} days old, and a new learning gets that long to prove itself before it can be retired`,
    });
  }
  if (repeated > 0) reasons.push({ count: repeated, because: 'you have corrected more than once, so they get sharpened rather than dropped' });

  // The question this answers is the one users actually ask: not "why is it
  // still 30" but "why did nothing become permanent". Naming the best score so
  // far turns a rule into a distance.
  //
  // Scoped to the corrections still ACTIVE after the pass, which is what makes
  // it truthful: it used to read "None of these can move into the agent file
  // yet" on a run that had just made six rules permanent, because every manual
  // rule was auto-eligible and this line only counted the ones left behind.
  const graduationWait = eligible > 0
    ? undefined
    : `None of the corrections still in force can move into the agent file yet. That takes ${GRADUATE_MIN_APPROVED_RUNS} runs approved without a comment, or ${GRADUATE_MIN_APPLIED_RUNS} runs in force; the closest of them has been applied in ${closest}. They become eligible on their own as the agent keeps running.`;

  return {
    active: active.length,
    cap,
    moreToDo,
    reasons,
    ...(graduationWait ? { graduationWait } : {}),
  };
}

export interface ConsolidateOptions {
  agentFilePath: string;
  agentInstructions: string;
  agentModel: string;
  config?: LearningConfig | undefined;
  stateRoot: string;
  /** Compute the plan and the diffs, write nothing. */
  dryRun?: boolean;
  /** One-off model override, ahead of `learning.model` and the agent's model. */
  model?: string | undefined;
  /** Timestamp for age checks; injected so tests are not clock-dependent. */
  now?: number;
  /** Called as each batch starts and again before the files are written. */
  onProgress?: (progress: TidyProgress) => void;
}

/** Everything a round needs that does not change between rounds. */
interface RoundContext {
  model: string;
  instructions: string;
  agentInstructions: string;
  cap: number;
  now: number;
  nowIso: string;
  /** When true a round still plans graduations but applies none, so the press
   *  reports the reason once instead of once per round. */
  graduationBlocked: boolean;
  report: (phase: TidyProgress['phase'], step: number, total: number, projectedActive: number) => void;
}

/** What one pass over the active set achieved. */
interface RoundOutcome {
  /** The whole store state after the round, retired and graduated included. */
  next: Learning[];
  changes: ConsolidationChange[];
  merged: number;
  rewritten: number;
  retired: number;
  graduated: Learning[];
  /** Graduations the model asked for, applied or not, so a press can tell
   *  whether a graduation block actually cost anything. */
  graduatesProposed: number;
  batches: number;
  failedBatches: number;
  /** Ids of the rules whose wording could not be written. Ids rather than a
   *  count because a later round retries the same group, and summing attempts
   *  would report two broken rules where there is one. */
  failedWrites: string[];
  /** The start of an unreadable response, for the failure message. */
  sample: string;
}

/**
 * One pass: decide in small concurrent groups, write the wording in small
 * concurrent calls, apply the result to a copy of the store.
 *
 * Touches no files. A press runs several of these and writes once at the end,
 * so a round that goes wrong costs its own round and nothing on disk.
 */
async function tidyRound(current: Learning[], active: Learning[], ctx: RoundContext): Promise<RoundOutcome> {
  const nothing: RoundOutcome = {
    next: current,
    changes: [],
    merged: 0,
    rewritten: 0,
    retired: 0,
    graduated: [],
    graduatesProposed: 0,
    batches: 0,
    failedBatches: 0,
    failedWrites: [],
    sample: '',
  };

  // PASS ONE: decide. Every active correction in, ids out.
  //
  // Batched only to bound how much cross-comparison one call holds in mind; the
  // batches run concurrently, so a bigger file costs tokens rather than time.
  const ordered = orderForBatching(rankLearnings(active));
  const batches: Learning[][] = [];
  for (let i = 0; i < ordered.length; i += DECIDE_BATCH_SIZE) {
    batches.push(ordered.slice(i, i + DECIDE_BATCH_SIZE));
  }

  let projectedActive = active.length;
  let decided = 0;

  ctx.report('deciding', 0, batches.length, projectedActive);
  const decisions = await mapConcurrent(batches, TIDY_CONCURRENCY, async (batch) => {
    const responseText = await completeText(ctx.model, {
      instructions: ctx.instructions,
      prompt: buildDecidePrompt(batch, ctx.agentInstructions, ctx.cap, ctx.now),
      maxOutputTokens: DECIDE_MAX_OUTPUT_TOKENS,
    });
    ctx.report('deciding', ++decided, batches.length, projectedActive);
    const raw = parseJsonObject<RawDecisions>(responseText);
    if (!raw) {
      logger.debug(`[Learning] Tidy-up decide call returned unusable JSON: ${responseText.slice(0, 500)}`);
      return { plan: null, sample: responseText.trim().slice(0, 120).replace(/\s+/g, ' ') };
    }
    return { plan: validateDecisions(raw, batch, ctx.now), sample: '' };
  });

  const plan: DecidedPlan = { merges: [], rewrites: [], retires: [], graduates: [], rejected: [] };
  let failedBatches = 0;
  let sample = '';
  for (const outcome of decisions) {
    // A batch that threw (rate limit, network) counts the same as one that came
    // back unreadable: it contributes nothing and costs only itself.
    if (!outcome || !outcome.plan) {
      failedBatches++;
      if (outcome?.sample) sample = outcome.sample;
      continue;
    }
    plan.merges.push(...outcome.plan.merges);
    plan.rewrites.push(...outcome.plan.rewrites);
    plan.retires.push(...outcome.plan.retires);
    plan.graduates.push(...outcome.plan.graduates);
    plan.rejected.push(...outcome.plan.rejected);
  }

  for (const rejection of plan.rejected) logger.debug(`[Learning] Tidy-up rejected ${rejection}`);
  if (failedBatches === batches.length) {
    return { ...nothing, batches: batches.length, failedBatches, sample };
  }

  projectedActive -= plan.retires.length
    + plan.graduates.length
    + plan.merges.reduce((n, m) => n + m.absorbed.length, 0);

  // PASS TWO: write. One small call per merge or rewrite, all at once.
  //
  // This is where the time used to go, serially, inside the same call that did
  // the deciding. Retirements and graduations need no wording at all and no
  // longer wait behind text they never had a use for.
  type WriteJob =
    | { kind: 'merge'; merge: DecidedPlan['merges'][number] }
    | { kind: 'rewrite'; rewrite: DecidedPlan['rewrites'][number] };
  const jobs: WriteJob[] = [
    ...plan.merges.map((merge): WriteJob => ({ kind: 'merge', merge })),
    ...plan.rewrites.map((rewrite): WriteJob => ({ kind: 'rewrite', rewrite })),
  ];

  let written = 0;
  ctx.report('writing', 0, jobs.length, projectedActive);
  const drafts = await mapConcurrent(jobs, TIDY_CONCURRENCY, async (job) => {
    const prompt = job.kind === 'merge'
      ? buildMergePrompt([job.merge.keep, ...job.merge.absorbed])
      : buildRewritePrompt(job.rewrite.target, job.rewrite.why);
    const responseText = await completeText(ctx.model, {
      instructions: ctx.instructions,
      prompt,
      maxOutputTokens: WRITE_MAX_OUTPUT_TOKENS,
    });
    ctx.report('writing', ++written, jobs.length, projectedActive);
    const raw = parseJsonObject<RawWrite>(responseText);
    const instruction = typeof raw?.instruction === 'string' ? raw.instruction.trim() : '';
    if (!instruction) {
      logger.debug(`[Learning] Tidy-up ${job.kind} draft unusable: ${responseText.slice(0, 300)}`);
      return null;
    }
    return { raw, instruction };
  });

  // A group whose wording could not be written is left exactly as it was. The
  // decision was sound; only the prose failed, and half-applying it would retire
  // an entry into a merge that never got written.
  const merges: { keep: Learning; absorbed: Learning[]; category: LearningCategory; title: string; instruction: string; why: string }[] = [];
  const rewrites: { target: Learning; title: string; instruction: string; why: string }[] = [];
  const failedWrites: string[] = [];
  jobs.forEach((job, index) => {
    const draft = drafts[index];
    if (!draft) {
      failedWrites.push(job.kind === 'merge' ? job.merge.keep.id : job.rewrite.target.id);
      return;
    }
    const title = typeof draft.raw?.title === 'string' && draft.raw.title.trim() ? draft.raw.title.trim() : undefined;
    if (job.kind === 'merge') {
      merges.push({
        keep: job.merge.keep,
        absorbed: job.merge.absorbed,
        category: CATEGORIES.includes(draft.raw?.category as LearningCategory)
          ? (draft.raw!.category as LearningCategory)
          : job.merge.keep.category,
        title: title ?? job.merge.keep.title,
        instruction: draft.instruction,
        why: job.merge.why,
      });
    } else {
      rewrites.push({
        target: job.rewrite.target,
        title: title ?? job.rewrite.target.title,
        instruction: draft.instruction,
        why: job.rewrite.why,
      });
    }
  });

  const graduating = ctx.graduationBlocked ? [] : plan.graduates.map((g) => g.target);

  // Recompute from what SURVIVED both passes: a merge whose wording never got
  // written frees no slot, and reporting as if it had would tell the user the
  // file is closer to the cap than it is.
  projectedActive = active.length
    - plan.retires.length
    - graduating.length
    - merges.reduce((n, m) => n + m.absorbed.length, 0);
  if (jobs.length > 0) ctx.report('writing', jobs.length, jobs.length, projectedActive);

  // Build the round's result in memory, against a copy: nothing here is written.
  const next: Learning[] = current.map((l) => ({ ...l }));
  const byId = new Map(next.map((l) => [l.id, l]));

  for (const merge of merges) {
    const keep = byId.get(merge.keep.id)!;
    keep.category = merge.category;
    keep.title = merge.title;
    keep.instruction = merge.instruction;
    keep.source = merge.absorbed.concat(keep).reduce((strongest, l) =>
      l.source === 'manual' || (l.source === 'approval' && strongest !== 'manual') ? l.source : strongest, keep.source);
    keep.confidence = Math.max(keep.confidence, ...merge.absorbed.map((l) => l.confidence));
    // Max, not sum: a merged rule was injected on the runs where ANY of its
    // parts was, not on the sum of those runs, and inflating the count would let
    // a merge manufacture the evidence that graduates it.
    keep.appliedCount = Math.max(keep.appliedCount, ...merge.absorbed.map((l) => l.appliedCount));
    keep.approvedRuns = Math.max(keep.approvedRuns, ...merge.absorbed.map((l) => l.approvedRuns));
    keep.reasserted = merge.absorbed.reduce((sum, l) => sum + l.reasserted, keep.reasserted);
    keep.extractedAt = ctx.nowIso;
    for (const absorbed of merge.absorbed) byId.get(absorbed.id)!.state = 'retired';
  }
  for (const rewrite of rewrites) {
    const target = byId.get(rewrite.target.id)!;
    target.title = rewrite.title;
    target.instruction = rewrite.instruction;
    target.extractedAt = ctx.nowIso;
  }
  for (const retire of plan.retires) byId.get(retire.target.id)!.state = 'retired';
  for (const target of graduating) byId.get(target.id)!.state = 'graduated';

  const changes: ConsolidationChange[] = [
    ...merges.map((m): ConsolidationChange => ({
      kind: 'merge',
      titles: [m.keep.title, ...m.absorbed.map((l) => l.title)],
      why: m.why,
    })),
    ...rewrites.map((r): ConsolidationChange => ({ kind: 'rewrite', titles: [r.target.title], why: r.why })),
    ...plan.retires.map((r): ConsolidationChange => ({ kind: 'retire', titles: [r.target.title], why: r.why })),
    ...graduating.map((t): ConsolidationChange => ({
      kind: 'graduate',
      titles: [t.title],
      why: plan.graduates.find((g) => g.target.id === t.id)?.why ?? '',
    })),
  ];

  return {
    next,
    changes,
    merged: merges.length,
    rewritten: rewrites.length,
    retired: plan.retires.length + merges.reduce((n, m) => n + m.absorbed.length, 0),
    graduated: graduating,
    graduatesProposed: plan.graduates.length,
    batches: batches.length,
    failedBatches,
    failedWrites,
    sample,
  };
}

/**
 * Rewrite the permanent block as one document, or leave it exactly as it is.
 *
 * Every failure path returns null, and null means the caller keeps the block it
 * already had. That asymmetry is deliberate: this edits a file the user wrote
 * and considers theirs, so a call that times out, comes back unparseable, or
 * loses a rule must cost nothing rather than write a partial result. The
 * coverage check in {@link validateBlockRewrite} is what turns "the model
 * dropped a rule" from a silent edit into a discarded call.
 */
async function rewritePermanentBlock(
  rules: PermanentRule[],
  freshCount: number,
  ctx: {
    model: string;
    instructions: string;
    reportAt: (phase: TidyProgress['phase']) => void;
  },
): Promise<BlockRewrite | null> {
  ctx.reportAt('writing');
  let responseText: string | undefined;
  try {
    responseText = await completeText(ctx.model, {
      instructions: ctx.instructions,
      prompt: buildBlockRewritePrompt(rules, freshCount),
      maxOutputTokens: BLOCK_MAX_OUTPUT_TOKENS,
    });
  } catch (error) {
    logger.debug(`[Learning] Permanent-block rewrite call failed: ${error}`);
    return null;
  }

  const raw = responseText ? parseJsonObject<RawBlockRewrite>(responseText) : null;
  if (!raw) {
    logger.debug(`[Learning] Permanent-block rewrite returned unusable JSON: ${(responseText ?? '').slice(0, 500)}`);
    return null;
  }

  const checked = validateBlockRewrite(raw, rules);
  if ('rejected' in checked) {
    logger.debug(`[Learning] Permanent-block rewrite discarded: ${checked.rejected}`);
    return null;
  }
  return auditEdits(checked, rules, ctx);
}

/**
 * Ask, of every rule the rewrite changed, what it dropped — and put the
 * originals back where the answer is "something".
 *
 * Runs per edited rule and concurrently, so the cost is the slowest single
 * audit rather than their sum, and an untouched rule costs nothing at all.
 *
 * A failed audit restores that rule's sources verbatim and leaves every other
 * rule alone. Rejecting the whole rewrite over one bad merge would put the
 * block back exactly where it started, which on an agent whose model keeps
 * making the same bad merge means it is never tidied again — the never-pruned
 * dead end this pass exists to escape. One bad merge should cost itself.
 *
 * An audit that errors or comes back unreadable also restores the sources.
 * Unverified and unfaithful are different things, but the safe response to both
 * is the same, and it is the one that changes nothing.
 */
async function auditEdits(
  checked: CheckedRewrite,
  before: PermanentRule[],
  ctx: { model: string; instructions: string },
): Promise<BlockRewrite> {
  const verdicts = await mapConcurrent(checked.rules, TIDY_CONCURRENCY, async (rule) => {
    const sources = rule.covers.map((i) => before[i]!);
    const untouched = rule.covers.length === 1 && sources[0]!.instruction === rule.instruction;
    if (untouched) return { rule, missing: [] as string[] };

    let text: string | undefined;
    try {
      text = await completeText(ctx.model, {
        instructions: ctx.instructions,
        prompt: buildMergeAuditPrompt(sources, rule.instruction),
        maxOutputTokens: WRITE_MAX_OUTPUT_TOKENS,
      });
    } catch (error) {
      return { rule, missing: [`the audit call failed: ${error}`] };
    }
    const raw = text ? parseJsonObject<RawAudit>(text) : null;
    if (!raw) return { rule, missing: ['the audit returned nothing readable'] };
    const missing = (Array.isArray(raw.missing) ? raw.missing : [])
      .filter((m): m is string => typeof m === 'string' && m.trim().length > 0);
    return { rule, missing };
  });

  const rules: PermanentRule[] = [];
  const edited: ConsolidationChange[] = [];
  const refused: string[] = [];

  for (const [index, verdict] of verdicts.entries()) {
    // mapConcurrent resolves a thrown worker to null; the rule it was checking
    // is unverified, so it keeps its sources like any other failed audit.
    const rule = verdict?.rule ?? checked.rules[index]!;
    const sources = rule.covers.map((i) => before[i]!);
    const missing = verdict ? verdict.missing : ['the audit did not complete'];
    const untouched = rule.covers.length === 1 && sources[0]!.instruction === rule.instruction;

    if (missing.length > 0) {
      refused.push(
        `${rule.covers.length > 1 ? 'merge of' : 'rewrite of'} ${rule.covers.map((i) => `rule ${i}`).join(' + ')} `
        + `dropped: ${missing.join('; ')}`,
      );
      rules.push(...sources);
      continue;
    }

    rules.push({ category: rule.category, instruction: rule.instruction });
    if (!untouched) {
      edited.push({
        kind: rule.covers.length > 1 ? 'merge-permanent' : 'rewrite-permanent',
        titles: sources.map((s) => s.instruction.slice(0, 60)),
        why: rule.why?.trim() || (rule.covers.length > 1 ? 'combined overlapping permanent rules' : 'tightened in place'),
      });
    }
  }

  for (const note of refused) logger.debug(`[Learning] Permanent-block ${note}; kept the originals`);
  return { rules, dropped: checked.dropped, edited, refused };
}

/**
 * The `---`/`+++` header for the agent-file diff: project-relative when the file
 * is inside the project, absolute only when it genuinely sits outside.
 *
 * A tidy-up result is replayed in the serve UI, where it is visible to anyone
 * holding a gate link, and it is stored verbatim in the tidy record on disk. An
 * absolute path there publishes the operator's home directory to every reader
 * for no gain — the reviewer already knows which agent they pressed the button
 * on.
 */
function diffLabel(target: string, root: string): string {
  const rel = relative(root, target);
  return rel && !rel.startsWith('..') && !isAbsolute(rel) ? rel : target;
}

/**
 * Run a tidy-up. Safe to call when nothing needs doing — it reports `ran: false`
 * rather than spending a model call.
 */
export async function consolidateLearnings(options: ConsolidateOptions): Promise<ConsolidationResult> {
  const now = options.now ?? Date.now();
  const cap = effectiveCap(options.config);
  const store = LearningStore.fromAgentFile(options.agentFilePath, options.stateRoot);
  const stored = await store.load();
  const active = activeLearnings(stored);

  const base: ConsolidationResult = {
    ran: false,
    activeBefore: active.length,
    activeAfter: active.length,
    cap,
    rounds: 0,
    changes: [],
    droppedPermanent: [],
    merged: 0,
    rewritten: 0,
    retired: 0,
    graduated: [],
    diffs: { learnings: '' },
  };

  // Read once, here, because whether there is anything to do depends on it.
  const agentBefore = await readFile(options.agentFilePath, 'utf-8');

  // Two piles, two failure modes, either one is reason to run.
  //
  // Gating on the cap alone meant the permanent block was only ever looked at
  // as a side effect of the staging set overflowing — so an agent that keeps
  // its staging tidy never had its block read at all, and that block is the one
  // nothing else revisits. Measured across the four agents carrying blocks:
  // three reported "nothing to tidy up" while holding rules that had never once
  // been reconciled against each other.
  //
  // Two rules, because a block of one has nothing to compare against.
  const permanentBefore = parseLearnedBlock(agentBefore);
  if (active.length <= cap && permanentBefore.length < 2) return base;

  // Helper calls run on the agent's own model unless overridden: whatever
  // provider and auth the agent already works with is guaranteed to work here,
  // and the model that will follow these instructions should be the one that
  // writes them.
  const model = options.model ?? options.config?.model ?? options.agentModel;
  const instructions = isAnthropicModel(model)
    ? ANTHROPIC_IDENTITY_PROMPT
    : 'You consolidate an agent\'s stored corrections into a smaller set without losing meaning, and reply with a JSON object only.';

  // Whether a rule may become permanent at all is a property of this agent, not
  // of any one round, so it is settled once: five rounds should not re-stat the
  // same file, and no round should mark something graduated that will never
  // reach the agent file.
  const graduationBlocked = (await agentFileIsWritable(options.agentFilePath))
    ? undefined
    : 'the agent file is not writable';

  // The corrections file, to match the agent file already read above. Every
  // round below works in memory and both files are written once at the end, so
  // a press that took five rounds is still one undo.
  const beforeLearnings = existsSync(store.filePath) ? await readFile(store.filePath, 'utf-8') : '';

  let working: Learning[] = stored.map((l) => ({ ...l }));
  const changes: ConsolidationChange[] = [];
  const graduated: Learning[] = [];
  let merged = 0;
  let rewritten = 0;
  let retired = 0;
  let graduatesProposed = 0;
  let batchCount = 0;
  let failedBatches = 0;
  const failedWrites = new Set<string>();
  let lastSample = '';
  let rounds = 0;
  let stoppedEarly = false;

  for (let round = 1; round <= MAX_ROUNDS; round++) {
    const before = activeLearnings(working);
    if (before.length <= cap) break;

    const outcome = await tidyRound(working, before, {
      model,
      instructions,
      // The FILE, not the caller's copy of the instructions.
      //
      // `perm0`, `perm1`… are positions in the permanent block, and the drops
      // are applied against the block parsed from this same file text. Indexing
      // the prompt off a separately-parsed copy would mean a stale or
      // differently-derived snapshot could number the rules one way while the
      // write removed them another — dropping the wrong rule out of a file the
      // human owns. One source for both, so they cannot disagree.
      agentInstructions: agentBefore,
      cap,
      now,
      nowIso: new Date(now).toISOString(),
      graduationBlocked: graduationBlocked !== undefined,
      report: (phase, step, total, projectedActive) =>
        options.onProgress?.({ phase, step, total, round, maxRounds: MAX_ROUNDS, projectedActive, cap }),
    });

    rounds = round;
    batchCount += outcome.batches;
    failedBatches += outcome.failedBatches;
    for (const id of outcome.failedWrites) failedWrites.add(id);
    graduatesProposed += outcome.graduatesProposed;
    if (outcome.sample) lastSample = outcome.sample;

    if (outcome.batches > 0 && outcome.failedBatches === outcome.batches) {
      // Not one group came back readable. On the first round there is nothing
      // to keep, so write nothing and say why rather than guess: a partial
      // apply is worse than no apply when the target is a file the user owns.
      //
      // Quote what came back. "Unusable plan" with no evidence leaves the user
      // (and us) with nowhere to go, and the two causes, an empty completion
      // and a chatty one, need opposite responses.
      if (round === 1) {
        return {
          ...base,
          ran: true,
          rounds,
          model,
          note: lastSample
            ? `${model} did not return a usable plan; nothing was changed. It said: "${lastSample}…"`
            : `${model} returned an empty plan; nothing was changed. Try another model with --model.`,
        };
      }
      break; // a later round failing whole costs its own round, not the press
    }

    working = outcome.next;
    changes.push(...outcome.changes);
    graduated.push(...outcome.graduated);
    merged += outcome.merged;
    rewritten += outcome.rewritten;
    retired += outcome.retired;

    // Stop the moment a round stops paying. A round that freed no slot has run
    // out of duplicates to find; the corrections left are there on merit, and
    // four more rounds would spend minutes confirming it.
    const after = activeLearnings(working).length;
    if (after >= before.length) break;
    if (round === MAX_ROUNDS && after > cap) stoppedEarly = true;
  }

  const remainingActive = activeLearnings(working);
  const reportAt = (phase: TidyProgress['phase']) =>
    options.onProgress?.({
      phase,
      step: 1,
      total: 1,
      round: rounds,
      maxRounds: MAX_ROUNDS,
      projectedActive: remainingActive.length,
      cap,
    });
  reportAt('applying');

  // Graduation MOVES a rule: it is appended to whatever the agent file already
  // says, and dropped from the store. It is not reprinted from a stored copy.
  //
  // Reprinting was why a human editing the block got their wording silently
  // restored to the stored version on the next graduation — the file was a
  // printout, not the source. Reading the current block and adding to it makes
  // the file the input to its own next edit, and leaves exactly one copy of
  // each rule instead of two that can drift apart.
  const newlyPermanent = working.filter((l) => l.state === 'graduated');
  const appended: PermanentRule[] = graduationBlocked
    ? permanentBefore
    : [
        ...permanentBefore,
        ...newlyPermanent.map((l) => ({ category: l.category, instruction: l.instruction })),
      ];

  // The block pass. Appending is the whole reason this block only ever grew, so
  // the appended set is not the answer — it is the input to one more call that
  // reads all of it at once and writes it back as a single document.
  //
  // Run whenever there are two rules to compare, not only when something was
  // just promoted: redundancy that arrived over several presses is exactly the
  // kind nothing else will ever find. When the rewrite is refused or unusable,
  // the appended set stands, which is precisely the old behaviour.
  const blockOutcome = graduationBlocked || appended.length < 2
    ? null
    : await rewritePermanentBlock(appended, newlyPermanent.length, { model, instructions, reportAt });

  const permanentAfter = blockOutcome?.rules ?? appended;
  const droppedPermanent = blockOutcome?.dropped ?? [];
  // Counted as changes so a press whose ONLY effect is tightening the block
  // still writes, and still shows up in the change list. Editing rules in the
  // human's own file is the least invisible thing here, not the most.
  if (blockOutcome) {
    changes.push(...blockOutcome.edited);
    changes.push(...droppedPermanent.map((d): ConsolidationChange => ({
      kind: 'drop-permanent',
      titles: [d.instruction.slice(0, 80)],
      why: d.why,
    })));
  }
  // A rule that reached the agent file has no staged copy left to keep.
  const stagedAfter = graduationBlocked ? working : working.filter((l) => l.state !== 'graduated');
  const afterLearnings = store.render(stagedAfter);
  const agentAfter = graduationBlocked ? agentBefore : spliceLearnedBlock(agentBefore, permanentAfter);

  // Only mention the block when it cost something: an unwritable agent file that
  // nothing wanted to graduate into is not news.
  const graduationSkipped = graduationBlocked && graduatesProposed > 0 ? graduationBlocked : undefined;

  // Say what was skipped. A press that quietly covered less than the whole file
  // reads as "done" unless it admits the gap.
  const shortfalls: string[] = [];
  if (failedBatches > 0) shortfalls.push(`${failedBatches} of ${batchCount} groups of corrections could not be planned`);
  if (failedWrites.size > 0) shortfalls.push(`${failedWrites.size} rewrite${failedWrites.size === 1 ? '' : 's'} could not be written`);
  const incomplete = shortfalls.length > 0
    ? `${shortfalls.join(' and ')}; those corrections were left untouched. Tidy up again to retry them.`
    : undefined;

  const result: ConsolidationResult = {
    ran: true,
    model,
    activeBefore: active.length,
    activeAfter: remainingActive.length,
    cap,
    rounds,
    changes,
    merged,
    rewritten,
    retired,
    graduated: graduated.map((l) => l.title),
    droppedPermanent: graduationBlocked ? [] : droppedPermanent,
    ...(graduationSkipped ? { graduationSkipped } : {}),
    ...(incomplete ? { note: incomplete } : {}),
    // Only when it ends over the cap. At or under it there is nothing to
    // explain, and an explanation nobody asked for reads as an excuse.
    ...(remainingActive.length > cap
      ? { remaining: explainRemaining(remainingActive, cap, now, stoppedEarly || failedBatches > 0) }
      : {}),
    diffs: {
      // Named, not located. The learnings file now lives under a project hash
      // in the state directory, so its absolute path tells a reviewer nothing
      // they can act on and everything about the machine it ran on.
      learnings: unifiedDiff(beforeLearnings, afterLearnings, { label: 'learnings file' }),
      ...(agentAfter !== agentBefore
        ? {
          agentFile: unifiedDiff(agentBefore, agentAfter, {
            label: diffLabel(options.agentFilePath, options.stateRoot),
          }),
        }
        : {}),
    },
  };

  if (options.dryRun || changes.length === 0) return result;

  const undoId = new Date(now).toISOString().replace(/[:.]/g, '-');
  const committed = await withLearningFileLock(store.filePath, async () => {
    const latest = await store.load();
    const reconciled = reconcileConcurrentLearnings(stored, working, latest);
    const latestLearnings = existsSync(store.filePath)
      ? await readFile(store.filePath, 'utf-8')
      : '';
    const latestAgent = await readFile(options.agentFilePath, 'utf-8');
    // Append to what the agent file says NOW, at commit time — not to the copy
    // the model read minutes ago, and not from a stored duplicate. A rule that
    // lands in the file is dropped from the store in the same write.
    const reconciledGraduated = reconciled.filter((learning) => learning.state === 'graduated');
    const reconciledStaged = graduationBlocked
      ? reconciled
      : reconciled.filter((learning) => learning.state !== 'graduated');
    // A rewritten block replaces text that was read at the START of this press.
    // If the file's block changed since, or reconciliation changed which rules
    // are graduating, that plan describes a document that no longer exists —
    // writing it would silently revert whoever edited it in the meantime. Fall
    // back to appending, which stays correct against any block. Rare enough to
    // cost nothing, and the next press rewrites the block properly.
    const appendedNow: PermanentRule[] = [
      ...parseLearnedBlock(latestAgent),
      ...reconciledGraduated.map((l) => ({ category: l.category, instruction: l.instruction })),
    ];
    const planStillFits = blockOutcome !== null && isDeepStrictEqual(appendedNow, appended);
    const reconciledAgent = graduationBlocked
      ? latestAgent
      : spliceLearnedBlock(latestAgent, planStillFits ? permanentAfter : appendedNow);

    // The snapshot is of the actual commit-time inputs, not the stale files the
    // model read minutes ago. Undo therefore preserves concurrent additions.
    await writeSnapshot(options.stateRoot, options.agentFilePath, {
      id: undoId,
      files: [
        { path: store.filePath, content: latestLearnings },
        { path: options.agentFilePath, content: latestAgent },
      ],
    });

    // Agent file first. A crash between the two writes leaves a rule stated
    // twice, which is harmless; the reverse order could lose it from both.
    if (!graduationBlocked && reconciledAgent !== latestAgent) {
      await atomicWriteFile(options.agentFilePath, reconciledAgent);
    }
    await store.save(reconciledStaged);
    return { reconciled: reconciledStaged, latestLearnings, latestAgent, reconciledAgent };
  });
  reportAt('done');

  return {
    ...result,
    activeAfter: activeLearnings(committed.reconciled).length,
    diffs: {
      learnings: unifiedDiff(committed.latestLearnings, store.render(committed.reconciled), {
        label: 'learnings file',
      }),
      ...(committed.reconciledAgent !== committed.latestAgent
        ? {
          agentFile: unifiedDiff(committed.latestAgent, committed.reconciledAgent, {
            label: diffLabel(options.agentFilePath, options.stateRoot),
          }),
        }
        : {}),
    },
    undoId,
  };
}

/** One-line summary for a session marker or CLI line. */
export function describeConsolidation(result: ConsolidationResult): string {
  if (!result.ran) return 'Nothing to tidy up';
  // `note` also carries a partial-failure warning alongside real changes, so it
  // only stands in for the summary when there is nothing else to report.
  if (result.note && result.changes.length === 0) return result.note;
  const parts: string[] = [];
  if (result.merged > 0) parts.push(`${result.merged} merged`);
  if (result.rewritten > 0) parts.push(`${result.rewritten} rewritten`);
  if (result.retired > 0) parts.push(`${result.retired} retired`);
  if (result.graduated.length > 0) parts.push(`${result.graduated.length} now permanent`);
  if (parts.length === 0) return 'Nothing safe to change';
  return `${parts.join(', ')} — ${result.activeBefore} → ${result.activeAfter} in force`;
}
