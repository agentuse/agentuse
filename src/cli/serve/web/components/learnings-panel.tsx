import { useEffect, useRef, useState } from 'preact/hooks';
import {
  fetchSessionLearnings,
  addSessionLearning,
  discardSessionLearning,
  type SessionLearning,
  type SessionLearningSource,
} from '../lib/api';

// Grouped by provenance, manual first (highest-signal, human-authored), then
// promoted comments, then auto-extracted — mirrors injection ranking.
const GROUPS: { source: SessionLearningSource; label: string }[] = [
  { source: 'manual', label: 'Manually added' },
  { source: 'approval', label: 'From comments' },
  { source: 'auto', label: 'From auto-evaluation' },
];

/**
 * Ended-session panel: shows the agent's stored learnings grouped by source and
 * lets a reviewer add one more rule (standalone — no resume) or discard any.
 * Reads/writes the agent's `.learnings.md` via the session learnings endpoints.
 */
export function LearningsPanel(props: {
  hidden: boolean;
  sessionId: string;
  token: string | undefined;
  project?: string;
}) {
  const [learnings, setLearnings] = useState<SessionLearning[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [adding, setAdding] = useState(false);
  const [busyId, setBusyId] = useState<string | null>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (props.hidden || learnings !== null) return;
    fetchSessionLearnings(props.sessionId, props.token, props.project)
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
      const payload = await addSessionLearning(props.sessionId, props.token, {
        instruction,
        ...(props.project ? { project: props.project } : {}),
      });
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
      const payload = await discardSessionLearning(
        props.sessionId,
        id,
        props.token,
        props.project ? { project: props.project } : {},
      );
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
    <div class="learnings-panel">
      <div class="learnings-label">learned instructions</div>
      {error && <p class="learnings-error">{error}</p>}
      {learnings === null && !error && <p class="learnings-empty">Loading…</p>}
      {learnings !== null && items.length === 0 && (
        <p class="learnings-empty">No instructions yet — add one to steer future runs.</p>
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
          onKeyDown={(event) => {
            if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
              event.preventDefault();
              void add();
            }
          }}
        />
        <button type="button" class="primary" disabled={adding} onClick={() => void add()}>
          Add instruction
        </button>
      </div>
    </div>
  );
}
