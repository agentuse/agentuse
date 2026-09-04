import type { SessionRow } from '../lib/api';
import { formatApprovalTime, formatRelativeTime, displayStatusLabel, runTone } from '../lib/format';
import { formatApproximateDuration } from '../../../../utils/duration';

/** Run-health visuals shared by the agents list and the schedules page. */

/**
 * "Last run" health cell: status dot + relative time, linking to the session.
 * A live session gets the pulsing dot; ended states carry their label so the
 * signal never rides on color alone.
 */
export function LastRunCell({ session }: { session: SessionRow | undefined }) {
  if (!session) return <span class="muted">—</span>;
  const label = displayStatusLabel(session.status, session.errorCode);
  const tone = runTone(session.status);
  const at = session.updatedAt || session.createdAt;
  const text = tone === 'running' ? 'running now'
    : tone === 'ok' ? formatRelativeTime(at)
      : tone === 'waiting' ? `waiting · ${formatRelativeTime(at)}`
        : `${label} · ${formatRelativeTime(at)}`;
  return (
    <a
      class={`lastrun ${tone}`}
      href={`/sessions/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(session.project)}`}
      title={`${label} · ${formatApprovalTime(at)}`}
      // Narrow screens hide the text and leave only the aria-hidden dot, so
      // the name must not depend on the link's subtree.
      aria-label={`Last run ${text}`}
    >
      <span class={`lastrun-dot ${tone}`} aria-hidden="true"></span>
      <span class="lastrun-text">{text}</span>
    </a>
  );
}

const RUNSPARK_LIMIT = 12;
const RUNSPARK_MAX_PX = 16;

/**
 * Per-agent run history strip: one bar per recent run, oldest first, height by
 * duration and color by outcome. Supplementary to the last-run text beside it,
 * so per-bar detail stays on hover; the aggregate lives in the aria-label.
 */
export function RunHistorySpark({ runs, limit = RUNSPARK_LIMIT }: { runs: SessionRow[]; limit?: number }) {
  if (runs.length === 0) return null;
  const shown = runs.slice(0, limit).reverse();
  const durations = shown.map((s) => Math.max(0, (s.updatedAt || s.createdAt) - s.createdAt));
  const max = Math.max(1, ...durations);
  const failed = shown.filter((s) => runTone(s.status) === 'failed').length;
  return (
    <span
      class="runspark"
      role="img"
      aria-label={`Last ${shown.length} run${shown.length === 1 ? '' : 's'}${failed > 0 ? `, ${failed} failed` : ''}`}
    >
      {shown.map((s, i) => (
        <span
          key={s.sessionId}
          class={`runspark-bar ${runTone(s.status)}`}
          style={{ height: `${Math.max(3, Math.round((durations[i]! / max) * RUNSPARK_MAX_PX))}px` }}
          title={`${displayStatusLabel(s.status, s.errorCode)} · ${formatRelativeTime(s.createdAt)} · ${formatApproximateDuration(durations[i]!)}`}
        ></span>
      ))}
    </span>
  );
}

