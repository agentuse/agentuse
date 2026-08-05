import { readFile, writeFile, mkdir, readdir, unlink } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname, basename } from 'path';
import { createHash } from 'crypto';
import { completeText } from '../complete-text';
import { logger } from '../utils/logger';
import { unifiedDiff } from '../utils/diff';
import { ANTHROPIC_IDENTITY_PROMPT, isAnthropicModel } from '../utils/anthropic';
import { LearningStore } from './store';
import { activeLearnings, effectiveCap, rankLearnings } from './ranking';
import { agentFileIsWritable, writeLearnedBlock, spliceLearnedBlock } from './graduate';
import type { Learning, LearningCategory, LearningConfig } from './types';

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

/** Approved, uncommented runs a captured rule must survive before it can become
 *  a permanent part of the agent file. A human-written rule needs none: writing
 *  it down was the assertion. */
const GRADUATE_MIN_APPROVED_RUNS = 3;

/** Most recent snapshots kept per agent for undo. */
const UNDO_HISTORY = 5;

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
  kind: 'merge' | 'rewrite' | 'retire' | 'graduate';
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
 * Whether a correction has earned a permanent place in the agent file.
 *
 * Computed here, not chosen by the model: the model picks wording, the code
 * decides what is proven. `appliedCount` is deliberately not a factor — it
 * counts injections, which measures what a rule COSTS, not whether it works.
 */
export function isGraduationEligible(learning: Learning): boolean {
  if (learning.source === 'manual') return true;
  return learning.approvedRuns >= GRADUATE_MIN_APPROVED_RUNS;
}

/** Entries this pass is forbidden to retire, with the reason, for the prompt. */
function retireBlocked(learning: Learning, now: number): string | undefined {
  if (learning.source === 'manual') return 'a human wrote this rule';
  if (learning.reasserted > 0) return 'a human has repeated this; rewrite it instead';
  if (ageInDays(learning, now) < RETIRE_MIN_AGE_DAYS) return `less than ${RETIRE_MIN_AGE_DAYS} days old`;
  return undefined;
}

/** One correction as the decide pass sees it: the full text plus the evidence
 *  that decides what may be done to it. */
function inventoryEntry(learning: Learning, now: number): string {
  const flags: string[] = [`src:${learning.source}`];
  if (learning.reasserted > 0) flags.push(`repeated by a human ${learning.reasserted}x`);
  if (learning.approvedRuns > 0) flags.push(`in force across ${learning.approvedRuns} approved runs`);
  flags.push(`${Math.round(ageInDays(learning, now))}d old`);
  const blocked = retireBlocked(learning, now);
  if (blocked) flags.push(`CANNOT RETIRE: ${blocked}`);
  if (isGraduationEligible(learning)) flags.push('ELIGIBLE TO GRADUATE');
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

  return `An agent has accumulated ${learnings.length} stored corrections, but only the top ${cap} are put in front of the model on any run. The rest have no effect. Your job is to decide how to get the active set to ${cap} or fewer without losing anything the agent needs.

## The agent's own instructions
${agentInstructions.slice(0, 6000)}

## Stored corrections
${inventory}

## Moves available

1. **merge** — two or more corrections saying substantially the same thing become one. Name the ids and which one to keep; someone else writes the merged wording.
2. **rewrite** — a correction a human has REPEATED is not wrong, it is not landing. Name it and it will be restated more sharply. Prefer this over retiring anything marked as repeated.
3. **retire** — a correction that another one now fully covers, or that the agent's own instructions above already state. Only entries with no "CANNOT RETIRE" flag.
4. **graduate** — a correction that has proven itself moves into the agent's permanent instructions. Only entries marked "ELIGIBLE TO GRADUATE". Prefer graduating over merging when a rule stands on its own: it stops competing for a slot.

## Rules
- Every id you name must come from the list. Each id may appear in AT MOST ONE move.
- Never drop a distinction that matters. If two corrections look similar but constrain different situations, leave them both alone.
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
export function validateDecisions(raw: RawDecisions, learnings: Learning[], now: number): DecidedPlan {
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
      out.rejected.push(`graduate ${target.id}: not proven yet (${target.approvedRuns} approved runs, needs ${GRADUATE_MIN_APPROVED_RUNS})`);
      continue;
    }
    claimed.add(target.id);
    out.graduates.push({ target, why: g.why ?? 'proven across approved runs' });
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
 */
function snapshotDir(stateRoot: string, agentFilePath: string): string {
  const digest = createHash('sha256').update(agentFilePath).digest('hex').slice(0, 8);
  const label = basename(agentFilePath).replace(/[^\w.-]/g, '_');
  return join(stateRoot, '.agentuse', 'consolidations', `${label}-${digest}`);
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
  await writeFile(join(dir, `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2), 'utf-8');

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

export async function writeTidyRecord(stateRoot: string, agentFilePath: string, record: TidyRecord): Promise<void> {
  const dir = snapshotDir(stateRoot, agentFilePath);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, RECORD_FILE), JSON.stringify(record, null, 2), 'utf-8');
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
  for (const file of snapshot.files) {
    await mkdir(dirname(file.path), { recursive: true });
    await writeFile(file.path, file.content, 'utf-8');
  }
  await unlink(join(dir, latest)).catch(() => {});
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
  let manual = 0;
  let repeated = 0;
  let tooNew = 0;
  let distinct = 0;
  let eligible = 0;
  let closest = 0;

  for (const learning of active) {
    if (isGraduationEligible(learning)) eligible++;
    else closest = Math.max(closest, learning.approvedRuns);

    if (learning.source === 'manual') manual++;
    else if (learning.reasserted > 0) repeated++;
    else if (ageInDays(learning, now) < RETIRE_MIN_AGE_DAYS) tooNew++;
    else distinct++;
  }

  const reasons: TidyRemaining['reasons'] = [];
  if (distinct > 0) reasons.push({ count: distinct, because: 'say different things, so there is nothing left to merge them into' });
  if (tooNew > 0) {
    reasons.push({
      count: tooNew,
      because: `are less than ${RETIRE_MIN_AGE_DAYS} days old, and a new correction gets that long to prove itself before it can be retired`,
    });
  }
  if (manual > 0) reasons.push({ count: manual, because: 'you wrote by hand, and those are never retired for you' });
  if (repeated > 0) reasons.push({ count: repeated, because: 'you have corrected more than once, so they get sharpened rather than dropped' });

  // The question this answers is the one users actually ask: not "why is it
  // still 30" but "why did nothing become permanent". Naming the best score so
  // far turns a rule into a distance.
  const graduationWait = eligible > 0
    ? undefined
    : `None of these can move into the agent file yet. That takes ${GRADUATE_MIN_APPROVED_RUNS} runs approved without a comment, and the closest of them has ${closest}. They will become permanent on their own as you keep approving runs.`;

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
 * Run a tidy-up. Safe to call when nothing needs doing — it reports `ran: false`
 * rather than spending a model call.
 */
export async function consolidateLearnings(options: ConsolidateOptions): Promise<ConsolidationResult> {
  const now = options.now ?? Date.now();
  const cap = effectiveCap(options.config);
  const store = LearningStore.fromAgentFile(options.agentFilePath, options.config?.file);
  const stored = await store.load();
  const active = activeLearnings(stored);

  const base: ConsolidationResult = {
    ran: false,
    activeBefore: active.length,
    activeAfter: active.length,
    cap,
    rounds: 0,
    changes: [],
    merged: 0,
    rewritten: 0,
    retired: 0,
    graduated: [],
    diffs: { learnings: '' },
  };

  if (active.length <= cap) return base;

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
  const graduationBlocked = options.config?.file
    ? 'this agent shares its learnings file with other agents, so making a rule permanent here would silently remove it from them'
    : (await agentFileIsWritable(options.agentFilePath))
      ? undefined
      : 'the agent file is not writable';

  // Read both files before the first round. Every round below works in memory,
  // and the files are written once at the end, so a press that took five rounds
  // is still one undo.
  const beforeLearnings = existsSync(store.filePath) ? await readFile(store.filePath, 'utf-8') : '';
  const agentBefore = await readFile(options.agentFilePath, 'utf-8');

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
      agentInstructions: options.agentInstructions,
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

  const graduatedAll = working.filter((l) => l.state === 'graduated');
  const afterLearnings = store.render(working);
  const agentAfter = graduationBlocked ? agentBefore : spliceLearnedBlock(agentBefore, graduatedAll);

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
    ...(graduationSkipped ? { graduationSkipped } : {}),
    ...(incomplete ? { note: incomplete } : {}),
    // Only when it ends over the cap. At or under it there is nothing to
    // explain, and an explanation nobody asked for reads as an excuse.
    ...(remainingActive.length > cap
      ? { remaining: explainRemaining(remainingActive, cap, now, stoppedEarly || failedBatches > 0) }
      : {}),
    diffs: {
      learnings: unifiedDiff(beforeLearnings, afterLearnings, { label: store.filePath }),
      ...(agentAfter !== agentBefore
        ? { agentFile: unifiedDiff(agentBefore, agentAfter, { label: options.agentFilePath }) }
        : {}),
    },
  };

  if (options.dryRun || changes.length === 0) return result;

  const undoId = new Date(now).toISOString().replace(/[:.]/g, '-');
  await writeSnapshot(options.stateRoot, options.agentFilePath, {
    id: undoId,
    files: [
      { path: store.filePath, content: beforeLearnings },
      { path: options.agentFilePath, content: agentBefore },
    ],
  });

  // Agent file first. A crash between the two writes then leaves a rule stated
  // twice, which is harmless and self-correcting on the next pass; the reverse
  // order would lose it from both places.
  if (!graduationBlocked) await writeLearnedBlock(options.agentFilePath, graduatedAll);
  await store.save(working);
  reportAt('done');

  return { ...result, undoId };
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
