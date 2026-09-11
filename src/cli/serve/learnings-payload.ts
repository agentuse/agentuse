/**
 * The learnings panel's payload: a store's rules with their status, the cap
 * arithmetic behind them, and any tidy-up that ran or is running. Shared by the
 * session-scoped and agent-scoped learning routes. Moved out of serve.ts.
 */
import { LearningStore, effectiveCap, partitionLearnings, readTidyRecord, strandedLearningsFile } from "../../learning";
import type { LearningConfig } from "../../learning";
import { toAgentRunPath } from "./project";
import type { Project } from "./project";
import { runningTidyJobForFile } from "./tidy";

/**
 * Where a tidy-up for this store would run, for the session views.
 *
 * Derived from the file the store was resolved from, never from
 * `approval.agent.runPath`: on a sub-agent session those are different
 * agents, and a button built from the session's own agent would tidy a
 * file other than the one whose rules are on screen. Undefined when the
 * file is not one of the project's loaded agents, which is the same
 * condition under which the agent hub does not exist to run it.
 */
export const sessionTidyTarget = (
  project: Project,
  filePath: string,
): { project: string; runPath: string } | undefined => {
  const runPath = toAgentRunPath(project, filePath);
  return runPath ? { project: project.id, runPath } : undefined;
};
// `forSessionId` narrows the list to learnings captured in that session
// (the session page shows only what the run produced); omit it for the
// agent-level view of the full store.
//
// The payload carries each rule's STATUS, not just its text. Without it
// the panel cannot tell a reviewer that the correction they just left is
// one of the ones past the cap, which is the exact misunderstanding this
// whole surface exists to end.
export const learningListPayload = async (
  store: LearningStore,
  opts: {
    forSessionId?: string;
    config?: LearningConfig | undefined;
    /** Both required to report the last tidy-up. */
    stateRoot?: string;
    agentFilePath?: string;
    /** Where a tidy-up would run. The panel offers the button only when
     *  the server names a target, so the two surfaces cannot disagree
     *  about which file a press would rewrite. */
    tidyTarget?: { project: string; runPath: string } | undefined;
  } = {},
) => {
  const all = await store.load();
  const cap = effectiveCap(opts.config);
  const { injected, dormant } = partitionLearnings(all, cap);
  const injectedIds = new Set(injected.map((l) => l.id));
  // A tidy-up rewrote two files; the offer to undo it has to be
  // reachable from the page the user comes back to, not only from the
  // tab that ran it.
  const record = opts.stateRoot && opts.agentFilePath
    ? await readTidyRecord(opts.stateRoot, opts.agentFilePath)
    : null;
  // A pass takes minutes, longer than anyone waits on one page. Say it
  // is running, or coming back here reads as "nothing happened".
  const inFlight = opts.agentFilePath ? runningTidyJobForFile(opts.agentFilePath) : undefined;
  // Learnings left at the pre-0.17 location beside the agent file. The
  // terminal warns about these and `doctor` reports them; a reviewer who
  // only ever opens the web UI would otherwise see an ordinary-looking
  // panel and never learn that forty rules are sitting one directory
  // away, unread. The path only — the sentence is the panel's to write.
  const strandedAt = opts.stateRoot && opts.agentFilePath
    ? strandedLearningsFile(opts.agentFilePath, opts.stateRoot)
    : null;
  return {
    success: true,
    ...(opts.tidyTarget ? { tidyTarget: opts.tidyTarget } : {}),
    ...(strandedAt ? { strandedAt } : {}),
    ...(inFlight ? { runningTidy: { jobId: inFlight.id } } : {}),
    ...(record ? { lastTidy: { jobId: record.jobId, finishedAt: record.finishedAt } } : {}),
    summary: {
      cap,
      active: injected.length + dormant.length,
      injected: injected.length,
      dormant: dormant.length,
      graduated: all.filter((l) => l.state === 'graduated').length,
      retired: all.filter((l) => l.state === 'retired').length,
      quarantined: all.filter((l) => l.state === 'quarantined').length,
      // Per-channel store counts (retired excluded), so "capture is
      // producing junk" is measurable from the panel, not anecdotal.
      byChannel: all.reduce<Record<string, number>>((acc, l) => {
        if (l.state === 'retired') return acc;
        const channel = l.channel ?? 'legacy';
        acc[channel] = (acc[channel] ?? 0) + 1;
        return acc;
      }, {}),
    },
    learnings: all
      .filter((l) => opts.forSessionId === undefined || l.sessionId === opts.forSessionId)
      .map((l) => ({
        id: l.id,
        category: l.category,
        title: l.title,
        instruction: l.instruction,
        confidence: l.confidence,
        source: l.source,
        extractedAt: l.extractedAt,
        ...(l.sessionId && { sessionId: l.sessionId }),
        state: l.state ?? 'active',
        injectedCount: l.injectedCount,
        ...(l.channel && { channel: l.channel }),
        ...(l.quarantineReason && { quarantineReason: l.quarantineReason }),
        reasserted: l.reasserted,
        approvedRuns: l.approvedRuns,
        injected: injectedIds.has(l.id),
      })),
  };
};
