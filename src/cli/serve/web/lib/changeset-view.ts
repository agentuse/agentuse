/**
 * Pure view helpers for the changeset review page.
 *
 * A changeset is a set of files, so the first job of the page is to say which
 * of them the reviewer actually has to think about. Agents come first, the
 * files those agents reference come second, and anything the model touched that
 * no agent in the set references is called out last: that is the group where a
 * surprise lives.
 */
import type { ChangesetFile, ChangesetProposal, ChangesetRecord } from '../../../../agents/changeset-types';
import { revisionLineDiff } from './revision-diff';
import { agentDetailHref } from './links';

/** Accept closes the review and returns to the session or agent it came from. */
export function changesetAcceptedHref(
  changeset: Pick<ChangesetRecord, 'projectId' | 'originSessionId' | 'target'>,
  originHref?: string,
): string {
  if (changeset.originSessionId) {
    return originHref ?? `/sessions/${encodeURIComponent(changeset.originSessionId)}?${new URLSearchParams({ project: changeset.projectId })}`;
  }
  if (changeset.target?.path) return agentDetailHref(changeset.projectId, changeset.target.path);
  return '/';
}

/** Each proposal stores the explanation separately from its short next action.
 * Keep that explanation in the conversation, before the advice it supports. */
export function changesetExchangeTurns(
  changeset: Pick<ChangesetRecord, 'exchange' | 'proposals'>,
): ChangesetRecord['exchange'] {
  let proposalIndex = 0;
  return (changeset.exchange ?? []).map((turn) => {
    if (turn.reply === undefined) return turn;
    const proposal = changeset.proposals[proposalIndex++];
    // Never attach another turn's diagnosis to a historical or partial record.
    if (!proposal || proposal.reply !== turn.reply || proposal.request !== turn.request) return turn;
    const diagnosis = proposal.diagnosis?.trim();
    const reply = turn.reply.trim();
    if (!diagnosis || reply.includes(diagnosis)) return turn;
    return { ...turn, reply: reply ? `${diagnosis}\n\n${reply}` : diagnosis };
  });
}

/** The validator's wording for a file no agent in the changeset references. */
export const CHANGESET_UNREFERENCED_FLAG = 'not referenced by any agent in this changeset';

/** Support files the review treats as runnable code rather than data. */
export const CHANGESET_SCRIPT_EXTENSIONS: readonly string[] = ['.py', '.ts', '.js', '.sh', '.rb'];

export type ChangesetFileGroupId = 'agents' | 'referenced' | 'other';

export interface ChangesetFileGroup<T> {
  id: ChangesetFileGroupId;
  label: string;
  files: T[];
}

const GROUP_LABELS: Record<ChangesetFileGroupId, string> = {
  agents: 'Agents',
  referenced: 'Files agents reference',
  other: 'Other project files',
};

/** Which of the three lists a file belongs in. */
export function changesetFileGroup(file: Pick<ChangesetFile, 'kind' | 'flags'>): ChangesetFileGroupId {
  if (file.kind === 'agent') return 'agents';
  return file.flags?.includes(CHANGESET_UNREFERENCED_FLAG) ? 'other' : 'referenced';
}

/** The file list, in review order. Empty groups are dropped. */
export function changesetFileGroups<T extends Pick<ChangesetFile, 'kind' | 'flags'>>(
  files: readonly T[],
): ChangesetFileGroup<T>[] {
  const order: ChangesetFileGroupId[] = ['agents', 'referenced', 'other'];
  return order
    .map((id) => ({ id, label: GROUP_LABELS[id], files: files.filter((file) => changesetFileGroup(file) === id) }))
    .filter((group) => group.files.length > 0);
}

export interface ChangesetDiffStat {
  added: number;
  removed: number;
}

/**
 * `+n/−n` for one file. The server-computed unified patch is the truth when it
 * is there; a summary row that carries neither patch nor content has nothing to
 * count, and an added file with content only counts as all-new.
 */
export function changesetDiffStat(
  file: Pick<ChangesetFile, 'patch' | 'content'> & Partial<Pick<ChangesetFile, 'op'>>,
): ChangesetDiffStat | null {
  if (file.patch) {
    let added = 0;
    let removed = 0;
    for (const line of file.patch.split('\n')) {
      if (line.startsWith('+++') || line.startsWith('---')) continue;
      if (line.startsWith('+')) added += 1;
      else if (line.startsWith('-')) removed += 1;
    }
    return { added, removed };
  }
  if (typeof file.content !== 'string') return null;
  const lines = revisionLineDiff('', file.content);
  return {
    added: lines.filter((line) => line.kind === 'add').length,
    removed: lines.filter((line) => line.kind === 'remove').length,
  };
}

export function isChangesetScript(file: Pick<ChangesetFile, 'kind' | 'path'>): boolean {
  if (file.kind !== 'support') return false;
  const dot = file.path.lastIndexOf('.');
  if (dot < 0) return false;
  return CHANGESET_SCRIPT_EXTENSIONS.includes(file.path.slice(dot).toLowerCase());
}

/**
 * A proposal carrying a runnable script has to be read before it is run: the
 * test run executes that script, so the Test run button waits until the
 * reviewer has opened at least one file.
 */
export function changesetNeedsFileReview(
  proposal: Pick<ChangesetProposal, 'files'> | undefined,
): boolean {
  return Boolean(proposal?.files.some(isChangesetScript));
}

/**
 * Render the server's unified patch with the same line kinds the draft diff
 * uses, so one component paints both a stored patch and a locally computed one.
 */
export function patchDiffLines(patch: string): ReturnType<typeof revisionLineDiff> {
  const lines: ReturnType<typeof revisionLineDiff> = [];
  for (const raw of patch.split('\n')) {
    if (raw.startsWith('+++') || raw.startsWith('---') || raw.startsWith('diff ') || raw.startsWith('index ')) continue;
    if (raw.startsWith('@@')) lines.push({ kind: 'meta', text: raw });
    else if (raw.startsWith('+')) lines.push({ kind: 'add', text: raw.slice(1) });
    else if (raw.startsWith('-')) lines.push({ kind: 'remove', text: raw.slice(1) });
    else if (raw.startsWith(' ')) lines.push({ kind: 'same', text: raw.slice(1) });
    else if (raw.length > 0) lines.push({ kind: 'meta', text: raw });
  }
  return lines;
}

/** Canonical review URL for a changeset. */
export function changesetReviewHref(projectId: string, sessionId: string, token?: string): string {
  const path = `/projects/${encodeURIComponent(projectId)}/changesets/${encodeURIComponent(sessionId)}`;
  return token ? `${path}?token=${encodeURIComponent(token)}` : path;
}
