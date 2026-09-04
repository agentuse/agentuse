import { useMemo, useState } from 'preact/hooks';
import type { SerializedSchedule } from '../../../../scheduler';
import type { SessionRow } from '../lib/api';
import { fetchSchedules, fetchSessions, setAgentSchedulePaused } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { useRunAgent } from '../hooks/use-run-agent';
import { Loading } from '../components/loading';
import { LastRunCell, RunHistorySpark } from '../components/run-health';
import { formatApprovalTime, formatRelativeTime, isRunningStatus, runTone } from '../lib/format';
import { pageTitle } from '../lib/brand';
import { agentDetailHref } from '../lib/links';

type Filter = 'all' | 'attention' | 'running' | 'paused';
type Bucket = 'today' | 'tomorrow' | 'later' | 'paused';

const DAY_MS = 24 * 60 * 60 * 1000;
/** Above this many firings in 24h a schedule paints as a faint dotted band on the strip, not individual runs. */
const DENSE_UPCOMING = 12;
const STRIP_LABELS = 5;
/** Labels closer than this (in % of the strip) would overprint, so only the earlier one is kept. */
const STRIP_LABEL_GAP = 13;
const SPARK_BARS = 6;

function dayLabel(ms: number): string {
  return new Date(ms).toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: '2-digit' });
}
function clockLabel(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
}
function weekdayClock(ms: number): string {
  return `${new Date(ms).toLocaleDateString('en-US', { weekday: 'short' })} ${clockLabel(ms)}`;
}
/** "in 12m", "in 1h 05m", "in 3d 18h": the countdown beside the absolute time. */
export function formatUntil(ms: number, now: number = Date.now()): string {
  const diff = Math.max(0, ms - now);
  const min = Math.round(diff / 60_000);
  if (min < 1) return 'now';
  if (min < 60) return `in ${min}m`;
  const hr = Math.floor(min / 60);
  const rem = min % 60;
  if (hr < 24) return rem ? `in ${hr}h ${String(rem).padStart(2, '0')}m` : `in ${hr}h`;
  const day = Math.floor(hr / 24);
  const remHr = hr % 24;
  return remHr ? `in ${day}d ${remHr}h` : `in ${day}d`;
}
function formatDelay(ms: number): string {
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}m ${String(s).padStart(2, '0')}s` : `${m}m`;
}
function startOfDay(ms: number): number {
  const d = new Date(ms);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}
function bucketFor(schedule: SerializedSchedule, now: number): Bucket {
  if (!schedule.nextRun) return 'paused';
  const next = Date.parse(schedule.nextRun);
  const today = startOfDay(now);
  if (next < today + DAY_MS) return 'today';
  if (next < today + 2 * DAY_MS) return 'tomorrow';
  return 'later';
}

function scheduleKey(s: { projectId: string; agentPath: string }): string {
  return `${s.projectId}::${s.agentPath}`;
}

/**
 * Map each schedule to its recent sessions. A session names its agent by
 * absolute file path; the schedule by project-relative path, so match by
 * suffix inside the same project and keep the longest match when one path
 * is a suffix of another (`x/a.agentuse` vs `a.agentuse`).
 */
export function scheduleRunFinder(schedules: SerializedSchedule[], sessions: SessionRow[]): (s: SerializedSchedule) => SessionRow[] {
  const byProject = new Map<string, SerializedSchedule[]>();
  for (const s of schedules) {
    const list = byProject.get(s.projectId);
    if (list) list.push(s);
    else byProject.set(s.projectId, [s]);
  }
  const runs = new Map<string, SessionRow[]>();
  for (const session of sessions) {
    const filePath = session.agent.filePath;
    if (!filePath) continue;
    let owner: SerializedSchedule | undefined;
    for (const s of byProject.get(session.project) ?? []) {
      if (filePath !== s.agentPath && !filePath.endsWith(`/${s.agentPath}`)) continue;
      if (!owner || s.agentPath.length > owner.agentPath.length) owner = s;
    }
    if (!owner) continue;
    const key = scheduleKey(owner);
    const list = runs.get(key);
    if (list) list.push(session);
    else runs.set(key, [session]);
  }
  for (const list of runs.values()) list.sort((a, b) => b.createdAt - a.createdAt);
  const empty: SessionRow[] = [];
  return (s) => runs.get(scheduleKey(s)) ?? empty;
}

/** A schedule needs attention when its most recent run (session or scheduler record) failed. */
function needsAttention(schedule: SerializedSchedule, last: SessionRow | undefined): boolean {
  if (last) return runTone(last.status) === 'failed';
  return schedule.lastResult ? !schedule.lastResult.success : false;
}

function PlayIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <path d="M5 3.5v9a.75.75 0 0 0 1.14.64l7.25-4.5a.75.75 0 0 0 0-1.28l-7.25-4.5A.75.75 0 0 0 5 3.5Z" />
    </svg>
  );
}
function PauseIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
      <rect x="4" y="3" width="3" height="10" rx="0.8" />
      <rect x="9" y="3" width="3" height="10" rx="0.8" />
    </svg>
  );
}

/**
 * The next-24h load strip: one dot per upcoming firing across every visible
 * schedule, so pile-ups and failing crons show before any row is read.
 * Sub-hourly schedules paint as small faint dots so they do not drown the rest.
 */
function LoadStrip(props: { schedules: SerializedSchedule[]; attention: Set<string>; now: number }) {
  const { schedules, attention, now } = props;
  const pct = (ms: number) => ((ms - now) / DAY_MS) * 100;

  const ticks: { pct: number; label: string }[] = [];
  const first = new Date(now);
  first.setMinutes(0, 0, 0);
  first.setHours(first.getHours() + 1);
  for (let t = first.getTime(); t < now + DAY_MS; t += 60 * 60 * 1000) {
    const hour = new Date(t).getHours();
    if (hour % 3 !== 0) continue;
    ticks.push({ pct: pct(t), label: String(hour).padStart(2, '0') });
  }

  const dots: { pct: number; dense: boolean; failed: boolean; title: string }[] = [];
  const labels: { pct: number; text: string }[] = [];
  const perHour = new Map<number, number>();
  let total = 0;
  for (const s of schedules) {
    const dense = s.upcoming.length > DENSE_UPCOMING;
    const failed = attention.has(s.id);
    const name = s.agentName || s.agentPath;
    for (const iso of s.upcoming) {
      const ms = Date.parse(iso);
      if (!Number.isFinite(ms) || ms < now || ms > now + DAY_MS) continue;
      total += 1;
      const hourKey = Math.floor(ms / (60 * 60 * 1000));
      perHour.set(hourKey, (perHour.get(hourKey) ?? 0) + 1);
      dots.push({ pct: pct(ms), dense, failed, title: `${clockLabel(ms)} · ${name}` });
    }
    if (!dense && s.upcoming.length > 0 && labels.length < STRIP_LABELS) {
      const ms = Date.parse(s.upcoming[0]!);
      const at = pct(ms);
      const clear = at >= STRIP_LABEL_GAP / 2 && at <= 100 - STRIP_LABEL_GAP / 2 && labels.every((l) => Math.abs(l.pct - at) >= STRIP_LABEL_GAP);
      if (Number.isFinite(ms) && ms <= now + DAY_MS && clear) labels.push({ pct: at, text: name });
    }
  }
  let busiest: { hour: number; count: number } | null = null;
  for (const [hour, count] of perHour) {
    if (!busiest || count > busiest.count) busiest = { hour, count };
  }
  const busiestNote = busiest && busiest.count > 1
    ? ` · busiest ${clockLabel(busiest.hour * 60 * 60 * 1000)}–${clockLabel((busiest.hour + 1) * 60 * 60 * 1000)} (${busiest.count} runs)`
    : '';

  return (
    <section class="load-strip surface" aria-label="Runs in the next 24 hours">
      <div class="load-strip-head">
        <span class="load-strip-title">Next 24 hours</span>
        <span class="load-strip-note">{total} run{total === 1 ? '' : 's'}{busiestNote}</span>
        <span class="rule"></span>
        <span class="load-strip-legend" aria-hidden="true">
          <span><i class="dot ok"></i>healthy</span>
          <span><i class="dot failed"></i>last run failed</span>
          <span><i class="dot dense"></i>sub-hourly</span>
        </span>
      </div>
      <div class="load-strip-track">
        <div class="load-strip-axis"></div>
        {ticks.map((t) => (
          <span key={t.label} class="load-strip-tick" style={{ left: `${t.pct}%` }}><b></b><span>{t.label}</span></span>
        ))}
        <span class="load-strip-now" style={{ left: '0%' }}><span>now {clockLabel(now)}</span></span>
        {dots.map((d, i) => (
          <span key={i} class={`load-strip-dot${d.dense ? ' dense' : ''}${d.failed ? ' failed' : ''}`} style={{ left: `${d.pct}%` }} title={d.title}></span>
        ))}
        {labels.map((l) => (
          <span key={l.text} class="load-strip-label" style={{ left: `${l.pct}%` }}>{l.text}</span>
        ))}
      </div>
    </section>
  );
}

function ScheduleRow(props: {
  schedule: SerializedSchedule;
  bucket: Bucket;
  runs: SessionRow[];
  multiProject: boolean;
  now: number;
  onToggled: () => void;
}) {
  const { schedule, bucket, runs, multiProject, now } = props;
  const last = runs[0];
  const paused = schedule.enabled === false || !schedule.nextRun;
  const { run, busy: runBusy, error: runError } = useRunAgent(schedule.agentPath, schedule.projectId);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseError, setPauseError] = useState<string | null>(null);

  const togglePause = async () => {
    if (pauseBusy) return;
    setPauseBusy(true);
    setPauseError(null);
    try {
      await setAgentSchedulePaused(schedule.projectId, schedule.agentPath, !paused);
      props.onToggled();
    } catch (error) {
      setPauseError((error as Error).message);
    } finally {
      setPauseBusy(false);
    }
  };

  const next = schedule.nextRun ? Date.parse(schedule.nextRun) : NaN;
  const stagger = schedule.jitterMs > 0 ? `stagger +${formatDelay(schedule.jitterMs)}` : '';
  const failed = needsAttention(schedule, last);
  const errorText = failed ? (last?.errorMessage || schedule.lastResult?.error || null) : null;
  const failedSessionId = last?.sessionId ?? schedule.lastResult?.sessionId;
  const running = isRunningStatus(last?.status);
  const name = schedule.agentName || schedule.agentPath.replace(/\.agentuse$/, '');

  // Scheduler record as the fallback when no session matched (older runs
  // pruned from the 30-day window, or an agent moved since).
  const fallbackResult = !last && schedule.lastRun
    ? (() => {
      const at = Date.parse(schedule.lastRun);
      const ok = schedule.lastResult ? schedule.lastResult.success : true;
      const text = `${ok ? 'ok' : 'failed'} · ${formatRelativeTime(at)}`;
      const inner = <><span class={`lastrun-dot ${ok ? 'ok' : 'failed'}`} aria-hidden="true"></span><span class="lastrun-text">{text}</span></>;
      return schedule.lastResult?.sessionId
        ? <a class={`lastrun ${ok ? 'ok' : 'failed'}`} href={`/sessions/${encodeURIComponent(schedule.lastResult.sessionId)}`} title={formatApprovalTime(at)}>{inner}</a>
        : <span class={`lastrun ${ok ? 'ok' : 'failed'}`} title={formatApprovalTime(at)}>{inner}</span>;
    })()
    : null;

  return (
    <>
      <div class={`slot${paused ? ' paused' : ''}${failed ? ' attention' : ''}${running ? ' running' : ''}`}>
        <div class="slot-when">
          {paused
            ? <><div class="slot-time dim">—</div><div class="slot-until dim">paused</div></>
            : <>
              <div class="slot-time">{bucket === 'later' ? weekdayClock(next) : clockLabel(next)}</div>
              <div class={`slot-until${next - now < 60 * 60 * 1000 ? ' soon' : ''}`}>{formatUntil(next, now)}</div>
            </>}
        </div>
        <div class="slot-main">
          <a class="slot-agent" href={agentDetailHref(schedule.projectId, schedule.agentPath)}>{name}</a>
          <div class="slot-where">
            {multiProject && <><span class="slot-proj">{schedule.projectId}</span><span class="sep">·</span></>}
            <code>{schedule.agentPath}</code>
          </div>
        </div>
        <div class="slot-cadence">
          <span class={`chip status schedule-pill${paused ? ' is-paused' : ''}`} title={schedule.expression}>{schedule.expression}</span>
          <div class="slot-human" title={`${schedule.human}${stagger ? ` · ${stagger}` : ''} · ${schedule.timezone}`}>
            {schedule.human}
            {stagger && <span class="slot-stagger"> · {stagger}</span>}
          </div>
        </div>
        <div class="slot-runs">{runs.length > 0 ? <RunHistorySpark runs={runs} limit={SPARK_BARS} /> : <span class="muted">—</span>}</div>
        <div class="slot-result">{last ? <LastRunCell session={last} /> : (fallbackResult ?? <span class="muted never">never ran</span>)}</div>
        <div class="slot-actions">
          <button
            type="button"
            class="run-btn"
            disabled={runBusy}
            onClick={() => void run()}
            aria-label="Run now"
            title={runError ?? 'Run this agent now and open its session'}
          >{runBusy ? <span class="btn-spinner" aria-hidden="true" /> : <PlayIcon />}</button>
          <button
            type="button"
            class={`run-btn pause-btn${paused ? ' is-paused' : ''}`}
            disabled={pauseBusy}
            aria-pressed={paused}
            onClick={() => void togglePause()}
            aria-label={paused ? 'Resume schedule' : 'Pause schedule'}
            title={pauseError ?? (paused ? 'Paused · click to resume' : 'Pause this schedule')}
          >{pauseBusy ? <span class="btn-spinner" aria-hidden="true" /> : <PauseIcon />}</button>
        </div>
      </div>
      {failed && (
        <div class="slot-error" role="note">
          <span class="slot-error-text">{errorText ?? 'Last run failed'}</span>
          {failedSessionId && <a class="slot-error-link" href={`/sessions/${encodeURIComponent(failedSessionId)}?project=${encodeURIComponent(schedule.projectId)}`}>Open session</a>}
          <button type="button" class="slot-error-link as-link" disabled={runBusy} onClick={() => void run()}>Retry now</button>
        </div>
      )}
      {pauseError && <div class="slot-error" role="alert"><span class="slot-error-text">{pauseError}</span></div>}
    </>
  );
}

export default function Schedules() {
  useTitle(pageTitle('Schedules'));
  const { data, error, loading, refetch } = useFetch('schedules', () => fetchSchedules(), { refreshMs: 30_000 });
  const sessions = useFetch('schedules-runs', () => fetchSessions({ window: '30d', detail: 'agents' }), { refreshMs: 30_000 });
  const [filter, setFilter] = useState<Filter>('all');
  const [project, setProject] = useState<string>('');

  const now = Date.now();
  const schedules = data?.schedules ?? [];
  const projects = useMemo(() => [...new Set(schedules.map((s) => s.projectId))].sort(), [schedules]);
  const multiProject = projects.length > 1;
  const runsFor = useMemo(() => scheduleRunFinder(schedules, sessions.data?.sessions ?? []), [schedules, sessions.data]);

  const attention = new Set<string>();
  const runningIds = new Set<string>();
  for (const s of schedules) {
    const last = runsFor(s)[0];
    if (needsAttention(s, last)) attention.add(s.id);
    if (isRunningStatus(last?.status)) runningIds.add(s.id);
  }
  const pausedCount = schedules.filter((s) => !s.nextRun).length;

  const scoped = project ? schedules.filter((s) => s.projectId === project) : schedules;
  const visible = scoped.filter((s) => {
    if (filter === 'attention') return attention.has(s.id);
    if (filter === 'running') return runningIds.has(s.id);
    if (filter === 'paused') return !s.nextRun;
    return true;
  });

  const groups: { bucket: Bucket; label: string; list: SerializedSchedule[] }[] = [
    { bucket: 'today', label: `Today · ${dayLabel(now)}`, list: [] },
    { bucket: 'tomorrow', label: `Tomorrow · ${dayLabel(now + DAY_MS)}`, list: [] },
    { bucket: 'later', label: 'Later', list: [] },
    { bucket: 'paused', label: 'Paused', list: [] },
  ];
  for (const s of visible) groups.find((g) => g.bucket === bucketFor(s, now))!.list.push(s);

  // Times render in the viewer's local zone; name it once so a run at "09:00"
  // is not silently misread as the server's or the reader's other timezone.
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;

  const count = (n: number, tone?: string) => <span class={`count${tone ? ` ${tone}` : ''}`}>{n}</span>;
  const segment = (id: Filter, label: string, n: number, tone?: string) => (
    <button type="button" class={`segment${filter === id ? ' active' : ''}`} aria-pressed={filter === id} onClick={() => setFilter(id)}>
      <span>{label}</span>{count(n, tone)}
    </button>
  );

  const lede = data
    ? <>
      {schedules.length} schedule{schedules.length === 1 ? '' : 's'}
      {multiProject && <> across {projects.length} projects</>}
      {attention.size > 0 && <> · <span class="failing">{attention.size} failing</span></>}
      {pausedCount > 0 && <> · {pausedCount} paused</>}
      {' · times in '}<code>{zone}</code>
    </>
    : loading ? 'Loading…' : '';

  return (
    <div class="page-schedules">
      <main>
        <header>
          <div class="header-text">
            <div class="eyebrow">scheduled agents</div>
            <h1>Schedules</h1>
            <p class="lede">{lede}</p>
            {error && <div class="errors" role="alert">Failed to load schedules: {error.message}</div>}
          </div>
          {multiProject && (
            <select class="project-filter" aria-label="Project" value={project} onChange={(e) => setProject((e.currentTarget as HTMLSelectElement).value)}>
              <option value="">All projects</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
        </header>

        {schedules.length > 0 && <LoadStrip schedules={scoped.filter((s) => s.nextRun)} attention={attention} now={now} />}

        {schedules.length > 0 && (
          <div class="segments" role="group" aria-label="Filter schedules">
            {segment('all', 'All', scoped.length)}
            {segment('attention', 'Needs attention', scoped.filter((s) => attention.has(s.id)).length, 'failed')}
            {segment('running', 'Running', scoped.filter((s) => runningIds.has(s.id)).length, 'running')}
            {segment('paused', 'Paused', scoped.filter((s) => !s.nextRun).length, 'dim')}
          </div>
        )}

        {schedules.length > 0
          ? (visible.length > 0
            ? <div class="timetable surface">
              <div class="timetable-head" aria-hidden="true">
                <span>Next run</span><span>Agent</span><span>Cadence</span><span>Runs</span><span>Last result</span><span></span>
              </div>
              {groups.filter((g) => g.list.length > 0).map((g) => (
                <section class="day" key={g.bucket}>
                  <h2 class={`day-title${g.bucket === 'paused' ? ' day-paused' : ''}`}><span>{g.label}</span><span class="count">{g.list.length}</span></h2>
                  {g.list.map((s) => (
                    <ScheduleRow key={s.id} schedule={s} bucket={g.bucket} runs={runsFor(s)} multiProject={multiProject} now={now} onToggled={refetch} />
                  ))}
                </section>
              ))}
            </div>
            : <div class="panel"><div class="empty">Nothing matches this filter.</div></div>)
          : <div class="panel">{loading && !data
            ? <Loading label="Loading schedules…" />
            : <div class="empty">No schedules yet. <a class="empty-action" href="/agents">Open an agent to add one</a></div>}</div>}
        {schedules.length > 0 && (
          <p class="footnote">Stagger is the per-schedule delay added on top of the cron time so agents due on the same minute do not start together.</p>
        )}
      </main>
    </div>
  );
}
