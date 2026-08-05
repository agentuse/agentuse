import { useEffect, useRef, useState } from 'preact/hooks';
import { noAutofill } from '../lib/form';
import {
  fetchSessionLearnings,
  addSessionLearning,
  discardSessionLearning,
  fetchAgentLearnings,
  addAgentLearning,
  discardAgentLearning,
  tidyAgentLearnings,
  undoAgentLearningsTidy,
  type SessionLearning,
  type SessionLearningsPayload,
  type SessionLearningSource,
  type LearningSummary,
  type TidyResult,
} from '../lib/api';
import { Loading } from './loading';

// Grouped by provenance, manual first (highest-signal, human-authored), then
// promoted comments, then auto-extracted — mirrors injection ranking.
const GROUPS: { source: SessionLearningSource; label: string }[] = [
  { source: 'manual', label: 'Manually added' },
  { source: 'approval', label: 'From comments' },
  { source: 'auto', label: 'From auto-evaluation' },
];

/**
 * What this rule is actually doing, in the reviewer's terms.
 *
 * The panel used to show instruction text alone, so a reviewer adding rule 51
 * had no way to learn that it would never reach the agent. The badge is the
 * whole point of the row.
 */
export function statusBadge(learning: SessionLearning): { label: string; kind: string } | null {
  if (learning.state === 'graduated') return { label: 'in agent file', kind: 'graduated' };
  if (learning.state === 'retired') return { label: 'retired', kind: 'retired' };
  if (learning.injected === true) return { label: 'applied', kind: 'applied' };
  if (learning.injected === false) return { label: 'never reaches the agent', kind: 'dormant' };
  return null; // older server with no status in the payload: say nothing rather than guess
}

/** Colourless unified-diff rendering: +/- lines carry the meaning. */
function DiffBlock(props: { label: string; diff: string }) {
  return (
    <div class="learnings-diff">
      <div class="learnings-diff-label">{props.label}</div>
      <pre class="learnings-diff-body">
        {props.diff.split('\n').map((line, i) => (
          <div
            key={i}
            class={`learnings-diff-line${
              line.startsWith('+') && !line.startsWith('+++') ? ' is-add'
                : line.startsWith('-') && !line.startsWith('---') ? ' is-del'
                : line.startsWith('@@') ? ' is-hunk' : ''
            }`}
          >
            {line || ' '}
          </div>
        ))}
      </pre>
    </div>
  );
}

/**
 * What just happened, after the fact.
 *
 * We apply first and show the result rather than asking for approval on a
 * twenty-item plan: reviewing that plan is a chore and the reviewer has no basis
 * to judge most of it. The rules that became PERMANENT are named individually
 * because that is the only part of a tidy-up that edits a file the user owns —
 * and both diffs are shown, since the change lands in two files and showing one
 * would hide half of it.
 */
export function TidyResultView(props: { result: TidyResult; onUndo: () => void; undoing: boolean }) {
  const r = props.result;
  if (!r.ran) return <p class="learnings-empty">Nothing to tidy up — every correction reaches this agent.</p>;
  // `note` doubles as a partial-failure warning alongside real changes, so it
  // only replaces the result when there is nothing else to show.
  if (r.note && r.changes.length === 0) return <p class="learnings-error">{r.note}</p>;

  const parts: string[] = [];
  if (r.merged > 0) parts.push(`${r.merged} merged`);
  if (r.rewritten > 0) parts.push(`${r.rewritten} rewritten`);
  if (r.retired > 0) parts.push(`${r.retired} retired`);
  if (r.graduated.length > 0) parts.push(`${r.graduated.length} now permanent`);

  return (
    <div class="learnings-tidy-result">
      <div class="learnings-tidy-summary">
        {parts.length > 0 ? parts.join(', ') : 'Nothing safe to change'}
        {' — '}
        {r.activeBefore} → {r.activeAfter} in force
      </div>
      {r.graduated.length > 0 && (
        <div class="learnings-tidy-permanent">
          <div class="learnings-group-label">Now permanent in the agent file</div>
          <ul class="learnings-list">
            {r.graduated.map((title) => <li class="learnings-item" key={title}>{title}</li>)}
          </ul>
        </div>
      )}
      {r.graduationSkipped && (
        <p class="learnings-note">Rules were not made permanent: {r.graduationSkipped}</p>
      )}
      {r.note && <p class="learnings-note">{r.note}</p>}
      {r.activeAfter > r.cap && (
        <p class="learnings-note">
          Still {r.activeAfter - r.cap} over the cap. Tidy up again to keep going.
        </p>
      )}
      {r.diffs.learnings && <DiffBlock label="corrections file" diff={r.diffs.learnings} />}
      {r.diffs.agentFile && <DiffBlock label="agent file" diff={r.diffs.agentFile} />}
      {r.undoId && (
        <button type="button" class="learnings-undo" disabled={props.undoing} onClick={props.onUndo}>
          {props.undoing ? 'Undoing…' : 'Undo'}
        </button>
      )}
    </div>
  );
}

/**
 * Shared learnings list + add/discard editor. The two wrappers below bind it to
 * the session-scoped endpoints (only that session's captures) and the
 * agent-scoped endpoints (the full store).
 */
function LearningsSection(props: {
  hidden?: boolean;
  /** DOM id for the panel root, so a toggle button can reference it via aria-controls. */
  id?: string;
  /** Panel heading; pass null when the surrounding page already labels the section. */
  label: string | null;
  emptyText: string;
  fetchList: () => Promise<SessionLearningsPayload>;
  addRule: (instruction: string) => Promise<SessionLearningsPayload>;
  discardRule: (id: string) => Promise<SessionLearningsPayload>;
  /** Agent-scoped only: the session view shows one run's captures, and tidying
   *  the whole store from there would edit far more than what is on screen. */
  tidy?: () => Promise<SessionLearningsPayload>;
  undoTidy?: () => Promise<SessionLearningsPayload>;
}) {
  const [learnings, setLearnings] = useState<SessionLearning[] | null>(null);
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  const [tidyResult, setTidyResult] = useState<TidyResult | null>(null);
  const [tidying, setTidying] = useState(false);
  const [undoing, setUndoing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const absorb = (payload: SessionLearningsPayload) => {
    setLearnings(payload.learnings);
    setSummary(payload.summary ?? null);
  };

  useEffect(() => {
    if (props.hidden || learnings !== null) return;
    props.fetchList()
      .then(absorb)
      .catch((err) => setError((err as Error).message));
  }, [props.hidden]);

  const runTidy = async () => {
    if (!props.tidy || tidying) return;
    setTidying(true);
    setError(null);
    try {
      const payload = await props.tidy();
      absorb(payload);
      setTidyResult(payload.tidy ?? null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setTidying(false);
    }
  };

  const runUndo = async () => {
    if (!props.undoTidy || undoing) return;
    setUndoing(true);
    setError(null);
    try {
      absorb(await props.undoTidy());
      setTidyResult(null);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setUndoing(false);
    }
  };

  const add = async () => {
    const instruction = (inputRef.current?.value ?? '').trim();
    if (!instruction) {
      inputRef.current?.focus();
      return;
    }
    if (adding) return;
    setAdding(true);
    setError(null);
    try {
      const payload = await props.addRule(instruction);
      absorb(payload);
      if (inputRef.current) inputRef.current.value = '';
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setAdding(false);
    }
  };

  const discard = async (id: string) => {
    if (busyId) return;
    setBusyId(id);
    setError(null);
    try {
      absorb(await props.discardRule(id));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusyId(null);
    }
  };

  if (props.hidden) return null;

  const items = learnings ?? [];
  const grouped = GROUPS.map((g) => ({ ...g, items: items.filter((l) => l.source === g.source) })).filter(
    (g) => g.items.length > 0,
  );

  return (
    <div class="learnings-panel" id={props.id}>
      {props.label !== null && <div class="learnings-label">{props.label}</div>}

      {/* A fact, not a scolding. The number is what makes it credible: the
          reviewer believes their corrections took effect, and this is the only
          place that says how many did not. */}
      {summary && summary.dormant > 0 && (
        <div class="learnings-banner">
          <span class="learnings-banner-text">
            {summary.dormant} of this agent's corrections never reach it — only the top {summary.cap} apply per run.
          </span>
          {props.tidy && (
            <button type="button" class="primary" disabled={tidying} aria-busy={tidying} onClick={() => void runTidy()}>
              {tidying ? (<><span class="btn-spinner" aria-hidden="true" />Tidying up…</>) : 'Tidy up'}
            </button>
          )}
        </div>
      )}
      {summary && summary.dormant === 0 && summary.active > 0 && (
        <div class="learnings-summary">
          {summary.injected} of {summary.active} apply per run
          {summary.graduated > 0 && ` · ${summary.graduated} permanent in the agent file`}
        </div>
      )}

      {tidyResult && <TidyResultView result={tidyResult} onUndo={() => void runUndo()} undoing={undoing} />}

      {error && <p class="learnings-error">{error}</p>}
      {learnings === null && !error && <Loading wrapClass="learnings-empty" label="Loading learnings…" />}
      {learnings !== null && items.length === 0 && (
        <p class="learnings-empty">{props.emptyText}</p>
      )}
      {grouped.map((g) => (
        <div class="learnings-group" key={g.source}>
          <div class="learnings-group-label">{g.label}</div>
          <ul class="learnings-list">
            {g.items.map((l) => {
              const badge = statusBadge(l);
              return (
                <li class={`learnings-item${badge?.kind === 'dormant' ? ' is-dormant' : ''}`} key={l.id}>
                  <span class="learnings-text">{l.instruction}</span>
                  {badge && <span class={`learnings-badge is-${badge.kind}`}>{badge.label}</span>}
                  <button
                    type="button"
                    class="learnings-discard"
                    aria-label="Discard this instruction"
                    title="Discard"
                    disabled={busyId === l.id}
                    onClick={() => void discard(l.id)}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        </div>
      ))}
      <div class="learnings-add">
        <textarea
          ref={inputRef}
          class="learnings-add-input"
          placeholder="add an instruction for future runs…"
          disabled={adding}
          {...noAutofill}
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void add();
            }
          }}
        />
        <button
          type="button"
          class="primary"
          disabled={adding}
          aria-busy={adding}
          onClick={() => void add()}
        >
          {adding ? (
            <>
              <span class="btn-spinner" aria-hidden="true" />
              Adding…
            </>
          ) : (
            'Add instruction'
          )}
        </button>
      </div>
    </div>
  );
}

/**
 * Ended-session panel: shows only the learnings captured in THIS session (the
 * agent's full store lives on the agent detail page) and lets a reviewer add
 * one more rule (standalone — no resume) or discard any.
 */
export function LearningsPanel(props: {
  hidden: boolean;
  sessionId: string;
  token: string | undefined;
  project?: string;
}) {
  return (
    <LearningsSection
      hidden={props.hidden}
      id="learnings-panel"
      label="learned instructions from this session"
      emptyText="Nothing learned in this session — add an instruction to steer future runs."
      fetchList={() => fetchSessionLearnings(props.sessionId, props.token, props.project)}
      addRule={(instruction) =>
        addSessionLearning(props.sessionId, props.token, {
          instruction,
          ...(props.project ? { project: props.project } : {}),
        })
      }
      discardRule={(id) =>
        discardSessionLearning(props.sessionId, id, props.token, props.project ? { project: props.project } : {})
      }
    />
  );
}

/**
 * Agent-detail panel: the agent's entire learning store across all sessions.
 * Discarding removes the rule for all future runs.
 */
export function AgentLearningsPanel(props: { project: string; runPath: string }) {
  return (
    <LearningsSection
      label={null}
      emptyText="No instructions yet — add one to steer future runs."
      fetchList={() => fetchAgentLearnings(props.project, props.runPath)}
      addRule={(instruction) => addAgentLearning(props.project, props.runPath, instruction)}
      discardRule={(id) => discardAgentLearning(props.project, props.runPath, id)}
      tidy={() => tidyAgentLearnings(props.project, props.runPath)}
      undoTidy={() => undoAgentLearningsTidy(props.project, props.runPath)}
    />
  );
}
