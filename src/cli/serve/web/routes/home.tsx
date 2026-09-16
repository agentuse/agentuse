import { failureLabel } from '../../../../session/failure-label';
import { useCallback, useEffect, useMemo, useState } from 'preact/hooks';
import type { ApprovalRow, ProjectInfo, SerializedSchedule, SessionRow } from '../lib/api';
import { fetchInfo, fetchAgents, fetchProjectChangesets, fetchSchedules, fetchStoreRows, postSessionStop } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useHomeSections } from '../hooks/use-home-sections';
import { useLiveHome, sessionRowKey, ORPHANED_LABEL, type ActivityEvent } from '../hooks/use-live-home';
import { isAttentionSessionDismissed, useGlobalApprovals } from '../hooks/use-global-approvals';
import { useSessionTail } from '../hooks/use-session-tail';
import { useTitle } from '../hooks/use-title';
import { UpdateBanner } from '../components/update-banner';
import { Loading } from '../components/loading';
import { AgentResultsRows } from '../components/metric-results';
import { waitingSince, PendingApprovalRow, PendingChangesetRow } from '../components/pending-approval-card';
import { displayAgentName, errorText, formatApprovalTime, formatRelativeTime, displayStatusLabel, plural, runTone, type RunTone } from '../lib/format';
import { pageTitle } from '../lib/brand';
import { term } from '../lib/terms';
import { isIncompleteOutcome } from '../../../../session/status';
import { consumeUpdatePreview, previewUpdate } from '../lib/update-preview';
import { InlineError } from '../components/error-banner';
import { formatElapsedClock } from '../lib/format';
import { useNow } from '../hooks/use-now';
import { waitingChangesetEntries, type ChangesetEntry } from '../lib/changeset-entry';
import { sessionDestinationHref } from '../lib/links';

function formatCountdown(ms: number): string {
  if (ms <= 0) return 'now';
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  if (h > 0) return `${h}h ${String(m).padStart(2, '0')}m`;
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

const LIVE_STATUSES = new Set(['running', 'resuming', 'continuing']);

function OnboardingRedirect() {
  useEffect(() => { window.location.replace('/onboarding'); }, []);
  return <Loading label="Opening onboarding…" />;
}

function isLiveRow(row: SessionRow): boolean {
  // A suspended parent parked on a running delegated child is live work ("running
  // · subagent"), so it counts as running even though its raw status is suspended.
  return LIVE_STATUSES.has(row.status) || row.subagentActive === true;
}

function FeedRow(props: { event: ActivityEvent }) {
  const { event } = props;
  return (
    <a class={`feed-row${event.fresh ? ' is-new' : ''}`} href={event.href}>
      <span class={`feed-dot ${event.tone}`} aria-hidden="true"></span>
      <span class="feed-agent">{event.agentName}</span>
      <span class={`feed-label ${event.tone}`}>{event.label}</span>
      <span class="feed-project">{event.project}</span>
      <span class="feed-time" title={formatApprovalTime(event.at)}>{formatRelativeTime(event.at)}</span>
    </a>
  );
}

function RunningRow(props: { row: SessionRow; now: number; ticker: boolean }) {
  const { row, now } = props;
  const href = sessionDestinationHref(row);
  // Live one-line tail of what the agent is doing right now. Capped upstream
  // (`ticker`) so a busy daemon doesn't exhaust the browser's per-host
  // connection budget; capless rows keep the static description.
  const tail = useSessionTail(row.sessionId, row.project, props.ticker);
  return (
    <a class="now-row" href={href}>
      <span class="now-dot" aria-hidden="true"></span>
      <div class="now-body">
        <div class="now-head">
          <span class="now-agent">{displayAgentName(row.agent.name, row.agent.filePath, row.agent.id)}</span>
          <span class="now-meta">{row.project} · {row.trigger}</span>
          {row.subagentActive && <span class="now-subagent" title="Work is running in a delegated subagent">subagent</span>}
        </div>
        {/* Purely visual preview of the session page it links to; hidden from AT
            so the transient fragments never pollute the link's accessible name. */}
        {tail
          ? <div class={tail.tool ? 'now-ticker tool' : 'now-ticker'} aria-hidden="true">
              <span class="now-ticker-line" key={`${tail.tool ?? ''}:${tail.text}`}>{tail.text}</span>
            </div>
          : <div class="now-desc">{row.agent.description || displayStatusLabel(row.status, row.errorCode)}</div>}
      </div>
      <span class="now-elapsed">{formatElapsedClock(now - row.createdAt)}</span>
    </a>
  );
}

/** Owns the 1s elapsed-time clock so the tick re-renders these rows only, not
 *  the whole dashboard. */
function WorkingNow(props: { running: SessionRow[] }) {
  const now = useNow(true);
  return (
    <section class="group">
      <h2 class="group-title"><span>Working now</span><span class="count">{props.running.length}</span><span class="rule"></span></h2>
      <div class="now-grid">
        {props.running.map((row, i) => <RunningRow key={`${row.project}:${row.sessionId}`} row={row} now={now} ticker={i < 3} />)}
      </div>
    </section>
  );
}

export function FailedRow(props: { row: SessionRow; onDismiss: (row: SessionRow) => void; label?: string }) {
  const { row } = props;
  const at = row.updatedAt || row.createdAt;
  const agentName = displayAgentName(row.agent.name, row.agent.filePath, row.agent.id);
  // A declared-incomplete run reads in amber and says WHY it stopped: its code
  // word is already the label, so repeating it as `incomplete · INCOMPLETE`
  // spends the row's one line of detail on nothing.
  const incomplete = isIncompleteOutcome(row.status, row.errorCode);
  const detail = incomplete
    ? errorText(row.errorMessage)
    : (failureLabel(row.errorCause) ?? (errorText(row.errorMessage) || row.errorCode || ''));
  return (
    <a class="attn-run" href={sessionDestinationHref(row)}>
      <span class={`feed-dot ${incomplete ? 'incomplete' : 'failed'}`} aria-hidden="true"></span>
      <span class="attn-agent">{agentName}</span>
      <span class={`attn-fail${incomplete ? ' warn' : ''}`}>
        {props.label ?? displayStatusLabel(row.status, row.errorCode)}
        {!props.label && detail && ` · ${detail}`}
      </span>
      <span class="feed-time" title={formatApprovalTime(at)}>{formatRelativeTime(at)} · review or dismiss →</span>
      <button
        type="button"
        class="attn-dismiss"
        title="Dismiss: mark this run reviewed and clear it from the list (its status is kept)"
        aria-label={`Dismiss ${agentName}`}
        onClick={(event) => {
          // The button lives inside the row link; keep the click from navigating.
          event.preventDefault();
          event.stopPropagation();
          props.onDismiss(row);
        }}
      >
        <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <path d="M18 6 6 18" /><path d="M6 6 18 18" />
        </svg>
      </button>
    </a>
  );
}

/**
 * Clears the whole needs-a-look group in one go. Dismissing stops a run and
 * stamps it reviewed, which the per-row ✕ does one at a time — fine for two
 * rows, a chore for fifteen.
 *
 * It asks first, in place rather than in a dialog: the count is the whole
 * warning, and a mis-click costs a stopped run. While it works the button
 * counts up, so a slow sweep of a long list never looks stuck.
 */
function DismissAll(props: {
  rows: SessionRow[];
  onDismissAll: (rows: SessionRow[], onProgress: (done: number) => void) => Promise<number>;
}) {
  const [armed, setArmed] = useState(false);
  const [done, setDone] = useState<number | null>(null);
  const [failedCount, setFailedCount] = useState(0);
  const total = props.rows.length;
  const busy = done !== null;

  // A row dismissed elsewhere (its own ✕, another tab) shrinks the group under
  // a primed confirm, so the count on the button stops matching what it clears.
  useEffect(() => { if (!busy) setArmed(false); }, [total]);

  if (busy) return <span class="attn-more attn-dismiss-all is-busy">dismissing {done} of {total}…</span>;

  if (!armed) {
    return (
      <>
        {failedCount > 0 && <span class="attn-dismiss-failed">{failedCount} could not be dismissed</span>}
        <button type="button" class="attn-more attn-dismiss-all" onClick={() => { setArmed(true); setFailedCount(0); }}>
          dismiss all {total}
        </button>
      </>
    );
  }

  return (
    <span class="attn-dismiss-confirm">
      <button
        type="button"
        class="attn-more attn-dismiss-all is-armed"
        onClick={() => {
          setArmed(false);
          setDone(0);
          void props.onDismissAll(props.rows, (n) => setDone(n))
            .then((count) => setFailedCount(count))
            .finally(() => setDone(null));
        }}
      >dismiss {total}?</button>
      <button type="button" class="attn-more" onClick={() => setArmed(false)}>cancel</button>
    </span>
  );
}

/** How many needs-a-look rows show before the tail folds away. Pending gates are
 *  never folded: a waiting human is the whole point of the section. */
const ATTENTION_ROWS = 3;

/** How many dismissals are in flight at once during a bulk sweep. */
const DISMISS_ALL_CONCURRENCY = 4;

/** Reviews shown before the tail folds. Twenty-plus open reviews is a real
 * state; the reviewer needs the latest few on screen, not all of them. */
const PENDING_ROWS = 8;

/** Recent-activity rows shown on Home; the full stream lives on /sessions. */
const FEED_LIMIT = 6;

/** What's blocked on a human: pending gates first, then recent failed runs, then
 *  runs stranded on a sub-agent that already ended. A stranded run is raw-status
 *  `suspended`, so it lands in neither of the first two groups — it used to fall
 *  through every home surface and sit invisible for days.
 *  Renders even when empty — "nothing waiting on you" is the answer the
 *  section exists to give. */
function AttentionSection(props: {
  pending: ApprovalRow[];
  changesets: ChangesetEntry[];
  failed: SessionRow[];
  stranded: SessionRow[];
  onDismissFailed: (row: SessionRow) => void;
  onDismissAll: (rows: SessionRow[], onProgress: (done: number) => void) => Promise<number>;
}) {
  const [expanded, setExpanded] = useState(false);
  const [pendingOpen, setPendingOpen] = useState(false);
  const { pending, changesets, failed, stranded } = props;
  const total = pending.length + changesets.length + failed.length + stranded.length;
  const now = useNow(pending.length + changesets.length > 0);
  const orderedReviews = [
    ...pending.map((row) => ({ kind: 'approval' as const, row, at: waitingSince(row) ?? Number.MIN_SAFE_INTEGER })),
    ...changesets.map((row) => ({ kind: 'changeset' as const, row, at: row.updatedAt })),
  ].sort((a, b) => b.at - a.at);
  const shownReviews = pendingOpen ? orderedReviews : orderedReviews.slice(0, PENDING_ROWS);
  const foldedPending = orderedReviews.length - shownReviews.length;
  // Each group keeps its own head, so one long list never buries the other.
  const shownFailed = expanded ? failed : failed.slice(0, ATTENTION_ROWS);
  const shownStranded = expanded ? stranded : stranded.slice(0, ATTENTION_ROWS);
  const folded = (failed.length - shownFailed.length) + (stranded.length - shownStranded.length);
  // Everything the ✕ can clear, folded tail included. Bulk dismissal works on
  // the whole group, not the three rows that happen to be on screen: unfolding
  // fifteen rows to click fifteen ✕s is the chore it exists to remove.
  const reviewable = [...failed, ...stranded];
  return (
    <section class="group">
      <h2 class="group-title">
        <span>Waiting on you</span>
        {total > 0 && <span class="count">{total}</span>}
        <span class="rule"></span>
      </h2>
      {total === 0
        ? <div class="attn-empty">Nothing waiting on you.</div>
        : (
          <div class="attn-list">
            {orderedReviews.length > 0 && (
              <div class="surface appr-surface pending-rows">
                {shownReviews.map((review) => review.kind === 'approval'
                  ? <PendingApprovalRow key={`approval:${review.row.project}:${review.row.sessionId}`} row={review.row} now={now} />
                  : <PendingChangesetRow key={`changeset:${review.row.projectId}:${review.row.sessionId}`} row={review.row} now={now} />)}
                {(foldedPending > 0 || pendingOpen) && (
                  <button type="button" class="attn-more pending-more" onClick={() => setPendingOpen((on) => !on)}>
                    {pendingOpen ? 'show fewer' : `show all ${orderedReviews.length} waiting →`}
                  </button>
                )}
              </div>
            )}
            {(shownFailed.length > 0 || shownStranded.length > 0) && (
              <div class="surface">
                {shownFailed.map((row) => <FailedRow key={`${row.project}:${row.sessionId}`} row={row} onDismiss={props.onDismissFailed} />)}
                {shownStranded.map((row) => (
                  <FailedRow
                    key={`${row.project}:${row.sessionId}`}
                    row={row}
                    label={ORPHANED_LABEL}
                    onDismiss={props.onDismissFailed}
                  />
                ))}
              </div>
            )}
            {(folded > 0 || expanded || reviewable.length > 1) && (
              <div class="attn-actions">
                {(folded > 0 || expanded) && (
                  <button type="button" class="attn-more" onClick={() => setExpanded((on) => !on)}>
                    {expanded ? 'show less' : `show all ${reviewable.length} needing a look →`}
                  </button>
                )}
                {reviewable.length > 1 && <DismissAll rows={reviewable} onDismissAll={props.onDismissAll} />}
              </div>
            )}
          </div>
        )}
    </section>
  );
}

/** One agent's runs in the window, split by outcome. */
interface AgentRuns {
  key: string;
  agentId: string;
  name: string;
  project: string;
  /** Two projects hold an agent by this name, so the row has to say which. */
  ambiguous: boolean;
  total: number;
  counts: Record<RunTone | 'incomplete', number>;
}

/** Bar segments, left to right. Failures sit last so position — not hue alone —
 *  separates them from the waiting segment, the pair that reads closest in
 *  light mode. Running is wedged between the two for the same reason. */
const RUN_TONES: Array<{ tone: RunTone | 'incomplete'; label: string }> = [
  { tone: 'ok', label: 'completed' },
  { tone: 'waiting', label: 'waiting' },
  { tone: 'running', label: 'running' },
  { tone: 'incomplete', label: 'incomplete' },
  { tone: 'failed', label: 'failed' },
];

/** Sessions folded into one row per agent, busiest first. Agents are kept
 *  per-project: two projects can hold different agents under the same name, and
 *  those are the only rows that pay for a project label. */
function tallyRunsByAgent(sessions: SessionRow[]): AgentRuns[] {
  const byAgent = new Map<string, AgentRuns>();
  for (const s of sessions) {
    const agentId = s.agent.id || s.agent.name;
    const key = `${s.project}\0${agentId}`;
    let bar = byAgent.get(key);
    if (!bar) {
      bar = {
        key,
        agentId,
        name: displayAgentName(s.agent.name, s.agent.filePath, s.agent.id),
        project: s.project,
        ambiguous: false,
        total: 0,
        counts: { ok: 0, waiting: 0, running: 0, incomplete: 0, failed: 0 },
      };
      byAgent.set(key, bar);
    }
    bar.counts[isIncompleteOutcome(s.status, s.errorCode) || s.status === 'incomplete' ? 'incomplete' : runTone(s.status)]++;
    bar.total++;
  }
  const bars = [...byAgent.values()];
  const nameCounts = new Map<string, number>();
  for (const bar of bars) nameCounts.set(bar.name, (nameCounts.get(bar.name) ?? 0) + 1);
  for (const bar of bars) bar.ambiguous = (nameCounts.get(bar.name) ?? 0) > 1;
  return bars.sort((a, b) => b.total - a.total || a.name.localeCompare(b.name));
}

/** Most agents fit on screen; past this the tail is summarized, never dropped
 *  silently. */
const TOP_AGENTS = 8;

function RunBarRow(props: { bar: AgentRuns; max: number }) {
  const { bar, max } = props;
  const parts = RUN_TONES.filter((t) => bar.counts[t.tone] > 0);
  const breakdown = parts.map((t) => `${bar.counts[t.tone]} ${t.label}`).join(', ');
  return (
    <a
      class="runbar-row"
      href={`/sessions?agent=${encodeURIComponent(bar.agentId)}&window=24h`}
      aria-label={`${bar.name}${bar.ambiguous ? ` in ${bar.project}` : ''}: ${plural(bar.total, 'run')} · ${breakdown}`}
    >
      <span class="runbar-name" title={`${bar.name} · ${bar.project}`}>
        {bar.name}
        {bar.ambiguous && <span class="runbar-project">{bar.project}</span>}
      </span>
      <span class="runbar-track" aria-hidden="true">
        <span class="runbar-fill" style={{ width: `${(bar.total / max) * 100}%` }}>
          {parts.map((t) => (
            <span
              key={t.tone}
              class={`runbar-seg ${t.tone}`}
              style={{ flexGrow: bar.counts[t.tone] }}
              title={`${bar.counts[t.tone]} ${t.label}`}
            ></span>
          ))}
        </span>
      </span>
      <span class="runbar-count" aria-hidden="true">{bar.total}</span>
    </a>
  );
}

/** Which agents actually ran, and how those runs turned out: one stacked bar per
 *  agent, longest first. The qualitative half of outcome-first Home (the Results
 *  tiles above it are the quantitative half). */
function RunsByAgent(props: { sessions: SessionRow[]; loading: boolean }) {
  const [expanded, setExpanded] = useState(false);
  const all = useMemo(() => tallyRunsByAgent(props.sessions), [props.sessions]);
  const bars = expanded ? all : all.slice(0, TOP_AGENTS);
  // Off the full list, so bar lengths don't rescale when the tail unfolds.
  const max = Math.max(1, ...all.map((b) => b.total));
  const totals = RUN_TONES.map((t) => ({ ...t, n: all.reduce((sum, bar) => sum + bar.counts[t.tone], 0) }))
    .filter((t) => t.n > 0);
  return (
    <section class="group">
      <h2 class="group-title">
        <span>Runs by agent · 24h</span><span class="rule"></span>
        <a class="group-link" href="/sessions">all sessions →</a>
      </h2>
      {bars.length === 0
        ? (props.loading
          ? <Loading label="Loading runs…" />
          : <div class="metric-empty">No runs in the last 24 hours.</div>)
        : (
          <div class="runbar">
            <div class="runbar-rows surface">
              {bars.map((bar) => <RunBarRow key={bar.key} bar={bar} max={max} />)}
            </div>
            <div class="runbar-legend">
              {totals.map((t) => (
                <span class="runbar-key" key={t.tone}>
                  <span class={`runbar-swatch ${t.tone}`} aria-hidden="true"></span>
                  {t.label} <span class="runbar-key-n">{t.n}</span>
                </span>
              ))}
            </div>
            {all.length > TOP_AGENTS && (
              <button type="button" class="runbar-more" onClick={() => setExpanded((on) => !on)}>
                {expanded ? 'show less' : 'show all →'}
              </button>
            )}
          </div>
        )}
    </section>
  );
}

/** "today 2:30 PM", "tomorrow 7:30 AM", then "Monday 9:00 AM". */
function formatUpcoming(at: number, now: number): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  const dayStart = (t: number) => {
    const d = new Date(t);
    return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  };
  const dayDiff = Math.round((dayStart(at) - dayStart(now)) / 86_400_000);
  if (dayDiff <= 0) return `today ${time}`;
  if (dayDiff === 1) return `tomorrow ${time}`;
  return `${date.toLocaleDateString([], { weekday: 'long' })} ${time}`;
}

const COMING_UP_LIMIT = 5;

/** The next few scheduled runs in plain terms; hidden when nothing is scheduled. */
function ComingUp(props: { schedules: SerializedSchedule[] }) {
  const now = Date.now();
  const upcoming = props.schedules
    .filter((s) => s.enabled && s.nextRun)
    .map((s) => ({ s, at: Date.parse(s.nextRun!) }))
    .filter((x) => Number.isFinite(x.at))
    .sort((a, b) => a.at - b.at)
    .slice(0, COMING_UP_LIMIT);
  if (upcoming.length === 0) return null;
  return (
    <section class="group">
      <h2 class="group-title">
        <span>Coming up</span><span class="rule"></span>
        <a class="group-link" href="/schedules">all schedules →</a>
      </h2>
      <div class="panel">
        {upcoming.map(({ s, at }) => (
          <a class="up-row" key={s.id} href="/schedules">
            <span class="up-when" title={formatApprovalTime(at)}>{formatUpcoming(at, now)}</span>
            <span class="up-agent">{displayAgentName(s.agentName, s.agentPath, s.agentPath)}</span>
            <span class="up-cadence">{s.human}</span>
          </a>
        ))}
      </div>
    </section>
  );
}

function ProjectCard(props: { project: ProjectInfo; running: number; failed: number; isDefault: boolean }) {
  const { project, running, failed } = props;
  return (
    <a class={`project-card${running > 0 ? ' is-live' : ''}`} href={`/agents/${encodeURIComponent(project.id)}`} title={`${project.id} · ${project.path}`}>
      <div class="project-card-head">
        <span class={`project-card-dot${running > 0 ? ' on' : ''}`} aria-hidden="true"></span>
        <span class="project-card-name">{project.about?.name ?? project.id}</span>
        {props.isDefault && <span class="proj-default">default</span>}
        <span class="project-card-arrow" aria-hidden="true">→</span>
      </div>
      {project.about?.description && <div class="project-card-desc">{project.about.description}</div>}
      <div class="project-card-stats">
        <span><strong>{project.agentCount}</strong> agent{project.agentCount === 1 ? '' : 's'}</span>
        <span><strong>{project.scheduleCount}</strong> schedule{project.scheduleCount === 1 ? '' : 's'}</span>
        {running > 0 && <span class="project-card-running"><strong>{running}</strong> running</span>}
        {failed > 0 && <span class="project-card-failed"><strong>{failed}</strong> broken</span>}
      </div>
    </a>
  );
}

/** "Wednesday, August 19 · 4:55 PM" — the header's clock line. */
function formatClock(now: number): string {
  const d = new Date(now);
  const day = d.toLocaleDateString([], { weekday: 'long', month: 'long', day: 'numeric' });
  const time = d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  return `${day} · ${time}`;
}

/** The header clock line ticks once a second; isolating it keeps that tick
 *  from re-rendering the whole page. */
function HomeClock() {
  const now = useNow(true);
  return <div class="home-date">{formatClock(now)}</div>;
}

/** "· next run <agent> in 12:34" for the header stat line. Owns its own 1s
 *  clock and the post-fire refetch loop. */
function NextRunStat(props: { nextSchedule: { at: number; agentPath: string }; refetch: () => void }) {
  const now = useNow(true);
  const countdownMs = props.nextSchedule.at - now;
  // When the countdown fires, the schedule's nextRun is stale until the
  // scheduler actually triggers (jitter can hold it past zero); keep
  // refetching every few seconds until nextRun rolls forward so the hero
  // never hangs on a fired schedule.
  const countdownFired = countdownMs <= 0;
  const { refetch } = props;
  useEffect(() => {
    if (!countdownFired) return;
    const timer = setInterval(() => refetch(), 4000);
    return () => clearInterval(timer);
  }, [countdownFired, refetch]);
  return (
    <>
      {' '}· next run <span class="home-stat-agent">{props.nextSchedule.agentPath.replace(/\.agentuse$/, '')}</span>
      {countdownFired
        ? <> <span class="home-countdown">is starting…</span></>
        : <> in <span class="home-countdown">{formatCountdown(countdownMs)}</span></>}
    </>
  );
}

export default function Home() {
  useTitle(pageTitle());
  const [previewRequested] = useState(() => consumeUpdatePreview());
  const { data, error, loading } = useFetch('home', () => fetchInfo(), { refreshMs: 30_000 });
  const liveHome = useLiveHome();
  const attentionState = useGlobalApprovals();
  // The operator's first question is whether anything needs action. Fleet-wide
  // agent parsing and metric-store scans can be materially slower on large
  // installations, so do not let those secondary requests contend with the
  // sessions and approvals snapshots during the critical first paint.
  const primaryReady = data !== null && !liveHome.loading && !attentionState.loading;
  const projects = data?.projects ?? [];
  const changesetProjectIds = projects.map((project) => project.id).sort();
  const changesetReviews = useFetch(
    `home-changesets:${changesetProjectIds.join(',')}`,
    async () => {
      const results = await Promise.all(changesetProjectIds.map(async (projectId) => {
        try {
          const payload = await fetchProjectChangesets(projectId);
          return { rows: waitingChangesetEntries(payload.changesets), error: undefined };
        } catch (error) {
          return { rows: [] as ChangesetEntry[], error: `${projectId}: ${(error as Error).message}` };
        }
      }));
      return {
        rows: results.flatMap((result) => result.rows).sort((a, b) => b.updatedAt - a.updatedAt),
        errors: results.flatMap((result) => result.error ? [result.error] : []),
      };
    },
    { refreshMs: 30_000, enabled: data !== null && changesetProjectIds.length > 0 },
  );
  const pendingChangesets = changesetReviews.data?.rows ?? [];

  // Agent parse failures are counted on their project card, using the same
  // payload as /agents rather than hiding one aggregate warning in the footer.
  const agents = useFetch('home-agents', () => fetchAgents(), { refreshMs: 30_000, enabled: primaryReady });
  const failedAgentsByProject = new Map<string, number>();
  for (const failure of agents.data?.errors ?? []) {
    failedAgentsByProject.set(failure.projectId, (failedAgentsByProject.get(failure.projectId) ?? 0) + 1);
  }

  // Soonest upcoming scheduled run powers the hero countdown; refresh often
  // enough that a fired schedule rolls over to the next one without a reload.
  const schedules = useFetch('home-schedules', () => fetchSchedules(), { refreshMs: 60_000, enabled: primaryReady });
  const nextSchedule = useMemo(() => {
    let best: { at: number; agentPath: string } | null = null;
    for (const s of schedules.data?.schedules ?? []) {
      if (!s.enabled || !s.nextRun) continue;
      const at = Date.parse(s.nextRun);
      if (!Number.isFinite(at)) continue;
      if (!best || at < best.at) best = { at, agentPath: s.agentPath };
    }
    return best;
  }, [schedules.data]);

  // Agent-recorded business metrics (reserved "metrics" store). Missing store
  // is normal and returns empty rows, so the section simply doesn't render.
  const metricRows = useFetch('home-metrics', () => fetchStoreRows('metrics'), { refreshMs: 60_000, enabled: primaryReady });

  const sections = useHomeSections();
  // The guided demo is product education, not fleet activity, so exclude it
  // from operational counts, attention queues, charts, and the activity feed.
  const operationalSessions = useMemo(
    () => liveHome.sessions.filter((session) => session.trigger !== 'onboarding'),
    [liveHome.sessions]
  );
  const running = useMemo(() => operationalSessions.filter(isLiveRow), [operationalSessions]);
  // subagentActive rows are live work (counted in `running`), not blocked on a
  // human, so they must not also show up as waiting.
  const waiting = useMemo(
    () => operationalSessions.filter((s) => s.status === 'suspended' && !s.subagentActive),
    [operationalSessions]
  );
  // Recent failures surface in "Needs your attention" alongside pending gates.
  // Not every failed-tone run is waiting on a human: runs the reviewer stopped
  // themselves (USER_STOPPED) or already reviewed and discarded (dismissedAt,
  // via the session page's Discard button or the row's hover ✕) are
  // acknowledged, so they stay out. The shared app-root dismissal mask hides a
  // just-dismissed row instantly even when Discard happened on another route.
  const dismissRow = useCallback((row: SessionRow): Promise<boolean> => {
    const identity = { project: row.project, sessionId: row.sessionId };
    attentionState.dismissAttentionSession(identity);
    return postSessionStop(row.sessionId, undefined, { project: row.project, reason: 'Discarded from home' })
      .then(() => true)
      .catch(() => {
        // Dismissal did not land; put the row back so it isn't silently lost.
        attentionState.restoreAttentionSession(identity);
        return false;
      });
  }, [attentionState.dismissAttentionSession, attentionState.restoreAttentionSession]);
  const dismissFailed = useCallback((row: SessionRow) => { void dismissRow(row); }, [dismissRow]);
  // Bulk dismissal is the same per-row call, a few at a time: each one stops a
  // session on the daemon, so firing fifty at once would queue behind itself
  // anyway and lose the running count. Returns how many failed, since a partial
  // sweep leaves rows on screen and the reviewer deserves to know why.
  const dismissAll = useCallback(async (rows: SessionRow[], onProgress: (done: number) => void): Promise<number> => {
    let next = 0;
    let done = 0;
    let failures = 0;
    const worker = async (): Promise<void> => {
      while (next < rows.length) {
        const row = rows[next++]!;
        if (!await dismissRow(row)) failures += 1;
        onProgress(++done);
      }
    };
    await Promise.all(Array.from({ length: Math.min(DISMISS_ALL_CONCURRENCY, rows.length) }, worker));
    return failures;
  }, [dismissRow]);
  const dismissedAttention = attentionState.dismissedAttentionSessions;
  // Not truncated here: the section itself folds the tail behind "show all", so
  // the header count is the real number of runs waiting on a review.
  const failedRecent = useMemo(() => operationalSessions
    .filter((s) => runTone(s.status) === 'failed' && s.errorCode !== 'USER_STOPPED' && s.dismissedAt === undefined
      && !isAttentionSessionDismissed(dismissedAttention, s))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)), [operationalSessions, dismissedAttention]);
  // Runs parked on a delegated sub-agent that has since ended. They read as
  // `suspended`, so neither the failed filter above nor the pending-gate list
  // catches them, yet nothing will ever move them: the only way out is a human
  // stopping the run. Dismissing one stops it, which is exactly the fix.
  const orphanedGates = liveHome.suspendedGates.orphaned;
  const strandedRecent = useMemo(() => operationalSessions
    .filter((s) => orphanedGates.has(sessionRowKey(s)) && s.dismissedAt === undefined
      && !isAttentionSessionDismissed(dismissedAttention, s))
    .sort((a, b) => (b.updatedAt || b.createdAt) - (a.updatedAt || a.createdAt)), [operationalSessions, orphanedGates, dismissedAttention]);
  const pendingApprovals = liveHome.pendingApprovals;
  // Suspended rows with no live or expired gate are mid-flight (a delegated
  // leaf running under a decided cascade approval, or a resume in progress),
  // so don't advertise them as blocked on a human.
  const allWaitingResuming = liveHome.suspendedGates.loaded && waiting.every((s) =>
    !liveHome.suspendedGates.pending.has(sessionRowKey(s)) && !liveHome.suspendedGates.expired.has(sessionRowKey(s)));

  const noProjects = Boolean(data) && projects.length === 0;
  const noAgents = Boolean(data) && projects.length > 0 && projects.every((project) => project.agentCount === 0);
  const runningByProject = new Map<string, number>();
  for (const row of running) runningByProject.set(row.project, (runningByProject.get(row.project) ?? 0) + 1);

  // One ambient state drives the background tint: running beats waiting beats idle.
  const ambient = running.length > 0 ? 'running' : (pendingApprovals > 0 || pendingChangesets.length > 0 || waiting.length > 0) ? 'waiting' : 'idle';

  // Header sentence + stat line. "Waiting on you" counts what the section of
  // the same name lists: pending gates, open changesets, recent failures,
  // stranded runs.
  const waitingOnYou = liveHome.pendingRows.length + pendingChangesets.length + failedRecent.length + strandedRecent.length;
  const runs24h = operationalSessions.length;
  // Crashes only, matching the /sessions?status=error filter this stat links to.
  // A run the agent declared incomplete is listed under its own filter there.
  const failed24h = operationalSessions.filter((s) =>
    runTone(s.status) === 'failed' && !isIncompleteOutcome(s.status, s.errorCode)).length;
  const ended24h = operationalSessions.filter((s) => { const t = runTone(s.status); return t === 'ok' || t === 'failed'; }).length;
  const successPct = ended24h > 0 ? Math.round(((ended24h - failed24h) / ended24h) * 100) : null;

  if (noProjects || noAgents) {
    return <OnboardingRedirect />;
  }

  return (
    <div class="page-home" data-ambient={ambient}>
      <div class="home-ambient" aria-hidden="true"></div>
      <main class="home-boot">
        {(previewRequested && data)
          ? <UpdateBanner update={previewUpdate(data.version)} persistDismissal={false} />
          : data?.update && <UpdateBanner update={data.update} />}
        <header class="home-head" aria-live="polite">
          <HomeClock />
          <h1 class="home-sentence">
            <span class={`hero-dot${running.length > 0 ? ' on' : ''}`} aria-hidden="true"></span>
            {running.length === 0
              ? 'No agents are working right now.'
              : `${plural(running.length, 'agent')} ${running.length === 1 ? 'is' : 'are'} working.`}
            {' '}
            {waitingOnYou > 0
              ? <span class="home-waiting">{waitingOnYou === 1 ? '1 thing is' : `${waitingOnYou} things are`} waiting on you.</span>
              : waiting.length > 0
                ? <span class="home-quiet">{plural(waiting.length, 'session')} {allWaitingResuming ? 'resuming' : 'suspended'}.</span>
                : <span class="home-quiet">Nothing is waiting on you.</span>}
          </h1>
          <div class="home-stat">
            {runs24h > 0
              ? <>
                  {runs24h} runs in the last 24 hours
                  {successPct !== null && <> · {successPct}% succeeded</>}
                  {failed24h > 0 && <> · <a class="home-stat-failed" href="/sessions?status=error">{failed24h} failed</a></>}
                </>
              : 'No runs in the last 24 hours'}
            {nextSchedule && <NextRunStat nextSchedule={nextSchedule} refetch={schedules.refetch} />}
          </div>
          {error && <InlineError>Failed to load: {error.message}</InlineError>}
          {liveHome.error && <InlineError>Failed to load sessions: {liveHome.error.message}</InlineError>}
          {(changesetReviews.data?.errors.length ?? 0) > 0 && <InlineError>Failed to load some change reviews: {changesetReviews.data!.errors.join('; ')}</InlineError>}
        </header>

        {sections.isVisible('running') && running.length > 0 && <WorkingNow running={running} />}

        {sections.isVisible('attention') && (
          <AttentionSection pending={liveHome.pendingRows} changesets={pendingChangesets} failed={failedRecent} stranded={strandedRecent} onDismissFailed={dismissFailed} onDismissAll={dismissAll} />
        )}

        {sections.isVisible('results') && (
          <AgentResultsRows payload={metricRows.data} agents={agents.data?.agents} />
        )}

        {sections.isVisible('latest') && (
          <RunsByAgent sessions={operationalSessions} loading={liveHome.loading} />
        )}

        {(sections.isVisible('coming-up') || sections.isVisible('feed')) && (
          <div class="home-cols">
            {sections.isVisible('coming-up') && (
              <ComingUp schedules={schedules.data?.schedules ?? []} />
            )}
            {sections.isVisible('feed') && (
              <section class="group">
                <h2 class="group-title">
                  <span>Recent activity</span><span class="rule"></span>
                  <a class="group-link" href="/sessions">everything →</a>
                </h2>
                <div class="panel feed">
                  {liveHome.feed.length === 0
                    ? (liveHome.loading
                      ? <Loading label="Loading activity…" />
                      : <div class="empty">No runs in the last 24 hours.</div>)
                    : liveHome.feed.slice(0, FEED_LIMIT).map((event) => <FeedRow key={event.key} event={event} />)}
                </div>
              </section>
            )}
          </div>
        )}

        {sections.isVisible('projects') && (
          <section class="group home-projects">
            <h2 class="group-title">
              <span>{term('project', projects.length)}</span>
              {projects.length > 0 && <span class="count">{projects.length}</span>}
              <span class="rule"></span>
            </h2>
            {projects.length === 0
              ? (loading ? <Loading label={`Loading ${term('project', 2)}…`} /> : null)
              : (
                <div class="project-grid">
                  {projects.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      running={runningByProject.get(project.id) ?? 0}
                      failed={failedAgentsByProject.get(project.id) ?? 0}
                      isDefault={project.id === data?.default}
                    />
                  ))}
                </div>
              )}
          </section>
        )}

        {data && (
          <footer class="home-version-foot">
            <span>AgentUse</span>
            <span>
              {data.dev && <span class="home-dev-tag" title="Unreleased development build">dev</span>}
              v{data.version}
            </span>
          </footer>
        )}
      </main>
    </div>
  );
}
