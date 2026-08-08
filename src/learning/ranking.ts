import type { Learning, LearningConfig, LearningSource } from './types';

/**
 * How many rules an agent keeps — and therefore how many are injected per run.
 *
 * One number, deliberately, on both sides of the boundary. When the store could
 * grow without limit while injection took the top 10, the difference was not a
 * safety margin, it was a silent failure mode: rules accumulated that no run
 * ever saw, nothing ever compared them against each other, and an agent could
 * hold two corrections that could not both be satisfied without anything
 * noticing. Capture now enforces this at write time
 * ({@link LearningStore.addOrEscalate}), so the set stays small enough that
 * every rule in it has been weighed against every other.
 *
 * {@link partitionLearnings} still reports the split, because a store written
 * before the cap existed can be over it, and the excess must be visible rather
 * than silently truncated.
 */
export const MAX_INJECTED_LEARNINGS = 15;

/**
 * The cap actually in force for an agent: `learning.max` when set, otherwise
 * {@link MAX_INJECTED_LEARNINGS}.
 *
 * Everything that partitions, reports, or tidies must ask for the cap here
 * rather than reading the constant, or a raised cap silently disagrees with
 * itself: the run injects 25 while `doctor` and the tidy-up still plan for 10.
 */
export function effectiveCap(config?: LearningConfig | undefined): number {
  return config?.max ?? MAX_INJECTED_LEARNINGS;
}

/** Entries eligible for injection. Graduated rules already apply through the
 *  agent file; retired ones are archived. Neither competes for a cap slot. */
export function activeLearnings(learnings: Learning[]): Learning[] {
  return learnings.filter((l) => (l.state ?? 'active') === 'active');
}

/** Lower rank = more authority. Explicit human rules outrank captured ones. */
export function learningSourceRank(source: LearningSource): number {
  return source === 'manual' ? 0 : source === 'approval' ? 1 : 2;
}

/** Milliseconds for ordering. Unparseable or absent dates sort oldest. */
function timeOf(learning: Learning): number {
  const parsed = Date.parse(learning.extractedAt);
  return Number.isNaN(parsed) ? 0 : parsed;
}

/**
 * Order learnings by authority, then recency.
 *
 * `confidence` used to sit between the two, and it was the model's own guess at
 * capture time, never revised afterwards. Measured across a 22-agent fleet, 81%
 * of it landed on three round numbers (0.85, 0.95, 0.80) — a model picking a
 * plausible-looking figure, not a measurement. Ordering the rules that reach an
 * agent by that number meant guesswork decided which corrections applied, so it
 * is gone from the comparison. It survives only as a capture-time filter, where
 * a self-assessment is at least being used to discard the model's own weakest
 * output rather than to rank a human's corrections.
 *
 * The recency comparison is load-bearing, not a cosmetic tiebreak. Without it
 * the comparator returns 0 across a whole source tier and the stable sort falls
 * back to file order, which is insertion order, which is oldest first. Combined
 * with the injection cap that made starvation permanent: an agent observed with
 * 26 reviewer corrections applied the same 6 on every run for two months while
 * the other 20 never reached the model once, no matter how recently a human had
 * asserted them.
 *
 * Ordering newest-first means a fresh correction (or a re-asserted one, whose
 * `extractedAt` is refreshed by {@link LearningStore.addOrEscalate}) displaces
 * the oldest rule of equal authority instead of queueing behind it forever.
 */
export function rankLearnings(learnings: Learning[]): Learning[] {
  return learnings
    .map((learning, index) => ({ learning, index }))
    .sort((a, b) => {
      const bySource = learningSourceRank(a.learning.source) - learningSourceRank(b.learning.source);
      if (bySource !== 0) return bySource;
      const byRecency = timeOf(b.learning) - timeOf(a.learning);
      if (byRecency !== 0) return byRecency;
      // Dates are persisted to day precision, so same-day entries tie here.
      // Later in the file is the more recent write, so it wins.
      return b.index - a.index;
    })
    .map(({ learning }) => learning);
}

/**
 * Split stored learnings into the ones the next run will actually inject and the
 * ones the cap leaves out.
 *
 * `dormant` entries are stored, counted, and shown in the UI while having no
 * effect on behaviour. Two callers need to know the difference: the run banner
 * (so "N applied" doesn't imply the whole file is in force) and the capture
 * evaluator (so a reviewer re-asserting a dormant rule isn't dismissed as a
 * duplicate of something the agent never saw).
 *
 * Graduated and retired entries are excluded from BOTH buckets: they are not
 * injected, and counting them as dormant would report an agent whose rules all
 * live in its own instructions as the worst-starved agent in the fleet.
 */
export function partitionLearnings(
  learnings: Learning[],
  max: number = MAX_INJECTED_LEARNINGS,
): { injected: Learning[]; dormant: Learning[] } {
  const ranked = rankLearnings(activeLearnings(learnings));
  return { injected: ranked.slice(0, max), dormant: ranked.slice(max) };
}
