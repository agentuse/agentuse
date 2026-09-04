import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useEffect, useMemo, useState } from 'preact/hooks';
import type { ApprovalRow, ApprovalsListPayload } from '../lib/api';
import { fetchAgents, fetchApprovals } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useApprovalsStream } from '../hooks/use-approvals-stream';
import { useTitle } from '../hooks/use-title';
import { useRunAgent } from '../hooks/use-run-agent';
import { Loading } from '../components/loading';
import { PushBell } from '../components/push-bell';
import { GroupRail } from '../components/group-rail';
import type { AgentGroup } from '../components/pending-approval-card';
import { PendingApprovalGroups, expiresSoon, groupPendingByAgent, pendingGroupId } from '../components/pending-approval-card';
import { syncAppBadge } from '../lib/badge';
import { displayAgentName, formatApprovalTime, formatRelativeTime } from '../lib/format';
import { pageTitle } from '../lib/brand';
import { agentDetailHref } from '../lib/links';
import { term } from '../lib/terms';
import type { AgentApprovalStats, ApprovalOutcome, ApprovalWindow } from '../lib/approval-stats';
import {
  SLOW_REPLY_MS,
  agentApprovalStats,
  agentRunPathResolver,
  approvalOutcome,
  decidedThisWeek,
  decidedViaSlack,
  formatCompactAge,
  formatReplyDuration,
  pendingHeadline,
  pendingSessionIds,
  recordSentence,
  reviewerLabel,
  statsByKey,
} from '../lib/approval-stats';

const HOUR = 3_600_000;
/** Rows shown before "After your call" folds; a week of decisions is long. */
const DECIDED_FOLD = 8;
const WINDOWS: Array<{ id: ApprovalWindow; label: string }> = [
  { id: '7', label: '7 days' },
  { id: '30', label: '30 days' },
  { id: 'all', label: 'All' },
];

/** Rows link into the session, which is where a decision is actually made. A
 *  row with no resume token has nothing to open, so it renders static. */
function sessionHref(row: ApprovalRow, multiProject: boolean): string | null {
  if (row.resumeToken === undefined) return null;
  const params = new URLSearchParams();
  if (row.resumeToken) params.set('token', row.resumeToken);
  if (multiProject) params.set('project', row.project);
  return `/sessions/${encodeURIComponent(row.sessionId)}?${params.toString()}`;
}

// The approval prompt (what actually needs a decision) beats the agent's static
// description for the supporting line; clamp so one row can't run away.
function summaryText(row: ApprovalRow): string {
  const text = row.summary || row.prompt || row.agentDescription || '';
  return text.length > 220 ? `${text.slice(0, 220)}…` : text;
}

function windowFrom(value: string | undefined): ApprovalWindow {
  return value === '7' || value === 'all' ? value : '30';
}

/** The run's own status after the reviewer answered: a dot or ✕, a short
 *  phrase, and at most one thing to do about it. */
function OutcomeCell(props: {
  outcome: ApprovalOutcome;
  agentPath: string | undefined;
  project: string;
}) {
  const { outcome } = props;
  const { run, busy, error } = useRunAgent(props.agentPath ?? '', props.project);
  const action = (label: string) => props.agentPath
    ? (
      <button
        type="button"
        class="appr-outcome-action"
        disabled={busy}
        title={error ?? `Run this agent again`}
        onClick={(e) => { e.preventDefault(); e.stopPropagation(); void run(); }}
      >{label}</button>
    )
    : null;

  switch (outcome.kind) {
    case 'running':
      return (
        <span class="appr-outcome">
          <span class="lastrun running"><span class="lastrun-dot running" aria-hidden="true"></span>
            <span class="lastrun-text">running now{outcome.sinceMs !== undefined ? ` · ${formatCompactAge(outcome.sinceMs)} in` : ''}</span>
          </span>
        </span>
      );
    case 'failed':
      return (
        <span class="appr-outcome">
          <span class="lastrun failed"><span class="lastrun-dot failed" aria-hidden="true"></span><span class="lastrun-text">failed</span></span>
          {outcome.text && <span class="appr-outcome-note" title={outcome.text}>{outcome.text}</span>}
          {action('retry')}
        </span>
      );
    case 'revised':
      return (
        <span class="appr-outcome">
          {outcome.anchor
            ? <a class="lastrun waiting" href={`#${outcome.anchor}`} onClick={(e) => e.stopPropagation()}>
              <span class="lastrun-dot waiting" aria-hidden="true"></span><span class="lastrun-text">revised · waiting above ↑</span>
            </a>
            : <span class="lastrun waiting"><span class="lastrun-dot waiting" aria-hidden="true"></span><span class="lastrun-text">revised</span></span>}
        </span>
      );
    case 'stopped':
      return (
        <span class="appr-outcome">
          <span class="lastrun"><span class="lastrun-dot stopped" aria-hidden="true"></span><span class="lastrun-text">stopped · nothing sent</span></span>
        </span>
      );
    case 'missed':
      return (
        <span class="appr-outcome">
          <span class="lastrun failed"><span class="lastrun-dot failed" aria-hidden="true"></span><span class="lastrun-text">missed · never sent</span></span>
          {action('run again')}
        </span>
      );
    default:
      return (
        <span class="appr-outcome">
          <span class="lastrun"><span class="lastrun-dot ok" aria-hidden="true"></span><span class="lastrun-text">completed</span></span>
        </span>
      );
  }
}

/** One settled gate: the call, who asked, what was asked, when it was decided,
 *  and what the run did next. */
function DecidedRow(props: {
  row: ApprovalRow;
  multiProject: boolean;
  outcome: ApprovalOutcome;
  agentPath: string | undefined;
}) {
  const { row, multiProject, outcome } = props;
  const href = sessionHref(row, multiProject);
  const attention = outcome.kind === 'failed' || outcome.kind === 'missed';
  const decidedAt = row.decisionAt ?? row.expiresAt;
  const who = row.status === 'expired' ? 'nobody' : reviewerLabel(row);
  const channel = row.status === 'expired' ? null : (decidedViaSlack(row) ? 'Slack' : 'web');

  const inner = (
    <>
      <span class="appr-call"><span class={`chip status ${row.status}`}>{row.status}</span></span>
      <span class="appr-agent">{displayAgentName(row.agentName, row.agentFilePath, row.agentId)}</span>
      <span class="appr-asked">
        {summaryText(row)}
        {row.decisionComment && <span class="appr-comment"> “{row.decisionComment}”</span>}
      </span>
      <span class="appr-decided" title={formatApprovalTime(decidedAt)}>
        {who}
        {channel && <> · <span class="appr-channel">{channel}</span></>}
        {' · '}{row.status === 'expired' ? `expired ${formatRelativeTime(decidedAt)}` : formatRelativeTime(decidedAt)}
      </span>
      <OutcomeCell outcome={outcome} agentPath={props.agentPath} project={row.project} />
    </>
  );

  const cls = `appr-row${attention ? ' attention' : ''}`;
  return href
    ? <a class={cls} href={href}>{inner}</a>
    : <div class={`${cls} appr-static`}>{inner}</div>;
}

function ByAgentRow(props: { stats: AgentApprovalStats; href: string | null }) {
  const s = props.stats;
  const settled = s.approved + s.rejected + s.missed;
  const pct = (n: number) => settled > 0 ? `${(n / settled) * 100}%` : '0%';
  const slow = s.medianReplyMs !== undefined && s.medianReplyMs >= SLOW_REPLY_MS;

  const inner = (
    <>
      <span class="agent-name">{s.name}</span>
      <span class="agent-asked mono">{s.asked}</span>
      <span class="agent-ratio">
        <span class="ratio" aria-hidden="true">
          {s.approved > 0 && <i class="ok" style={{ width: pct(s.approved) }}></i>}
          {s.rejected > 0 && <i class="no" style={{ width: pct(s.rejected) }}></i>}
          {s.missed > 0 && <i class="miss" style={{ width: pct(s.missed) }}></i>}
        </span>
        <span class="agent-ratio-counts mono">
          {s.approved} · <span class={s.rejected > 0 ? 'warn' : ''}>{s.rejected}</span> · <span class={s.missed > 0 ? 'bad' : ''}>{s.missed}</span>
        </span>
      </span>
      <span class={`agent-median mono${slow ? ' bad' : ''}`}>{s.medianReplyMs !== undefined ? formatReplyDuration(s.medianReplyMs) : '—'}</span>
      <span class={`agent-waiting mono${s.waitingNow > 0 ? ' live' : ''}`}>{s.waitingNow > 0 ? s.waitingNow : '—'}</span>
      <span class="agent-last mono" title={formatApprovalTime(s.lastAskedAt)}>{s.lastAskedAt !== undefined ? formatRelativeTime(s.lastAskedAt) : '—'}</span>
    </>
  );

  return props.href
    ? <a class="agent-row" href={props.href}>{inner}</a>
    : <div class="agent-row">{inner}</div>;
}

function Section(props: { id?: string; title: string; count: ComponentChildren; aside?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="bucket" {...(props.id ? { id: props.id } : {})}>
      <h2 class="section-title">
        <span>{props.title}</span>
        <span class="count">{props.count}</span>
        <span class="rule"></span>
        {props.aside}
      </h2>
      {props.children}
    </section>
  );
}

export default function ApprovalsList() {
  const location = useLocation();
  const days = location.query.days || undefined;
  const project = location.query.project || undefined;
  const window_ = windowFrom(days);

  useTitle(pageTitle('Approvals'));

  const key = `approvals:${days ?? ''}:${project ?? ''}`;
  const [streamData, setStreamData] = useState<ApprovalsListPayload | null>(null);
  const [streamError, setStreamError] = useState<Error | null>(null);
  const [streamFallback, setStreamFallback] = useState(false);
  const [showAllDecided, setShowAllDecided] = useState(false);

  useEffect(() => {
    setStreamData(null);
    setStreamError(null);
    setStreamFallback(false);
    setShowAllDecided(false);
  }, [key]);

  const fetched = useFetch(
    key,
    () => fetchApprovals({ days, project }),
    streamFallback ? { refreshMs: 10_000 } : {}
  );
  // Approvals name their agent by absolute path; the agent hub and the run
  // endpoint want the scope-relative one. Loaded once, never refreshed: the
  // agent roster does not move while a reviewer clears a queue.
  const agents = useFetch('approvals-agents', () => fetchAgents(), {});

  useEffect(() => {
    if (streamFallback) fetched.refetch();
  }, [streamFallback, fetched.refetch]);

  useApprovalsStream({
    days,
    project,
    enabled: !streamFallback,
    onData: (payload) => {
      setStreamData(payload);
      setStreamError(null);
    },
    onError: setStreamError,
    onFallback: () => setStreamFallback(true),
  });

  const data = streamFallback ? (fetched.data ?? streamData) : (streamData ?? fetched.data);
  const error = fetched.error ?? (!data ? streamError : null);
  const loading = fetched.loading && !data;
  const pending = data?.buckets.pending ?? [];
  const totalPending = pending.length;
  // Age pills tick once a minute; nothing on this page needs seconds.
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (totalPending === 0) return;
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  }, [totalPending]);

  const multiProject = data?.multiProject ?? false;
  const settled = useMemo(
    () => [...(data?.buckets.completed ?? []), ...(data?.buckets.expired ?? [])]
      .sort((a, b) => (b.decisionAt ?? b.expiresAt ?? 0) - (a.decisionAt ?? a.expiresAt ?? 0)),
    [data],
  );
  const allRows = useMemo(() => [...pending, ...settled], [pending, settled]);
  const stats = useMemo(() => agentApprovalStats(allRows), [allRows]);
  const statsIndex = useMemo(() => statsByKey(stats), [stats]);
  const runPathFor = useMemo(() => agentRunPathResolver(agents.data?.agents ?? []), [agents.data]);
  const stillPending = useMemo(() => pendingSessionIds(pending), [pending]);
  // A commented gate that produced a fresh gate for the same session points at
  // the group holding it, rather than claiming the run merely finished.
  const anchorBySession = useMemo(() => {
    const map = new Map<string, string>();
    for (const group of groupPendingByAgent(pending, 'stalest')) {
      for (const row of group.rows) map.set(`${row.project}:${row.sessionId}`, pendingGroupId(group));
    }
    return map;
  }, [pending]);

  const head = useMemo(() => pendingHeadline(pending, now), [pending, now]);
  const decidedWeek = useMemo(() => decidedThisWeek(settled, now), [settled, now]);
  const medianReply = useMemo(() => {
    const all = stats.map((s) => s.medianReplyMs).filter((v): v is number => v !== undefined).sort((a, b) => a - b);
    if (all.length === 0) return undefined;
    const mid = all.length >> 1;
    return all.length % 2 ? all[mid]! : (all[mid - 1]! + all[mid]!) / 2;
  }, [stats]);

  const projects = useMemo(() => [...new Set(allRows.map((r) => r.project))].sort(), [allRows]);
  const railItems = useMemo(
    () => groupPendingByAgent(pending, 'stalest').map((g) => ({ id: pendingGroupId(g), label: g.name, count: g.rows.length })),
    [pending],
  );

  const setQuery = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const next = { days, project, ...patch };
    for (const [k, v] of Object.entries(next)) if (v) params.set(k, v);
    const query = params.toString();
    location.route(query ? `/approvals?${query}` : '/approvals');
  };

  // The list is the source of truth for the app-icon badge: opening it (or
  // watching it live) corrects whatever count pushes left behind.
  useEffect(() => {
    if (data) syncAppBadge(totalPending);
  }, [data, totalPending]);

  const visibleDecided = showAllDecided ? settled : settled.slice(0, DECIDED_FOLD);
  const hiddenDecided = settled.length - visibleDecided.length;

  const groupAside = (group: AgentGroup) => {
    const stat = statsIndex.get(group.key);
    const runPath = runPathFor(group.project, group.agentFilePath);
    // Phones have no room for a second pill per row, so the group's soonest
    // deadline surfaces here instead (hidden on wider screens).
    const soonest = group.rows
      .map((row) => expiresSoon(row, now))
      .filter((v): v is { leftMs: number; urgent: boolean } => v !== undefined)
      .sort((a, b) => a.leftMs - b.leftMs)[0];
    return (
      <>
        <span class="pending-group-rule"></span>
        {soonest && (
          <span class={`pending-group-expires${soonest.urgent ? ' urgent' : ''}`}>expires {formatCompactAge(soonest.leftMs)}</span>
        )}
        {stat && <span class="pending-group-record">{recordSentence(stat, window_)}</span>}
        {runPath && <a class="pending-group-link" href={agentDetailHref(group.project, runPath)}>agent →</a>}
      </>
    );
  };

  const lede = (
    <>
      <span class="lede-strong">{head.waiting} waiting</span>
      {head.agents > 0 && <> across {head.agents} agent{head.agents === 1 ? '' : 's'}</>}
      {head.oldestMs !== undefined && (
        <> · oldest <span class={head.oldestMs >= 72 * HOUR ? 'bad' : head.oldestMs >= 24 * HOUR ? 'warn' : ''}>{formatCompactAge(head.oldestMs)}</span></>
      )}
      {head.expiringSoon > 0 && (
        <> · <span class={head.soonestExpiryMs !== undefined && head.soonestExpiryMs <= HOUR ? 'bad' : 'warn'}>
          {head.expiringSoon} expire{head.expiringSoon === 1 ? 's' : ''} in {head.soonestExpiryMs !== undefined ? `<${formatCompactAge(Math.max(head.soonestExpiryMs, 60_000))}` : '<6h'}
        </span></>
      )}
      {decidedWeek > 0 && <> · {decidedWeek} decided this week</>}
      {medianReply !== undefined && <> · your median reply <code>{formatReplyDuration(medianReply)}</code></>}
    </>
  );

  return (
    <div class="page-approvals">
      <GroupRail items={railItems} />
      <main>
        <header>
          <div class="header-text">
            <div class="eyebrow">waiting on you</div>
            <h1>Approvals <PushBell category="approvals" /></h1>
            <p class="lede">{data ? lede : loading ? 'Loading…' : ''}</p>
          </div>
          {multiProject && projects.length > 1 && (
            <select
              class="project-filter"
              aria-label={term('project')}
              value={project ?? ''}
              onChange={(e) => setQuery({ project: (e.currentTarget as HTMLSelectElement).value || undefined })}
            >
              <option value="">All {term('project', 2)}</option>
              {projects.map((p) => <option key={p} value={p}>{p}</option>)}
            </select>
          )}
        </header>

        {error && (
          <div class="errors" role="alert">Failed to load approvals: {error.message}</div>
        )}
        {data && data.errors.length > 0 && (
          <div class="errors" role="alert">
            Some {term('project', 2)} failed to load:
            <ul>{data.errors.map((e) => <li key={e.projectId}>{e.projectId}: {e.message}</li>)}</ul>
          </div>
        )}
        {loading && !data && <Loading label="Loading approvals…" />}

        {data && (
          <>
            <Section
              id="waiting"
              title="Waiting on you"
              count={pending.length}
              aside={pending.length > 0 ? <span class="section-note">stalest agent first · newest gate first inside</span> : undefined}
            >
              {pending.length === 0
                ? <p class="empty">Nothing waiting on you.</p>
                : <div class="surface appr-surface">
                  <PendingApprovalGroups rows={pending} now={now} order="stalest" anchored showExpiry groupAside={groupAside} />
                </div>}
            </Section>

            <Section
              title="After your call"
              count={settled.length}
              aside={
                <span class="segments" role="group" aria-label="Time window">
                  {WINDOWS.map((w) => (
                    <button
                      key={w.id}
                      type="button"
                      class={`segment${window_ === w.id ? ' active' : ''}`}
                      aria-pressed={window_ === w.id}
                      onClick={() => setQuery({ days: w.id === '30' ? undefined : w.id })}
                    >{w.label}</button>
                  ))}
                </span>
              }
            >
              {settled.length === 0
                ? <p class="empty">No decisions in this window.</p>
                : <div class="surface appr-table">
                  <div class="appr-head-row" aria-hidden="true">
                    <span>Your call</span><span>Agent</span><span>What was asked</span><span>Decided</span><span>What happened next</span>
                  </div>
                  {visibleDecided.map((row) => {
                    const anchor = stillPending.has(`${row.project}:${row.sessionId}`)
                      ? anchorBySession.get(`${row.project}:${row.sessionId}`)
                      : undefined;
                    return (
                      <DecidedRow
                        key={`${row.project}:${row.sessionId}:${row.status}`}
                        row={row}
                        multiProject={multiProject}
                        outcome={approvalOutcome(row, { now, revisedAnchor: anchor })}
                        agentPath={runPathFor(row.project, row.agentFilePath) ?? row.agentFilePath}
                      />
                    );
                  })}
                  {hiddenDecided > 0 && (
                    <button type="button" class="appr-more" onClick={() => setShowAllDecided(true)}>{hiddenDecided} more →</button>
                  )}
                </div>}
            </Section>

            {stats.length > 0 && (
              <Section
                title="By agent"
                count={WINDOWS.find((w) => w.id === window_)!.label.toLowerCase()}
                aside={<span class="section-note">who asks most, and what you tend to say</span>}
              >
                <div class="surface agent-table">
                  <div class="agent-head-row" aria-hidden="true">
                    <span>Agent</span><span>Asked</span><span>Approved · rejected · missed</span><span>Your median reply</span><span>Waiting now</span><span>Last asked</span>
                  </div>
                  {stats.map((s) => {
                    const runPath = runPathFor(s.project, s.agentFilePath);
                    return <ByAgentRow key={s.key} stats={s} href={runPath ? agentDetailHref(s.project, runPath) : null} />;
                  })}
                </div>
              </Section>
            )}

            <footer>{streamFallback ? 'auto-refreshes every 10s' : 'live updates'}</footer>
          </>
        )}
      </main>
    </div>
  );
}
