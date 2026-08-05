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
 * Four moves, in one model call:
 * - MERGE near-duplicates into a single rule
 * - REWRITE a rule a human has repeated (a repeat means the wording is not
 *   landing, so restating it more sharply is the fix; retiring it is not)
 * - RETIRE what has been superseded (archived in the same file, never deleted)
 * - GRADUATE what has proven itself into the agent's own instructions, where it
 *   applies on every run and costs no cap slot
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
 * Output budget for the planning call.
 *
 * Well above what the JSON needs, because on a reasoning model the budget covers
 * thinking too. At the provider default (4096) a 125-correction file spent the
 * entire allowance on reasoning and returned ZERO text: `finishReason` came back
 * as `max_tokens` with an empty completion, which is indistinguishable from a
 * dead model unless you are counting chunk types.
 */
const TIDY_MAX_OUTPUT_TOKENS = 16_000;

/**
 * Corrections planned over per model call.
 *
 * Small enough that a reasoning model reaches an answer instead of thinking
 * until the budget runs out. See the batching comment in
 * {@link consolidateLearnings} for what happened without this.
 */
const TIDY_BATCH_SIZE = 25;

/**
 * Batches planned per invocation.
 *
 * Bounds how long one tidy-up takes. On a reasoning model a batch costs a minute
 * or two, so an unbounded pass over a 125-correction file runs for ten minutes —
 * fine in a terminal, useless behind a button in the web UI, where the request
 * would time out before it wrote anything. A very large file therefore takes
 * several passes, and both surfaces say so rather than implying one press
 * finished the job.
 */
const TIDY_MAX_BATCHES = 3;

export interface ConsolidationChange {
  kind: 'merge' | 'rewrite' | 'retire' | 'graduate';
  /** Titles involved, for the human-readable summary. */
  titles: string[];
  why: string;
}

export interface ConsolidationResult {
  /** False when there was nothing over the cap to fix. */
  ran: boolean;
  model?: string;
  activeBefore: number;
  activeAfter: number;
  cap: number;
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

interface RawPlan {
  merge?: { ids?: string[]; keep?: string; category?: string; title?: string; instruction?: string; why?: string }[];
  rewrite?: { id?: string; title?: string; instruction?: string; why?: string }[];
  retire?: { id?: string; why?: string }[];
  graduate?: { id?: string; why?: string }[];
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

export function buildTidyPrompt(
  learnings: Learning[],
  agentInstructions: string,
  cap: number,
  now: number,
): string {
  const inventory = learnings.map((l) => {
    const flags: string[] = [`src:${l.source}`];
    if (l.reasserted > 0) flags.push(`repeated by a human ${l.reasserted}x`);
    if (l.approvedRuns > 0) flags.push(`in force across ${l.approvedRuns} approved runs`);
    flags.push(`${Math.round(ageInDays(l, now))}d old`);
    const blocked = retireBlocked(l, now);
    if (blocked) flags.push(`CANNOT RETIRE: ${blocked}`);
    if (isGraduationEligible(l)) flags.push('ELIGIBLE TO GRADUATE');
    return `- id:${l.id} [${l.category}] ${l.title} (${flags.join('; ')})\n  ${l.instruction}`;
  }).join('\n');

  return `An agent has accumulated ${learnings.length} stored corrections, but only the top ${cap} are put in front of the model on any run. The rest have no effect. Your job is to get the active set to ${cap} or fewer without losing anything the agent needs.

## The agent's own instructions
${agentInstructions.slice(0, 6000)}

## Stored corrections
${inventory}

## Moves available

1. **merge** — two or more corrections saying substantially the same thing become one. Write the merged instruction so it covers everything the originals covered; do not just pick one.
2. **rewrite** — a correction a human has REPEATED is not wrong, it is not landing. Restate it more concretely and more specifically so the agent cannot follow it and still make the mistake. Prefer this over retiring anything marked as repeated.
3. **retire** — a correction that another one now fully covers, or that the agent's own instructions above already state. Only entries with no "CANNOT RETIRE" flag.
4. **graduate** — a correction that has proven itself moves into the agent's permanent instructions. Only entries marked "ELIGIBLE TO GRADUATE". Prefer graduating over merging when a rule stands on its own: it stops competing for a slot.

## Rules
- Every id you name must come from the list. Each id may appear in AT MOST ONE move.
- Never drop a distinction that matters. If two corrections look similar but constrain different situations, leave them both alone.
- Do not invent new corrections. Every instruction you write must be traceable to the ones you were given.
- If nothing can be safely improved, return empty arrays.

Respond with ONLY a JSON object, no other text:
{
  "merge":    [{"ids": ["ab12cd34", "ef56gh78"], "keep": "ab12cd34", "category": "tip", "title": "short title", "instruction": "the merged instruction", "why": "one line"}],
  "rewrite":  [{"id": "ij90kl12", "title": "short title", "instruction": "the sharper instruction", "why": "one line"}],
  "retire":   [{"id": "mn34op56", "why": "one line"}],
  "graduate": [{"id": "qr78st90", "why": "one line"}]
}`;
}

/**
 * Read a plan out of a model response.
 *
 * Tries the response as-is, then a fenced code block, then the outermost
 * `{...}` span. The last fallback matters in practice: models routinely preface
 * a JSON answer with a sentence of explanation however firmly the prompt asks
 * them not to, and throwing away an otherwise perfect plan over a leading
 * "Here's the consolidation:" would make the whole feature look broken.
 */
function parsePlan(responseText: string): RawPlan | null {
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
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as RawPlan;
    } catch {
      // try the next shape
    }
  }
  return null;
}

interface ValidatedPlan {
  merges: { keep: Learning; absorbed: Learning[]; category: LearningCategory; title: string; instruction: string; why: string }[];
  rewrites: { target: Learning; title: string; instruction: string; why: string }[];
  retires: { target: Learning; why: string }[];
  graduates: { target: Learning; why: string }[];
  rejected: string[];
}

/**
 * Apply every guardrail to a proposed plan.
 *
 * Rejections are collected rather than thrown: one bad entry in an otherwise
 * good plan should cost that entry, not the whole tidy-up. They are logged at
 * debug so a model that keeps proposing forbidden moves is diagnosable.
 */
export function validatePlan(raw: RawPlan, learnings: Learning[], now: number): ValidatedPlan {
  const byId = new Map(learnings.map((l) => [l.id, l]));
  const claimed = new Set<string>();
  const out: ValidatedPlan = { merges: [], rewrites: [], retires: [], graduates: [], rejected: [] };

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
    const instruction = typeof m.instruction === 'string' ? m.instruction.trim() : '';
    if (ids.length < 2 || !instruction) {
      out.rejected.push('merge: needs at least two ids and an instruction');
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
      category: CATEGORIES.includes(m.category as LearningCategory) ? (m.category as LearningCategory) : keep.category,
      title: typeof m.title === 'string' && m.title.trim() ? m.title.trim() : keep.title,
      instruction,
      why: m.why ?? 'merged near-duplicates',
    });
  }

  for (const r of raw.rewrite ?? []) {
    const instruction = typeof r.instruction === 'string' ? r.instruction.trim() : '';
    if (!instruction) {
      out.rejected.push('rewrite: missing instruction');
      continue;
    }
    const target = claim(r.id, 'rewrite');
    if (!target) continue;
    claimed.add(target.id);
    out.rewrites.push({
      target,
      title: typeof r.title === 'string' && r.title.trim() ? r.title.trim() : target.title,
      instruction,
      why: r.why ?? 'sharpened a repeated correction',
    });
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

async function writeSnapshot(stateRoot: string, agentFilePath: string, snapshot: Snapshot): Promise<void> {
  const dir = snapshotDir(stateRoot, agentFilePath);
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, `${snapshot.id}.json`), JSON.stringify(snapshot, null, 2), 'utf-8');

  const entries = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
  for (const stale of entries.slice(0, Math.max(0, entries.length - UNDO_HISTORY))) {
    await unlink(join(dir, stale)).catch(() => {});
  }
}

/** Restore the most recent tidy-up. Returns the files it put back. */
export async function undoConsolidation(
  stateRoot: string,
  agentFilePath: string,
): Promise<{ restored: string[] } | null> {
  const dir = snapshotDir(stateRoot, agentFilePath);
  if (!existsSync(dir)) return null;
  const entries = (await readdir(dir)).filter((f) => f.endsWith('.json')).sort();
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

  // Plan in bounded batches rather than one pass over the whole file.
  //
  // Not an optimisation — a correctness fix. Handed all 125 corrections from a
  // real agent at once, the model spent its ENTIRE output budget reasoning and
  // emitted no text at all: `finishReason: max_tokens`, zero text deltas, which
  // surfaces as "empty response" and looks like a dead model. Raising the budget
  // to 16k did not help; it reasoned through that too. The task, not the budget,
  // was the problem. A batch is small enough to actually plan over, and batches
  // are disjoint so their ids can never collide when the plans are merged.
  const ranked = rankLearnings(active);
  const batches: Learning[][] = [];
  for (let i = 0; i < ranked.length && batches.length < TIDY_MAX_BATCHES; i += TIDY_BATCH_SIZE) {
    batches.push(ranked.slice(i, i + TIDY_BATCH_SIZE));
  }

  const plan: ValidatedPlan = { merges: [], rewrites: [], retires: [], graduates: [], rejected: [] };
  let projectedActive = active.length;
  let failedBatches = 0;
  let lastSample = '';

  for (const batch of batches) {
    // Stop once the goal is met: an agent one over the cap should not pay for
    // five model calls to tidy corrections that are already reaching it.
    if (projectedActive <= cap) break;

    const responseText = await completeText(model, {
      instructions,
      prompt: buildTidyPrompt(batch, options.agentInstructions, cap, now),
      maxOutputTokens: TIDY_MAX_OUTPUT_TOKENS,
    });

    const raw = parsePlan(responseText);
    if (!raw) {
      // One bad batch costs that batch, not the whole tidy-up. Whatever the
      // other batches proposed is still valid and still worth applying.
      failedBatches++;
      lastSample = responseText.trim().slice(0, 120).replace(/\s+/g, ' ');
      logger.debug(`[Learning] Tidy-up batch returned unusable JSON: ${responseText.slice(0, 500)}`);
      continue;
    }

    const batchPlan = validatePlan(raw, batch, now);
    plan.merges.push(...batchPlan.merges);
    plan.rewrites.push(...batchPlan.rewrites);
    plan.retires.push(...batchPlan.retires);
    plan.graduates.push(...batchPlan.graduates);
    plan.rejected.push(...batchPlan.rejected);

    projectedActive -= batchPlan.retires.length
      + batchPlan.graduates.length
      + batchPlan.merges.reduce((n, m) => n + m.absorbed.length, 0);
  }

  for (const rejection of plan.rejected) logger.debug(`[Learning] Tidy-up rejected ${rejection}`);

  const nothingUsable = failedBatches === batches.length;
  if (nothingUsable) {
    // Write nothing rather than guess. A partial apply is worse than no apply
    // when the target is the user's own agent file.
    //
    // Quote what came back: "unusable plan" with no evidence leaves the user
    // (and us) with nowhere to go, and the two causes — an empty completion and
    // a chatty one — need opposite responses.
    return {
      ...base,
      ran: true,
      model,
      note: lastSample
        ? `${model} did not return a usable plan; nothing was changed. It said: "${lastSample}…"`
        : `${model} returned an empty plan; nothing was changed. Try another model with --model.`,
    };
  }

  const graduatedTargets = plan.graduates.map((g) => g.target);
  const canGraduate = graduatedTargets.length > 0;
  let graduationSkipped: string | undefined;
  if (canGraduate && options.config?.file) {
    graduationSkipped = 'this agent shares its learnings file with other agents, so making a rule permanent here would silently remove it from them';
  } else if (canGraduate && !(await agentFileIsWritable(options.agentFilePath))) {
    graduationSkipped = 'the agent file is not writable';
  }
  const graduating = graduationSkipped ? [] : graduatedTargets;

  // Build the next store state in memory so both files can be diffed before
  // either is written.
  const next: Learning[] = stored.map((l) => ({ ...l }));
  const byId = new Map(next.map((l) => [l.id, l]));
  const nowIso = new Date(now).toISOString();

  for (const merge of plan.merges) {
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
    keep.extractedAt = nowIso;
    for (const absorbed of merge.absorbed) byId.get(absorbed.id)!.state = 'retired';
  }
  for (const rewrite of plan.rewrites) {
    const target = byId.get(rewrite.target.id)!;
    target.title = rewrite.title;
    target.instruction = rewrite.instruction;
    target.extractedAt = nowIso;
  }
  for (const retire of plan.retires) byId.get(retire.target.id)!.state = 'retired';
  for (const target of graduating) byId.get(target.id)!.state = 'graduated';

  const beforeLearnings = existsSync(store.filePath) ? await readFile(store.filePath, 'utf-8') : '';
  const afterLearnings = store.render(next);
  const graduatedAll = next.filter((l) => l.state === 'graduated');

  const agentBefore = await readFile(options.agentFilePath, 'utf-8');
  const agentAfter = graduationSkipped ? agentBefore : spliceLearnedBlock(agentBefore, graduatedAll);

  const changes: ConsolidationChange[] = [
    ...plan.merges.map((m): ConsolidationChange => ({
      kind: 'merge',
      titles: [m.keep.title, ...m.absorbed.map((l) => l.title)],
      why: m.why,
    })),
    ...plan.rewrites.map((r): ConsolidationChange => ({ kind: 'rewrite', titles: [r.target.title], why: r.why })),
    ...plan.retires.map((r): ConsolidationChange => ({ kind: 'retire', titles: [r.target.title], why: r.why })),
    ...graduating.map((t): ConsolidationChange => ({
      kind: 'graduate',
      titles: [t.title],
      why: plan.graduates.find((g) => g.target.id === t.id)?.why ?? '',
    })),
  ];

  const result: ConsolidationResult = {
    ran: true,
    model,
    activeBefore: active.length,
    activeAfter: activeLearnings(next).length,
    cap,
    changes,
    merged: plan.merges.length,
    rewritten: plan.rewrites.length,
    retired: plan.retires.length + plan.merges.reduce((n, m) => n + m.absorbed.length, 0),
    graduated: graduating.map((l) => l.title),
    ...(graduationSkipped ? { graduationSkipped } : {}),
    ...(failedBatches > 0
      ? { note: `${failedBatches} of ${batches.length} batches could not be planned and were left untouched; re-run to try them again.` }
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
  if (!graduationSkipped) await writeLearnedBlock(options.agentFilePath, graduatedAll);
  await store.save(next);

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
