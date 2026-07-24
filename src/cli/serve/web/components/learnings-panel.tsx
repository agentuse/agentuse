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
}) {
  const [learnings, setLearnings] = useState<SessionLearning[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (props.hidden || learnings !== null) return;
    props.fetchList()
      .then((payload) => setLearnings(payload.learnings))
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
      setLearnings(payload.learnings);
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
      const payload = await props.discardRule(id);
      setLearnings(payload.learnings);
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
      {error && <p class="learnings-error">{error}</p>}
      {learnings === null && !error && <Loading wrapClass="learnings-empty" label="Loading learnings…" />}
      {learnings !== null && items.length === 0 && (
        <p class="learnings-empty">{props.emptyText}</p>
      )}
      {grouped.map((g) => (
        <div class="learnings-group" key={g.source}>
          <div class="learnings-group-label">{g.label}</div>
          <ul class="learnings-list">
            {g.items.map((l) => (
              <li class="learnings-item" key={l.id}>
                <span class="learnings-text">{l.instruction}</span>
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
            ))}
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
    />
  );
}
