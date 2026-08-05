import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  fetchAgentLearningsTidy,
  startAgentLearningsTidy,
  undoAgentLearningsTidy,
  type SessionLearningsPayload,
} from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { Loading } from '../components/loading';
import { TidyResultView } from '../components/learnings-panel';
import { agentDetailHref } from './agent-detail';
import { learningsTidyHref } from '../lib/links';
import { pageTitle } from '../lib/brand';

const POLL_MS = 1500;

/** `agents/x/writer.agentuse` → `writer`, for headings. */
function agentName(runPath: string): string {
  return (runPath.split('/').pop() ?? runPath).replace(/\.agentuse$/, '');
}

function formatElapsed(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  const min = Math.floor(total / 60);
  const sec = total % 60;
  return min > 0 ? `${min}m ${sec}s` : `${sec}s`;
}

/**
 * What the tidy-up is doing right now, in the reviewer's terms.
 *
 * The wait is the reason this page exists: a pass over a large corrections file
 * is minutes of model work, and a button that just sits there reads as broken
 * long before it is. Naming the phase, and counting the rules as they are
 * written, is what makes the wait legible instead of merely long.
 */
export function TidyProgressView(props: {
  phase: 'deciding' | 'writing' | 'applying' | 'done';
  step: number;
  total: number;
  elapsedMs: number;
}) {
  const { phase, step, total } = props;
  const label = phase === 'deciding'
    ? 'Reading every correction to see what repeats'
    : phase === 'writing'
      ? total > 0 ? `Rewriting rule ${Math.min(step + 1, total)} of ${total}` : 'Rewriting the merged rules'
      : phase === 'applying'
        ? 'Writing the corrections file and the agent file'
        : 'Finishing up';

  // Deciding is one wide call with no inner milestones, so it holds a nominal
  // third rather than pretending to a position it cannot know. Writing is the
  // long phase and it genuinely counts, so it owns most of the bar.
  const pct = phase === 'deciding' ? 30
    : phase === 'writing' ? (total > 0 ? 30 + Math.round((step / total) * 60) : 40)
    : 95;

  return (
    <div class="tidy-progress">
      <div class="tidy-progress-head">
        <span class="btn-spinner" aria-hidden="true" />
        <span class="tidy-progress-step">{label}</span>
        <span class="tidy-progress-elapsed">{formatElapsed(props.elapsedMs)}</span>
      </div>
      <div
        class="tidy-progress-track"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={pct}
        aria-label="Tidy-up progress"
      >
        <div class="tidy-progress-bar" style={`width:${pct}%`} />
      </div>
      <p class="tidy-progress-hint">
        First it reads every stored correction and decides what says the same thing twice, what to
        sharpen, and what has earned a permanent place in the agent file. Then it writes the
        replacements, several at a time. Leaving this page does not stop it — the result waits here.
      </p>
    </div>
  );
}

/**
 * The tidy-up, start to finish, on a page of its own.
 *
 * Split out of the learnings panel because the run outlives the panel: it takes
 * minutes, and the result is the only thing standing between the user and two
 * silently rewritten files. On a page it has a URL to come back to, and the
 * Undo button is still there when they do.
 */
export default function LearningsTidy() {
  const location = useLocation();
  const project = location.query.project ?? '';
  const runPath = location.query.path ?? '';
  const jobId = location.query.job || undefined;
  const shouldStart = location.query.start === '1';

  const [startError, setStartError] = useState<string | null>(null);
  const [undoing, setUndoing] = useState(false);
  const [undone, setUndone] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  const startedRef = useRef(false);

  useTitle(pageTitle('Agents', agentName(runPath), 'Tidy up'));

  // Start on arrival, so the button that sent us here navigated instantly
  // instead of waiting out the first model call. Safe to double-fire: the
  // server hands back the job already running for this agent rather than
  // starting a competing pass over the same two files.
  useEffect(() => {
    if (!shouldStart || jobId || startedRef.current || !project || !runPath) return;
    startedRef.current = true;
    startAgentLearningsTidy(project, runPath)
      .then((payload) => {
        location.route(learningsTidyHref(project, runPath, { job: payload.job.id }), true);
      })
      .catch((err) => setStartError((err as Error).message));
  }, [project, runPath, jobId, shouldStart]);

  // Polling stops the moment the job leaves `running`, so a finished page is not
  // quietly hammering the daemon while it sits open in a tab.
  const [pollMs, setPollMs] = useState(POLL_MS);
  const { data, error, refetch } = useFetch<SessionLearningsPayload>(
    `tidy:${project}:${runPath}:${jobId ?? ''}`,
    () => fetchAgentLearningsTidy(project, runPath, jobId),
    { refreshMs: pollMs },
  );

  const job = data?.job;
  const running = job?.status === 'running';

  useEffect(() => setPollMs(POLL_MS), [jobId]);
  useEffect(() => {
    if (data) setPollMs(data.job?.status === 'running' ? POLL_MS : 0);
  }, [data]);

  useEffect(() => {
    if (!running) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [running]);

  const runUndo = async () => {
    if (undoing) return;
    setUndoing(true);
    try {
      await undoAgentLearningsTidy(project, runPath);
      setUndone(true);
      refetch();
    } catch (err) {
      setStartError((err as Error).message);
    } finally {
      setUndoing(false);
    }
  };

  const backHref = project && runPath ? agentDetailHref(project, runPath) : '/agents';
  const alreadyUndone = undone || job?.status === 'undone';
  const waiting = (shouldStart && !jobId) || (data === null && !error);

  return (
    <div class="page-agents">
      <Topbar currentPage="agents" right={<span class="session-pill">tidy up <code>{agentName(runPath)}</code></span>} />
      <main>
        <a class="back-link" href={backHref}>Back to agent</a>
        <header>
          <div class="eyebrow">corrections</div>
          <h1>Tidy up {agentName(runPath)}</h1>
          <p class="lede">
            Merge what repeats, sharpen what keeps being re-said, retire what is superseded, and make
            the proven rules a permanent part of the agent file.
          </p>
        </header>

        {startError && <div class="errors">{startError}</div>}
        {error && !data && <div class="errors">Failed to load this tidy-up: {error.message}</div>}

        {waiting && <Loading label="Starting the tidy-up…" />}

        {running && job && (
          <TidyProgressView
            phase={job.phase}
            step={job.step}
            total={job.total}
            elapsedMs={now - job.startedAt}
          />
        )}

        {job?.status === 'error' && (
          <div class="errors">The tidy-up failed: {job.error ?? 'unknown error'}. Nothing was changed.</div>
        )}

        {alreadyUndone && (
          <p class="learnings-note">
            Undone — the corrections file and the agent file are back to exactly how they were.
          </p>
        )}

        {data?.tidy && !running && (
          <TidyResultView
            result={data.tidy}
            onUndo={() => void runUndo()}
            undoing={undoing}
            undone={alreadyUndone}
          />
        )}

        {!waiting && !running && !data?.tidy && job?.status !== 'error' && (
          <p class="empty">
            No tidy-up to show for this agent. Open the <a href={backHref}>agent page</a> to start one.
          </p>
        )}
      </main>
    </div>
  );
}
