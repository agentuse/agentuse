/**
 * Why a run did not deliver, in a fixed shape every surface can group by.
 *
 * Browser-safe: the serve web bundle imports this, so no node APIs here.
 *
 * An agent that reports `incomplete` names a blocker kind and the thing that is
 * stuck. The kind decides whether the run is an error: a human blocker (waiting
 * on or rejected by a person) means nothing is broken, so the run is incomplete
 * but not failed; every other kind means something must be fixed. Persisted on
 * the session error as `cause` (the kind), `subject`, and `causeSource`.
 */
export const BLOCKER_KINDS = [
  'missing_tool',
  'missing_package',
  'bad_input',
  'no_access',
  'service_down',
  'waiting_on_human',
  'rejected_by_human',
  'other',
] as const;

export type BlockerKind = typeof BLOCKER_KINDS[number];

/**
 * How the blocker was established. `runtime` and `approval` are read from
 * recorded evidence (a tool error, an approval decision); `agent` is the
 * agent's own declaration; `inferred` is a later classification of the agent's
 * free-text reason and is the least trustworthy.
 */
export const BLOCKER_SOURCES = ['runtime', 'approval', 'agent', 'inferred'] as const;
export type BlockerSource = typeof BLOCKER_SOURCES[number];

export interface Blocker {
  kind: BlockerKind;
  subject: string;
  source: BlockerSource;
}

const HUMAN_BLOCKER_KINDS: ReadonlySet<string> = new Set<BlockerKind>(['waiting_on_human', 'rejected_by_human']);

export function isBlockerKind(value: unknown): value is BlockerKind {
  return typeof value === 'string' && (BLOCKER_KINDS as readonly string[]).includes(value);
}

export function isBlockerSource(value: unknown): value is BlockerSource {
  return typeof value === 'string' && (BLOCKER_SOURCES as readonly string[]).includes(value);
}

/** Waiting on or rejected by a person: the run did not deliver, but nothing is broken. */
export function isHumanBlocker(kind: string | undefined): boolean {
  return kind !== undefined && HUMAN_BLOCKER_KINDS.has(kind);
}

/**
 * One spelling per subject, so the same stuck thing groups into one row however
 * an agent quoted it (`birdc`, "`birdc`", ' Birdc ').
 */
export function normalizeBlockerSubject(subject: string): string {
  return subject
    .trim()
    .replace(/^[`'"]+|[`'"]+$/g, '')
    .replace(/\s+/g, ' ')
    .toLowerCase();
}

/** Grouping key: same kind and same subject is one problem. */
export function blockerGroupKey(kind: string, subject: string | undefined): string {
  return `${kind}:${normalizeBlockerSubject(subject ?? '')}`;
}

export const BLOCKER_LABELS: Record<BlockerKind, string> = {
  missing_tool: 'Missing tool',
  missing_package: 'Missing package',
  bad_input: 'Bad input',
  no_access: 'No access',
  service_down: 'Service down',
  waiting_on_human: 'Waiting on a person',
  rejected_by_human: 'Rejected by a person',
  other: 'Blocked',
};
