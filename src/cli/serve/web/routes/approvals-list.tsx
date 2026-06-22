import { useLocation } from 'preact-iso';
import { useEffect, useState } from 'preact/hooks';
import type { ApprovalRow, ApprovalsListPayload } from '../lib/api';
import { fetchApprovals } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useApprovalsStream } from '../hooks/use-approvals-stream';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { formatApprovalTime, errorText } from '../lib/format';

function ApprovalRowView(props: { row: ApprovalRow; multiProject: boolean }) {
  const { row, multiProject } = props;
  const linkable = row.resumeToken !== undefined;
  const params = new URLSearchParams();
  if (row.resumeToken) params.set('token', row.resumeToken);
  if (multiProject) params.set('project', row.project);
  const href = linkable ? `/sessions/${encodeURIComponent(row.sessionId)}?${params.toString()}` : null;

  const titleText = row.agentDescription || row.prompt || row.agentName || '(untitled approval)';
  const truncated = titleText.length > 220 ? `${titleText.slice(0, 220)}…` : titleText;

  const timeLabel = row.status === 'pending'
    ? (row.expiresAt
      ? `expires ${formatApprovalTime(row.expiresAt)}`
      : `suspended ${formatApprovalTime(row.suspendedAt)}`)
    : row.status === 'expired'
      ? `expired ${formatApprovalTime(row.decisionAt ?? row.expiresAt)}`
      : `decided ${formatApprovalTime(row.decisionAt)}`;

  const decisionLabel = errorText(row.errorMessage) || row.decisionComment || '';

  const inner = (
    <>
      <div class="row-head">
        <span class={`chip status ${row.status}`}>{row.status}</span>
        {multiProject && <span class="chip project">{row.project}</span>}
        <span class="chip agent">{row.agentName}</span>
        <span class="row-time">{timeLabel}</span>
      </div>
      <div class="row-title">{truncated}</div>
      {decisionLabel && <div class="row-decision">{decisionLabel}</div>}
      <div class="row-meta"><code>{row.sessionId}</code></div>
    </>
  );

  return href
    ? <a class="row" href={href}>{inner}</a>
    : <div class="row row-static">{inner}</div>;
}

function Bucket(props: { title: string; rows: ApprovalRow[]; emptyText: string; multiProject: boolean }) {
  return (
    <section class="bucket">
      <h2 class="section-title"><span>{props.title}</span><span class="count">{props.rows.length}</span><span class="rule"></span></h2>
      {props.rows.length === 0
        ? <p class="empty">{props.emptyText}</p>
        : (
          <div class="rows">
            {props.rows.map((row) => (
              <ApprovalRowView key={`${row.project}:${row.sessionId}:${row.status}`} row={row} multiProject={props.multiProject} />
            ))}
          </div>
        )}
    </section>
  );
}

export default function ApprovalsList() {
  const location = useLocation();
  const days = location.query.days || undefined;
  const project = location.query.project || undefined;

  useTitle('AgentUse / Approvals');

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

  return (
    <div class="page-approvals">
      <Topbar currentPage="approvals" right={<span class="pending-count">{totalPending} pending</span>} />
      <main>
        <h1>Approvals</h1>
        {error && (
          <div class="errors">Failed to load approvals: {error.message}</div>
        )}
        {data && data.errors.length > 0 && (
          <div class="errors">
            Some projects failed to load:
            <ul>{data.errors.map((e) => <li key={e.projectId}>{e.projectId}: {e.message}</li>)}</ul>
          </div>
        )}
        {loading && !data && <p class="empty">Loading approvals…</p>}
        {data && (
          <>
            <Bucket title="Pending" rows={data.buckets.pending} emptyText="No approvals waiting." multiProject={multiProject} />
            <footer>{streamFallback ? 'auto-refreshes every 10s' : 'live updates'}</footer>
          </>
        )}
      </main>
    </div>
  );
}
