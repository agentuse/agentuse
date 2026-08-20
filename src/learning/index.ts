/**
 * Learning module - extract and apply learnings from agent executions
 * @experimental This feature is experimental and may change in future versions.
 */

import ora from 'ora';
import type { AgentCompleteEvent } from '../plugin/types';
import type {
  ApprovalReview, ChannelCounts, LearningCategory, LearningChannel,
  LearningConfig, LearningDraft, LearningOutcome, LearningSource,
} from './types';
import { evaluateExecution, refineManualLearning, renderRunEvidence } from './evaluator';
import { generateLearningId, LearningStore } from './store';
import { activeLearnings, effectiveCap } from './ranking';
import { hashInstructions, isStaleAgainst } from './contract';
import { vetCandidates, describeVetFailure, type VetVerdict } from './vet';
import { detectToolErrorRecoveries, toolErrorDraft } from './tool-errors';
import { logger } from '../utils/logger';

export interface ExtractLearningsOptions {
  event: AgentCompleteEvent;
  agentInstructions: string;
  agentModel: string;
  agentFilePath: string;
  /** The agent file's own project root (`resolveProjectContext().stateRoot`),
   *  which decides where the corrections file lives. Deliberately not the
   *  cwd-derived project root: one agent must have one store no matter which
   *  shell the run started from. */
  stateRoot: string;
  config: LearningConfig;
  /** Reviewer comments from this run's approval gates (paired with the work). */
  reviews?: ApprovalReview[];
  /** Session the run belongs to; stamped on captured learnings so the session
   *  view can show only the lessons that run produced. */
  sessionId?: string | undefined;
}

/**
 * Extract learnings from a completed agent execution
 * Called after agent completion when learning.capture is enabled.
 *
 * The pipeline, per channel:
 * 1. corrections (always on with capture): the durable principles behind
 *    reviewer comments, via the built-in evaluator. Skipped entirely when the
 *    run drew no comments — the corrections-only default costs nothing then.
 * 2. tool-errors (addon): failure→recovery pairs detected structurally in the
 *    trace, in code. No model judgment involved in whether one is real.
 * 3. custom / agent (opt-in): free-form observation capture, via the built-in
 *    evaluator scoped by the guidance text, or a replacement evaluator agent.
 *
 * Every free-form candidate — corrections included — then passes the vet
 * against the COMPLETE agent contract before it can become active; failures
 * are quarantined (human-authored) or rejected (model-authored), never
 * silently injected. Stored entries whose recorded contract hash is missing
 * (legacy) or stale (the contract changed) are re-vetted in the same pass and
 * re-stamped or quarantined.
 *
 * Returns a {@link LearningOutcome} describing the result (including failures)
 * so the caller can surface a marker in the session log. A failure — e.g. the
 * helper LLM call being rejected — is reported as `status: 'failed'` rather than
 * being swallowed, which previously made learning look like a silent no-op.
 */
export async function extractLearnings(options: ExtractLearningsOptions): Promise<LearningOutcome> {
  const { event, agentInstructions, agentModel, agentFilePath, config } = options;

  const capture = config.capture;
  // Skip if capture is not enabled (shouldn't happen, but safety check)
  if (!capture) return { status: 'none', source: 'auto', count: 0, titles: [] };

  const reviews = options.reviews ?? [];
  const hadReviews = reviews.length > 0;
  const model = config.model ?? agentModel;
  const currentHash = hashInstructions(agentInstructions);

  const spinner = ora({
    text: 'Extracting learnings...',
    stream: process.stderr,
    spinner: {
      interval: 120,
      frames: ['⋮', '⋰', '⋯', '⋱']
    },
  }).start();

  try {
    const store = LearningStore.fromAgentFile(agentFilePath, options.stateRoot, event.agent.name);
    const stored = await store.load();

    const cap = effectiveCap(config);

    // The evaluator and the vet get the WHOLE active set, not just the slice
    // that fit the injection cap: they are asked to reconcile, and they cannot
    // reconcile against rules they were never shown.
    const active = activeLearnings(stored);
    // Only rules vetted against the CURRENT contract are authorities for the
    // duplicate/contradiction checks; stale ones are themselves re-vetted below.
    const currentRules = active.filter((l) => !isStaleAgainst(currentHash, l.instructionsHash));

    // ---- Gather candidates per channel -------------------------------------
    const drafts: LearningDraft[] = [];
    const channelOf = new Map<string, LearningChannel>();
    const collect = (list: LearningDraft[], fallback: LearningChannel) => {
      for (const d of list) {
        d.channel = d.channel ?? fallback;
        channelOf.set(d.id, d.channel);
        drafts.push(d);
      }
    };

    const freeformAgent = capture.agent;
    const freeformCustom = capture.custom;

    // corrections + custom share one evaluator call (they already did as one
    // pass, and one helper call per run is the cost ceiling capture aims for).
    // The call is skipped outright when it would have nothing to do: no
    // reviewer comments and no free-form opt-in.
    if (hadReviews || freeformCustom !== undefined) {
      const evaluated = await evaluateExecution({
        event,
        agentInstructions,
        model,
        freeform: freeformCustom !== undefined ? { guidance: freeformCustom } : false,
        existingLearnings: active,
        reviews,
        capacity: { cap },
      });
      collect(evaluated, 'custom'); // evaluator stamps corrections/custom itself
    }

    // Replacement evaluator agent: free-form candidates only; corrections stay
    // on the built-in path above — the one channel that cannot manufacture
    // policy must not depend on a user-supplied agent behaving.
    if (freeformAgent !== undefined) {
      const { captureViaAgent } = await import('./capture-agent.js');
      const agentDrafts = await captureViaAgent({
        event,
        captureAgentPath: freeformAgent,
        agentFilePath,
        projectContext: { projectRoot: options.stateRoot, stateRoot: options.stateRoot, cwd: process.cwd() },
        existingLearnings: active,
        reviews,
        cap,
      });
      collect(agentDrafts, 'agent');
    }

    // Typed channel: structurally verified in code, no model judgment. These
    // skip the model vet — they capture mechanics, not policy.
    const typedDrafts: LearningDraft[] = [];
    if (capture.addons.includes('tool-errors')) {
      const now = new Date().toISOString();
      for (const recovery of detectToolErrorRecoveries(event.result.toolCallTraces)) {
        typedDrafts.push(toolErrorDraft(recovery, now));
      }
    }

    // ---- Vet ----------------------------------------------------------------
    const counts: Partial<Record<LearningChannel, ChannelCounts>> = {};
    const countFor = (channel: LearningChannel): ChannelCounts => {
      counts[channel] ??= { captured: 0, vettedOut: 0, quarantined: 0 };
      return counts[channel]!;
    };

    const vetted: LearningDraft[] = [];
    if (drafts.length > 0) {
      // Grounding applies only to model-authored candidates; a human wrote
      // every corrections entry, which is grounding the trace cannot overrule.
      const groundedIds = new Set(drafts.filter((d) => d.channel !== 'corrections').map((d) => d.id));
      let verdicts = new Map<string, VetVerdict>();
      let vetFailed = false;
      try {
        verdicts = await vetCandidates({
          drafts,
          agentInstructions,
          activeRules: currentRules,
          traceSummary: renderRunEvidence(event),
          groundedIds,
          model,
        });
      } catch (error) {
        vetFailed = true;
        logger.warn(`[Learning] Vet call failed (${(error as Error).message}); keeping human corrections unvetted, dropping observation candidates.`);
      }

      for (const draft of drafts) {
        const channel = channelOf.get(draft.id)!;
        const verdict = verdicts.get(draft.id);
        const humanAuthored = channel === 'corrections';
        if (!verdict) {
          // No verdict (vet failed or the model skipped it): fail OPEN for
          // human corrections — dropping human input silently is never allowed
          // — and fail CLOSED for observation capture, whose entire safety
          // case is the vet.
          if (humanAuthored) vetted.push(draft);
          else if (vetFailed) countFor(channel).vettedOut += 1;
          else { countFor(channel).vettedOut += 1; }
          continue;
        }
        if (verdict.verdict === 'pass') {
          vetted.push(draft);
          continue;
        }
        if (verdict.verdict === 'contradiction' || humanAuthored) {
          // Quarantine, don't drop silently: contradictions always, and every
          // non-pass verdict on a human correction.
          draft.state = 'quarantined';
          draft.quarantineReason = describeVetFailure(verdict);
          vetted.push(draft);
          countFor(channel).quarantined += 1;
          continue;
        }
        // duplicate/ungrounded model-authored candidates: rejected. Nothing is
        // lost — a duplicate already exists, an ungrounded claim never happened.
        countFor(channel).vettedOut += 1;
        logger.debug(`[Learning] Vetted out (${verdict.verdict}) [${channel}] ${draft.title}: ${describeVetFailure(verdict)}`);
      }
    }
    vetted.push(...typedDrafts);

    // ---- Stamp provenance and store ----------------------------------------
    for (const draft of vetted) {
      draft.instructionsHash = currentHash;
      if (options.sessionId) draft.sessionId = options.sessionId;
    }

    const { inserted, escalated, retired, refused, quarantined, overCap } = await store.addOrEscalate(
      vetted,
      { cap },
    );
    const persisted = [...inserted, ...escalated];
    for (const l of persisted) countFor((l.channel ?? 'custom') as LearningChannel).captured += 1;

    // ---- Re-vet stored entries the contract has moved out from under --------
    // Legacy entries (no hash) and stale ones (hash mismatch) are checked
    // against the current contract: passes are re-stamped, failures quarantined
    // with the reason — never deleted. This is also what backfills the hash on
    // a pre-0.18 store the first time capture runs after upgrade.
    let requarantined = 0;
    const needsRevet = activeLearnings(stored).filter(
      (l) => l.instructionsHash === undefined || isStaleAgainst(currentHash, l.instructionsHash),
    );
    if (needsRevet.length > 0) {
      try {
        const revetVerdicts = await vetCandidates({
          drafts: needsRevet as LearningDraft[],
          agentInstructions,
          activeRules: currentRules.filter((l) => !needsRevet.includes(l)),
          model,
        });
        const passed: string[] = [];
        const failures: { id: string; reason: string }[] = [];
        for (const entry of needsRevet) {
          const verdict = revetVerdicts.get(entry.id);
          // No verdict → keep as-is, unstamped; it will be re-vetted next pass.
          if (!verdict) continue;
          if (verdict.verdict === 'pass') passed.push(entry.id);
          else failures.push({ id: entry.id, reason: describeVetFailure(verdict) });
        }
        const applied = await store.applyRevet({ passed, quarantined: failures, instructionsHash: currentHash });
        requarantined = applied.quarantined.length;
        if (applied.stamped.length > 0 || requarantined > 0) {
          logger.info(`[Learning] Re-vetted ${needsRevet.length} stored rule(s) against the current instructions: ${applied.stamped.length} confirmed, ${requarantined} quarantined.`);
        }
      } catch (error) {
        logger.debug(`[Learning] Re-vet of stored rules failed, left unstamped: ${(error as Error).message}`);
      }
    }

    const quarantinedTotal = quarantined.length + requarantined;

    // Report what landed, not what the evaluator proposed. Counts come from the
    // store's answer, so the session marker never claims "Learned 2 lessons"
    // when nothing was written.
    if (persisted.length === 0 && quarantinedTotal === 0) {
      spinner.succeed('No new learnings extracted');
      if (refused.length > 0) {
        logger.debug(`[Learning] ${refused.length} auto learning(s) refused: rule set full at ${cap}`);
      }
      return {
        status: 'none', source: hadReviews ? 'approval' : 'auto', count: 0, titles: [],
        ...(drafts.length > 0 || typedDrafts.length > 0 ? { channels: counts } : {}),
      };
    }

    const reasserted = escalated.length > 0 ? `, ${escalated.length} re-asserted` : '';
    const madeRoom = retired.length > 0 ? `, ${retired.length} retired to stay under ${cap}` : '';
    const setAside = quarantinedTotal > 0 ? `, ${quarantinedTotal} quarantined` : '';
    if (persisted.length > 0) {
      spinner.succeed(`Extracted ${persisted.length} learning(s)${reasserted}${madeRoom}${setAside} → ${store.filePath}`);
    } else {
      spinner.succeed(`No new learnings kept${setAside} → ${store.filePath}`);
    }
    if (refused.length > 0) {
      logger.debug(`[Learning] ${refused.length} auto learning(s) refused: rule set full at ${cap}`);
    }
    for (const q of quarantined) {
      logger.warn(`[Learning] Quarantined "${q.title}": ${q.quarantineReason ?? 'failed the vet'}`);
    }

    // Say it at the moment it matters. The user has just corrected the agent and
    // reasonably believes the correction took; if the set is over cap it may not
    // have. A count of what is being ignored, not a scolding about file hygiene.
    warnIfCorrectionsAreIgnored(overCap, cap, agentFilePath);
    // A run can yield both reviewer-sourced and execution-sourced learnings;
    // label the marker by the higher-signal source when any is present.
    const source = persisted.some(l => l.source === 'approval') ? 'approval' : 'auto';
    return {
      status: persisted.length > 0 ? 'captured' : 'none',
      source,
      count: persisted.length,
      titles: persisted.map(l => l.title),
      channels: counts,
      quarantined: quarantinedTotal,
    };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    spinner.fail('Failed to extract learnings');
    logger.debug(`[Learning] Error: ${detail}`);
    return { status: 'failed', source: hadReviews ? 'approval' : 'auto', count: 0, titles: [], detail };
  }
}

/**
 * Say, at the moment a human has just corrected the agent, that the correction
 * did not reach it.
 *
 * A full set is supposed to absorb a correction by folding it into an existing
 * rule, which keeps the set at its size. This fires only when that did not
 * happen: the capture model returned a correction without naming a rule to fold
 * it into, and there was no auto-extracted rule left to trade away. The
 * correction was kept rather than dropped, but it landed outside the cap, and
 * rules outside the cap are never injected.
 *
 * So this is not a nag about file hygiene, and it is not routine. It means a
 * specific correction is sitting there having no effect, and the one thing that
 * reliably fixes it is folding the set down by hand.
 *
 * `logger.warn` mirrors into the session log sink, so the same line reaches both
 * the terminal and the serve session view without a second call site.
 */
function warnIfCorrectionsAreIgnored(overCap: number, cap: number, agentFilePath: string): void {
  if (overCap <= 0) return;
  logger.warn(
    `${overCap} correction(s) sit outside this agent's ${cap}-rule limit and do NOT reach it — `
    + `they could not be folded into an existing rule, and no auto-extracted rule was left to trade away. `
    + `Fold the set down: agentuse learnings tidy ${agentFilePath}`
  );
}

function manualLearningTitle(instruction: string): string {
  const firstLine = instruction.split('\n').find(line => line.trim().length > 0)?.trim() ?? '';
  if (!firstLine) return 'Manual rule';
  const chars = Array.from(firstLine); // code points, not UTF-16 units
  return chars.length > 80 ? `${chars.slice(0, 77).join('').trim()}...` : firstLine;
}

export async function saveManualLearning(options: {
  agentFilePath: string;
  /** The agent file's own project root, which decides where the corrections
   *  file lives. See {@link ExtractLearningsOptions.stateRoot}. */
  stateRoot: string;
  instruction: string;
  /** Agent model used to distill the note into a grounded additional
   *  instruction. Omit to store the note verbatim. */
  model?: string | undefined;
  /** Agent instructions — the note becomes an extension of these. */
  agentInstructions?: string | undefined;
  /** A compact transcript of what the agent did this run (its output + tool
   *  calls), so the instruction is grounded in the run the reviewer saw. */
  sessionTranscript?: string | undefined;
  /** Session the rule was added from (absent for agent-level rules). */
  sessionId?: string | undefined;
  /** How many rules this agent keeps. When the set is full, the note has to
   *  replace one rather than grow the set past the cap — the same contract
   *  capture follows. Omit to leave the note unbounded (legacy callers). */
  cap?: number | undefined;
}): Promise<LearningOutcome> {
  const raw = options.instruction.trim();
  if (!raw) {
    return { status: 'none', source: 'manual', count: 0, titles: [] };
  }

  const store = LearningStore.fromAgentFile(options.agentFilePath, options.stateRoot);

  // Turn the note into a grounded additional instruction, using the agent's own
  // instructions + what it did this run + the already-saved instructions. Any
  // model or parse failure falls back to storing the note verbatim — an explicit
  // human instruction must never be dropped because a helper LLM call hiccuped.
  let category: LearningCategory = 'tip';
  let title = manualLearningTitle(raw);
  let instruction = raw;
  let supersedes: string | undefined;
  if (options.model) {
    try {
      // The ACTIVE set, with ids, so the note can be reconciled against it
      // rather than merely deduped — and the cap, so a full set forces the fold.
      // This path is the one people reach for when they are correcting an
      // earlier note of their own, which makes it the last place a
      // "do not duplicate" test belongs.
      const existing = activeLearnings(await store.load());
      const refined = await refineManualLearning(raw, options.model, {
        agentInstructions: options.agentInstructions,
        sessionTranscript: options.sessionTranscript,
        existing,
        cap: options.cap,
      });
      if (refined) {
        category = refined.category;
        title = manualLearningTitle(refined.title);
        instruction = refined.instruction;
        supersedes = refined.supersedes;
      }
    } catch (error) {
      logger.debug(`[Learning] Manual refine failed, storing verbatim: ${(error as Error).message}`);
    }
  }

  const draft: LearningDraft = {
    id: generateLearningId(),
    category,
    title,
    instruction,
    confidence: 1,
    injectedCount: 0,
    extractedAt: new Date().toISOString(),
    source: 'manual',
    channel: 'corrections',
    // Stamped only when the caller could supply the contract; a rule stored
    // without it loads as legacy and is backfilled on the next capture/tidy.
    ...(options.agentInstructions ? { instructionsHash: hashInstructions(options.agentInstructions) } : {}),
    ...(options.sessionId ? { sessionId: options.sessionId } : {}),
    reasserted: 0,
    approvedRuns: 0,
    ...(supersedes ? { supersedes } : {}),
  };

  // The corrections vet, manual-add flavor: a human note can still conflict
  // with a newer contract, in which case it is quarantined with the conflict
  // named rather than silently injected. Any vet failure falls back to storing
  // the note active — an explicit human instruction is never dropped because a
  // helper LLM call hiccuped.
  if (options.model && options.agentInstructions) {
    try {
      const existing = activeLearnings(await store.load()).filter((l) => l.id !== supersedes);
      const verdicts = await vetCandidates({
        drafts: [draft],
        agentInstructions: options.agentInstructions,
        activeRules: existing,
        model: options.model,
      });
      const verdict = verdicts.get(draft.id);
      if (verdict && verdict.verdict === 'contradiction') {
        draft.state = 'quarantined';
        draft.quarantineReason = describeVetFailure(verdict);
      }
    } catch (error) {
      logger.debug(`[Learning] Manual vet failed, storing active: ${(error as Error).message}`);
    }
  }

  if (draft.state === 'quarantined') {
    await store.addOrEscalate([draft]);
    logger.warn(`[Learning] Saved but quarantined "${title}": ${draft.quarantineReason}. It will not be injected; resolve the conflict in ${options.agentFilePath} or discard the rule.`);
    return { status: 'captured', source: 'manual', count: 1, titles: [title], quarantined: 1 };
  }

  const { graduated, retired } = await store.upsertManual(draft);

  // Name what this note replaced. A fold is the right outcome, but it is still
  // one of the reviewer's own rules being archived, so it is said out loud
  // rather than shown as a count.
  for (const l of retired) {
    logger.info(`[Learning] Replaced an earlier rule: "${l.title}" (archived, id:${l.id})`);
  }

  // A permanent rule is the agent file's to change, not this path's.
  //
  // This used to reprint the whole block from the store whenever a note matched
  // a graduated rule, which is what silently reverted anything a human had
  // edited between the markers. Permanent rules no longer live in the store at
  // all, so there is nothing here to reprint from — the note is stored as a new
  // staged rule, and the reviewer is told where the rule it collides with
  // actually lives. Tidy is what reconciles the two, with the file as its input.
  if (graduated) {
    logger.info(
      `[Learning] Saved, but a rule about this is already permanent in ${options.agentFilePath}. `
      + `Edit it there, or run: agentuse learnings tidy ${options.agentFilePath}`
    );
  }

  return { status: 'captured', source: 'manual', count: 1, titles: [title] };
}

/**
 * Render a learning capture outcome (or persisted learning marker) into a
 * one-line title + message for the session log. Shared by the CLI session view
 * and the serve web log so both read identically.
 */
export function describeLearningOutcome(o: {
  status: 'captured' | 'none' | 'failed';
  source: LearningSource;
  count: number;
  titles?: string[] | undefined;
  detail?: string | undefined;
  quarantined?: number | undefined;
}): { title: string; message: string } {
  const sourceLabel = o.source === 'manual'
    ? 'from manual rule'
    : o.source === 'approval'
      ? 'from reviewer comment'
      : 'from this run';
  const setAside = o.quarantined ? `; ${o.quarantined} quarantined` : '';
  if (o.status === 'failed') {
    return {
      title: 'Learning capture failed',
      message: o.detail ? `${o.detail} (${sourceLabel})` : `Capture error (${sourceLabel})`,
    };
  }
  if (o.status === 'none') {
    return { title: 'No new learnings', message: `${sourceLabel}${setAside}` };
  }
  const titles = o.titles && o.titles.length > 0 ? `: ${o.titles.join('; ')}` : '';
  return {
    title: `Learned ${o.count} ${o.count === 1 ? 'lesson' : 'lessons'}`,
    message: `${sourceLabel}${titles}${setAside}`,
  };
}

export { LearningStore, resolveLearningFilePath, generateLearningId, strandedLearningsFile } from './store';
export { applyLearningMigration, deleteMigrationSource, findAgentFiles, findOrphanedLearningFiles, legacyLearningFilePath, planLearningMigration } from './migrate';
export type { MigrationEntry, MigrationStatus } from './migrate';
export { MAX_INJECTED_LEARNINGS, activeLearnings, effectiveCap, learningSourceRank, partitionLearnings, rankLearnings } from './ranking';
export { LEARNED_BLOCK_START, LEARNED_BLOCK_END, renderLearnedBlock, spliceLearnedBlock, writeLearnedBlock } from './graduate';
export { consolidateLearnings, describeConsolidation, isGraduationEligible, undoConsolidation, readTidyRecord, writeTidyRecord, clearTidyRecord } from './consolidate';
export type { ConsolidationResult, ConsolidationChange, PermanentConflict, TidyProgress, TidyRecord } from './consolidate';
export type { ApprovalReview, CanonicalCaptureConfig, CaptureAddon, ChannelCounts, Learning, LearningChannel, LearningConfig, LearningDraft, LearningOutcome, LearningSource, LearningState } from './types';
export { LearningConfigSchema, legacyLearningConfigNotices } from './types';
export { hashInstructions, isStaleAgainst, splitInstructions } from './contract';
export { vetCandidates, describeVetFailure } from './vet';
export type { VetVerdict } from './vet';
export { detectToolErrorRecoveries, failureSignature, toolErrorDraft } from './tool-errors';
