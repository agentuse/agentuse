import type { ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useEffect, useState } from 'preact/hooks';
import type { ApprovalRow, ApprovalsListPayload } from '../lib/api';
import { fetchApprovals } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useApprovalsStream } from '../hooks/use-approvals-stream';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { Loading } from '../components/loading';
import { PushBell } from '../components/push-bell';
import { syncAppBadge } from '../lib/badge';
import { formatApprovalTime, errorText } from '../lib/format';
import { pageTitle } from '../lib/brand';
import { term } from '../lib/terms';

/** Time a gate has been waiting on a human, as a compact "waiting 26m". */
function formatWaiting(ms: number): string {
  const min = Math.floor(ms / 60_000);
  if (min < 1) return 'waiting now';
  if (min < 60) return `waiting ${min}m`;
  const hr = Math.floor(min / 60);
  if (hr < 24) return `waiting ${hr}h`;
  return `waiting ${Math.floor(hr / 24)}d`;
}

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

/** A gate still waiting: who wants what, how long it has waited, and a single
 *  "review →" affordance into the session. Never an inline approve. */
function PendingRow(props: { row: ApprovalRow; multiProject: boolean }) {
  const { row, multiProject } = props;
  const href = sessionHref(row, multiProject);
  const since = row.suspendedAt ?? row.createdAt;
  const sub = summaryText(row);
  // The absolute suspend/expiry time stays available on hover.
  const timeTitle = row.expiresAt
    ? `expires ${formatApprovalTime(row.expiresAt)}`
    : `suspended ${formatApprovalTime(row.suspendedAt)}`;

  const inner = (
    <>
      <div class="appr-head">
        <span class="appr-agent">{row.agentName || '(untitled approval)'}</span>
        <span class="appr-kind">wants approval{row.risk ? ` · ${row.risk}` : ''}</span>
        {multiProject && <span class="chip project">{row.project}</span>}
        <span class="appr-time">
          {since !== undefined && <span title={timeTitle}>{formatWaiting(Date.now() - since)}</span>}
          {href && <span class="appr-review">review →</span>}
        </span>
      </div>
      {sub && <div class="appr-summary">{sub}</div>}
      <div class="appr-meta"><code>{row.sessionId}</code></div>
    </>
  );

  return href
    ? <a class="appr" href={href}>{inner}</a>
    : <div class="appr appr-static">{inner}</div>;
}

/** A gate that already has an outcome: status pill first, then what was asked
 *  and what was decided. */
function DecidedRow(props: { row: ApprovalRow; multiProject: boolean }) {
  const { row, multiProject } = props;
  const href = sessionHref(row, multiProject);
  const sub = summaryText(row);
  const timeLabel = row.status === 'expired'
    ? `expired ${formatApprovalTime(row.decisionAt ?? row.expiresAt)}`
    : `decided ${formatApprovalTime(row.decisionAt)}`;
  const decisionLabel = errorText(row.errorMessage) || row.decisionComment || '';

  const inner = (
    <>
      <div class="appr-head">
        <span class={`chip status ${row.status}`}>{row.status}</span>
        {multiProject && <span class="chip project">{row.project}</span>}
        <span class="appr-time">{timeLabel}</span>
      </div>
      <div class="appr-title">{row.agentName || '(untitled approval)'}</div>
      {sub && <div class="appr-summary">{sub}</div>}
      {decisionLabel && <div class="appr-decision">{decisionLabel}</div>}
      <div class="appr-meta"><code>{row.sessionId}</code></div>
    </>
  );

  return href
    ? <a class="appr" href={href}>{inner}</a>
    : <div class="appr appr-static">{inner}</div>;
}

function Bucket(props: {
  title: string;
  count: number;
  emptyText: string;
  /** Cyan edge: this surface is the one waiting on a human. */
  accent?: boolean;
  children: ComponentChildren;
}) {
  return (
    <section class="bucket">
      <h2 class="section-title"><span>{props.title}</span><span class="count">{props.count}</span><span class="rule"></span></h2>
      {props.count === 0
        ? <p class="empty">{props.emptyText}</p>
        : <div class={props.accent ? 'surface appr-surface' : 'surface'}>{props.children}</div>}
    </section>
  );
}

export default function ApprovalsList() {
  const location = useLocation();
  const days = location.query.days || undefined;
  const project = location.query.project || undefined;

  useTitle(pageTitle('Approvals'));

  const key = `approvals:${days ?? ''}:${project ?? ''}`;
  const [streamData, setStreamData] = useState<ApprovalsListPayload | null>(null);
  const [streamError, setStreamError] = useState<Error | null>(null);
  const [streamFallback, setStreamFallback] = useState(false);

  useEffect(() => {
    setStreamData(null);
    setStreamError(null);
    setStreamFallback(false);
  }, [key]);

  const fetched = useFetch(
    key,
    () => fetchApprovals({ days, project }),
    streamFallback ? { refreshMs: 10_000 } : {}
  );

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
  const totalPending = data?.buckets.pending.length ?? 0;
  const multiProject = data?.multiProject ?? false;
  const recentlyDecided = [...(data?.buckets.completed ?? []), ...(data?.buckets.expired ?? [])]
    .sort((a, b) => (b.decisionAt ?? b.expiresAt ?? 0) - (a.decisionAt ?? a.expiresAt ?? 0));

  // The list is the source of truth for the app-icon badge: opening it (or
  // watching it live) corrects whatever count pushes left behind.
  useEffect(() => {
    if (data) syncAppBadge(totalPending);
  }, [data, totalPending]);

  return (
    <div class="page-approvals">
      <Topbar currentPage="approvals" />
      <main>
        <h1>Approvals <PushBell category="approvals" /></h1>
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
            <Bucket title="Pending" count={data.buckets.pending.length} emptyText="Nothing waiting on you." accent>
              {data.buckets.pending.map((row) => (
                <PendingRow key={`${row.project}:${row.sessionId}`} row={row} multiProject={multiProject} />
              ))}
            </Bucket>
            {/* Decided and expired gates share one "Recently decided" list, most
                recent first, so the operator can confirm a call was recorded. */}
            <Bucket title="Recently decided" count={recentlyDecided.length} emptyText="No recent decisions.">
              {recentlyDecided.map((row) => (
                <DecidedRow key={`${row.project}:${row.sessionId}:${row.status}`} row={row} multiProject={multiProject} />
              ))}
            </Bucket>
            <footer>{streamFallback ? 'auto-refreshes every 10s' : 'live updates'}</footer>
          </>
        )}
      </main>
    </div>
  );
}
