/**
 * Entry points into the changeset flow.
 *
 * Every place the dashboard used to start a draft or a revision now starts a
 * changeset, and every one of them needs the same two things: a single
 * instruction string built from whatever brief the surface collected, and a
 * link to the review page. Keeping both here means the create dialog, the
 * discovery cards, the agent page and the session page cannot drift apart, and
 * it gives the flow a testable seam that does not need a DOM.
 */
import { startChangeset, type ChangesetPayload, type ChangesetSummary } from './api';
import type { ChangesetStatus } from '../../../../agents/changeset-types';
import type { ReasoningLevel } from '../../../../model-compatibility';
import { changesetReviewHref } from './changeset-view';

/**
 * What a create surface collected. The changeset endpoint takes one
 * instruction, so the structured fields the old `/api/agents` call carried
 * (name, description, schedule, discovery evidence) are folded into the text
 * the creator reads as its brief.
 */
export interface CreateChangesetBrief {
  objective: string;
  /** Human-facing name the operator or a discovery idea asked for. */
  name?: string;
  description?: string;
  /** Five-field cron a discovery idea proposed. */
  schedule?: string;
  /** Files the discovery idea cited, already joined for display. */
  evidence?: string;
}

/** The brief as one instruction: labelled context first, objective last. */
export function buildCreateInstruction(brief: CreateChangesetBrief): string {
  const context: string[] = [];
  if (brief.name?.trim()) context.push(`Requested name: ${brief.name.trim()}`);
  if (brief.description?.trim()) context.push(`Description: ${brief.description.trim()}`);
  if (brief.schedule?.trim()) context.push(`Requested schedule: ${brief.schedule.trim()}`);
  if (brief.evidence?.trim()) context.push(`Evidence from this project: ${brief.evidence.trim()}`);
  const objective = brief.objective.trim();
  return context.length > 0 ? `${context.join('\n')}\n\n${objective}` : objective;
}

export function startCreateChangeset(
  projectId: string,
  brief: CreateChangesetBrief,
  model: string,
  reasoning?: ReasoningLevel,
): Promise<ChangesetPayload> {
  return startChangeset(projectId, {
    mode: 'create',
    instruction: buildCreateInstruction(brief),
    model: model.trim(),
    ...(reasoning && { reasoning }),
  });
}

export function startReviseChangeset(input: {
  projectId: string;
  /** Project-relative path of the agent being changed. */
  target: string;
  instruction: string;
  model: string;
  reasoning?: ReasoningLevel | undefined;
  /** The run whose transcript is the evidence, when the revise started from one. */
  originSessionId?: string | undefined;
}): Promise<ChangesetPayload> {
  return startChangeset(input.projectId, {
    mode: 'revise',
    instruction: input.instruction.trim(),
    model: input.model,
    ...(input.reasoning && { reasoning: input.reasoning }),
    target: input.target,
    ...(input.originSessionId && { originSessionId: input.originSessionId }),
  });
}

/**
 * Returning to a review page from a link that carries no token still has to
 * work, so the token the start call handed back is kept beside the session id,
 * the same way the revision flow kept its own.
 */
export function rememberChangesetToken(sessionId: string, token: string | undefined): void {
  if (!token) return;
  try {
    localStorage.setItem(`agentuse:changeset-token:${sessionId}`, token);
  } catch { /* persistence only improves return navigation */ }
}

/** Statuses where the operator can still steer a changeset. */
export const ACTIVE_CHANGESET_STATUSES: ReadonlySet<ChangesetStatus> = new Set<ChangesetStatus>([
  'running',
  'proposed',
  'no-change',
]);

/** The authoring turn has ended and the operator now owns the next move. A
 * running changeset is active too, but it belongs under Home's Working now
 * section rather than its review queue. */
export const WAITING_CHANGESET_STATUSES: ReadonlySet<ChangesetStatus> = new Set<ChangesetStatus>([
  'proposed',
  'no-change',
]);

const CHANGESET_LABELS: Record<ChangesetStatus, string> = {
  running: 'Changeset session is running',
  proposed: 'Changes ready to review',
  'no-change': 'Changes need review',
  applying: 'Applying changes',
  applied: 'Changes applied',
  discarded: 'Changes discarded',
  restoring: 'Restoring previous files',
  restored: 'Previous files restored',
  error: 'Changeset stopped',
};

export function changesetStatusLabel(status: ChangesetStatus): string {
  return CHANGESET_LABELS[status] ?? 'Changeset';
}

/** One row of a changeset list, in the shape the revision cards already use. */
export interface ChangesetEntry {
  sessionId: string;
  projectId: string;
  mode: ChangesetSummary['mode'];
  targetAgentName?: string;
  status: ChangesetStatus;
  active: boolean;
  label: string;
  /** The latest proposal's reply, falling back to the instruction that started it. */
  detail: string;
  proposalCount: number;
  /** Files in the latest proposal; 0 until one lands. */
  fileCount: number;
  updatedAt: number;
  href: string;
}

export function changesetEntry(changeset: ChangesetSummary): ChangesetEntry {
  const latest = changeset.proposals[changeset.proposals.length - 1];
  return {
    sessionId: changeset.sessionId,
    projectId: changeset.projectId,
    mode: changeset.mode,
    ...(changeset.target?.name && { targetAgentName: changeset.target.name }),
    status: changeset.status,
    active: ACTIVE_CHANGESET_STATUSES.has(changeset.status),
    label: changesetStatusLabel(changeset.status),
    detail: latest?.reply?.trim() || changeset.instruction,
    proposalCount: changeset.proposals.length,
    fileCount: latest?.files.length ?? 0,
    updatedAt: changeset.updatedAt,
    href: changesetReviewHref(changeset.projectId, changeset.sessionId),
  };
}

/** Newest first, with anything still open pulled to the top. */
export function changesetEntries(changesets: readonly ChangesetSummary[]): ChangesetEntry[] {
  return changesets
    .map(changesetEntry)
    .sort((a, b) => (Number(b.active) - Number(a.active)) || (b.updatedAt - a.updatedAt));
}

/** Changesets whose next action is an operator review, newest first. */
export function waitingChangesetEntries(changesets: readonly ChangesetSummary[]): ChangesetEntry[] {
  return changesetEntries(changesets)
    .filter((entry) => WAITING_CHANGESET_STATUSES.has(entry.status))
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

export function changesetReviewName(entry: Pick<ChangesetEntry, 'mode' | 'targetAgentName'>): string {
  if (entry.mode === 'create') return 'Create agent';
  return entry.targetAgentName ? `Revise ${entry.targetAgentName}` : 'Revise agent';
}

/** `2 files · proposal 3`, the one line that says how big a changeset got. */
export function changesetCountLine(entry: Pick<ChangesetEntry, 'fileCount' | 'proposalCount'>): string {
  const parts: string[] = [];
  if (entry.fileCount > 0) parts.push(`${entry.fileCount} file${entry.fileCount === 1 ? '' : 's'}`);
  if (entry.proposalCount > 1) parts.push(`proposal ${entry.proposalCount}`);
  return parts.join(' · ');
}
