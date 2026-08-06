import { useEffect, useRef, useState } from 'preact/hooks';
import { noAutofill } from '../lib/form';
import {
  fetchSessionLearnings,
  addSessionLearning,
  discardSessionLearning,
  fetchAgentLearnings,
  addAgentLearning,
  discardAgentLearning,
  type SessionLearning,
  type SessionLearningsPayload,
  type SessionLearningSource,
  type LearningSummary,
  type TidyResult,
  type TidyRemaining,
} from '../lib/api';
import { learningsTidyHref } from '../lib/links';
import { formatRelativeTime } from '../lib/format';
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

/**
 * Colourless unified-diff rendering: +/- lines carry the meaning.
 *
 * The `---`/`+++` header inside `diff` is rendered verbatim, so whatever the
 * server labelled the diff with ends up in the DOM of a page any gate link can
 * reach. It is kept — a diff copied out of here should still say what it is —
 * but that is why the server labels these `learnings file` and a
 * project-relative agent path rather than absolute paths from its own disk.
 */
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
 * Why the file is still over the cap.
 *
 * What used to stand here was one line: "Still 20 over the cap. Tidy up again to
 * keep going." That was the whole of what a user got after waiting a minute —
 * press it again, no reason, no idea how many more presses were coming. Now that
 * a press keeps going until it stops paying, ending over the cap usually means
 * the rest have EARNED their place, so this says which rule kept each of them.
 *
 * The last line answers the question people actually ask, which is not "why is
 * it still 30" but "why did none of them become permanent".
 */
export function TidyRemainingView({ remaining }: { remaining: TidyRemaining }) {
  const over = remaining.active - remaining.cap;
  return (
    <div class="learnings-tidy-remaining">
      <p class="learnings-note">
        {remaining.moreToDo
          ? `Still ${over} over the cap, and there is more it can do — tidy up again to keep going.`
          : `Still ${over} over the cap, and that is as far as tidying up can take it. The rest are still there for a reason:`}
      </p>
      {remaining.reasons.length > 0 && (
        <ul class="learnings-list">
          {remaining.reasons.map((reason) => (
            <li class="learnings-item" key={reason.because}>
              <span class="learnings-text">{reason.count} {reason.because}</span>
            </li>
          ))}
        </ul>
      )}
      {remaining.graduationWait && <p class="learnings-note">{remaining.graduationWait}</p>}
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
export function TidyResultView(props: { result: TidyResult; onUndo: () => void; undoing: boolean; undone?: boolean }) {
  const r = props.result;
  if (!r.ran) return <p class="learnings-empty">Nothing to tidy up — every learning reaches this agent.</p>;
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
      {r.remaining
        ? <TidyRemainingView remaining={r.remaining} />
        : r.activeAfter > r.cap && (
          // Older results, replayed from the record on disk, carry no breakdown.
          <p class="learnings-note">
            Still {r.activeAfter - r.cap} over the cap. Tidy up again to keep going.
          </p>
        )}
      {r.diffs.learnings && <DiffBlock label="learnings file" diff={r.diffs.learnings} />}
      {r.diffs.agentFile && <DiffBlock label="agent file" diff={r.diffs.agentFile} />}
      {r.undoId && !props.undone && (
        <button type="button" class="learnings-undo" disabled={props.undoing} onClick={props.onUndo}>
          {props.undoing ? 'Undoing…' : 'Undo'}
        </button>
      )}
    </div>
  );
}

/**
 * Learnings sitting at the pre-0.17 location, where nothing reads them.
 *
 * Above everything else in the panel, and shown whether or not the list below is
 * empty. Both states mislead on their own: an empty panel reads as a new agent
 * rather than a stranded one, and a populated panel reads as healthy while the
 * bulk of the agent's history sits one directory away.
 *
 * The fix is a terminal command, so this cannot offer a button. Naming the file
 * and the exact command is the most a browser page can honestly do.
 */
export function StrandedLearningsBanner(props: { strandedAt: string | null }) {
  if (!props.strandedAt) return null;
  return (
    <div class="learnings-banner is-stranded" role="status">
      <span class="learnings-banner-text">
        Older learnings for this agent are still at their previous location and are no longer
        read: <code>{props.strandedAt}</code>. Move them with{' '}
        <code>agentuse learnings migrate</code>.
      </span>
    </div>
  );
}

/**
 * The line above the list, and the way to act on it.
 *
 * Two states, never both: corrections are being ignored, or they are not. The
 * warning carries the button, because a page that states the problem and leaves
 * the fix somewhere else is how the problem goes unfixed.
 */
export function LearningsHeadline(props: {
  summary: LearningSummary | null;
  tidyTarget: { project: string; runPath: string } | null;
  runningTidy: { jobId: string } | null;
}) {
  const { summary, tidyTarget, runningTidy } = props;
  if (!summary) return null;

  // A fact, not a scolding. The number is what makes it credible: the reviewer
  // believes their corrections took effect, and this is the only place that
  // says how many did not.
  if (summary.dormant > 0) {
    return (
      <div class="learnings-banner">
        <span class="learnings-banner-text">
          {summary.dormant} of this agent's learnings never reach it — only the top {summary.cap} apply per run.
        </span>
        {/* A link, not a submit: the run takes minutes and belongs on a page
            with a URL, not inside a panel the user may navigate away from. */}
        {tidyTarget && (
          <a
            class="learnings-tidy-start"
            href={learningsTidyHref(tidyTarget.project, tidyTarget.runPath,
              runningTidy ? { job: runningTidy.jobId } : { start: true })}
          >
            {runningTidy ? (<><span class="btn-spinner" aria-hidden="true" />Tidying up…</>) : 'Tidy up'}
          </a>
        )}
      </div>
    );
  }

  if (summary.active > 0) {
    return (
      <div class="learnings-summary">
        {summary.injected} of {summary.active} apply per run
        {summary.graduated > 0 && ` · ${summary.graduated} permanent in the agent file`}
      </div>
    );
  }
  return null;
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
  /** Take the stranded-learnings path and render the warning yourself, higher up
   *  the page. Passed by hosts that keep this panel behind a tab, where a banner
   *  inside it would only be seen by someone who already went looking. */
  hoistStranded?: (strandedAt: string | null) => void;
}) {
  const [learnings, setLearnings] = useState<SessionLearning[] | null>(null);
  const [summary, setSummary] = useState<LearningSummary | null>(null);
  // Which agent a press would rewrite. Comes from the response rather than from
  // props: the session panel and the agent panel then offer the same button on
  // the same terms, and neither can name a file the server would not act on.
  const [tidyTarget, setTidyTarget] = useState<{ project: string; runPath: string } | null>(null);
  const [lastTidy, setLastTidy] = useState<{ jobId: string; finishedAt: number } | null>(null);
  const [runningTidy, setRunningTidy] = useState<{ jobId: string } | null>(null);
  const [strandedAt, setStrandedAt] = useState<string | null>(null);
  // The rules fold away; the counts and warnings above them do not.
  const [listOpen, setListOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const absorb = (payload: SessionLearningsPayload) => {
    setLearnings(payload.learnings);
    setSummary(payload.summary ?? null);
    setTidyTarget(payload.tidyTarget ?? null);
    setLastTidy(payload.lastTidy ?? null);
    setRunningTidy(payload.runningTidy ?? null);
    setStrandedAt(payload.strandedAt ?? null);
    props.hoistStranded?.(payload.strandedAt ?? null);
  };

  useEffect(() => {
    if (props.hidden || learnings !== null) return;
    props.fetchList()
      .then(absorb)
      .catch((err) => setError((err as Error).message));
  }, [props.hidden]);

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

  /**
   * Nothing to report: no rules here, no rules over the cap, nothing stranded,
   * no tidy-up to undo.
   *
   * A panel in this state was a bordered box saying only that it had nothing to
   * say — pure furniture on a page someone opened to read a run. It collapses to
   * the bare "add" affordance instead. Not removed entirely: adding the FIRST
   * learning to an agent has to start somewhere, and this is the only place in
   * the web UI it can.
   */
  const nothingToReport =
    learnings !== null &&
    !error &&
    !listOpen &&
    items.length === 0 &&
    !strandedAt &&
    !lastTidy &&
    (summary === null || summary.active === 0);

  if (nothingToReport) {
    return (
      <div class="learnings-panel is-bare" id={props.id}>
        <button type="button" class="learnings-disclosure" aria-expanded={false} onClick={() => setListOpen(true)}>
          <span class="learnings-disclosure-caret" aria-hidden="true">▸</span>
          Add a learning
        </button>
      </div>
    );
  }

  return (
    <div class="learnings-panel" id={props.id}>
      {props.label !== null && <div class="learnings-label">{props.label}</div>}

      {/* Never inside the collapsed part. The whole reason this panel is no
          longer behind a toggle is that its warnings were unreachable, and a
          warning one click away from being seen is a warning nobody sees. */}
      {!props.hoistStranded && <StrandedLearningsBanner strandedAt={strandedAt} />}

      <LearningsHeadline summary={summary} tidyTarget={tidyTarget} runningTidy={runningTidy} />

      {/* The last tidy-up rewrote this agent's own file. Whoever comes back to
          this page is the one who might want that undone, so the way back to it
          has to be here and not only in the tab that ran it. */}
      {lastTidy && tidyTarget && (
        <p class="learnings-note">
          Tidied up {formatRelativeTime(lastTidy.finishedAt)} —{' '}
          <a href={learningsTidyHref(tidyTarget.project, tidyTarget.runPath, { job: lastTidy.jobId })}>
            see what changed or undo it
          </a>
        </p>
      )}

      {error && <p class="learnings-error">{error}</p>}
      {learnings === null && !error && <Loading wrapClass="learnings-empty" label="Loading learnings…" />}
      {learnings !== null && items.length === 0 && (
        <p class="learnings-empty">{props.emptyText}</p>
      )}

      {/* The rules themselves, and the box for writing another, fold away. The
          counts and warnings above do not: those are what someone who opened
          this page for another reason needs to see without asking for it. */}
      {learnings !== null && (items.length > 0 || listOpen) && (
        <button
          type="button"
          class="learnings-disclosure"
          aria-expanded={listOpen}
          onClick={() => setListOpen((v) => !v)}
        >
          <span class="learnings-disclosure-caret" aria-hidden="true">{listOpen ? '▾' : '▸'}</span>
          {listOpen
            ? 'Hide learnings'
            : `Show ${items.length} ${items.length === 1 ? 'learning' : 'learnings'}`}
        </button>
      )}
      {!listOpen && learnings !== null && items.length === 0 && !nothingToReport && (
        <button type="button" class="learnings-disclosure" aria-expanded={false} onClick={() => setListOpen(true)}>
          <span class="learnings-disclosure-caret" aria-hidden="true">▸</span>
          Add a learning
        </button>
      )}

      {listOpen && grouped.map((g) => (
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
                    aria-label="Discard this learning"
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
      <div class="learnings-add" hidden={!listOpen}>
        <textarea
          ref={inputRef}
          class="learnings-add-input"
          placeholder="add a learning for future runs…"
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
            'Add learning'
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
 *
 * The list is this session's; the banner above it and its Tidy up button are
 * about the whole store. That mix is on purpose. The reviewer reading this page
 * is the one who just corrected the agent, and if the store is over the cap
 * their correction will not reach it — telling them here and making them go
 * find the agent page to act on it is how the warning went unread.
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
      label="learnings from this session"
      emptyText="Nothing learned in this session — add one to steer future runs."
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
export function AgentLearningsPanel(props: {
  project: string;
  runPath: string;
  hoistStranded?: (strandedAt: string | null) => void;
}) {
  return (
    <LearningsSection
      label={null}
      emptyText="No learnings yet — add one to steer future runs."
      fetchList={() => fetchAgentLearnings(props.project, props.runPath)}
      addRule={(instruction) => addAgentLearning(props.project, props.runPath, instruction)}
      discardRule={(id) => discardAgentLearning(props.project, props.runPath, id)}
      {...(props.hoistStranded ? { hoistStranded: props.hoistStranded } : {})}
    />
  );
}
