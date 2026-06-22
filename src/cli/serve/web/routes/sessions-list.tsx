import { useLocation } from 'preact-iso';
import { useEffect, useState } from 'preact/hooks';
import type { SessionRow, SessionsPayload } from '../lib/api';
import { fetchSessions } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useSessionsStream } from '../hooks/use-sessions-stream';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { formatApprovalTime, formatRelativeTime, errorText } from '../lib/format';

const WINDOWS = ['1h', '6h', '24h', '7d', '30d', '90d', 'all'];
const STATUSES = ['', 'running', 'suspended', 'completed', 'error'];
const TRIGGERS = ['', 'manual', 'scheduled', 'slack', 'api'];

// Map a raw session status to the status-chip class set used by the CSS.
function statusClass(status: string): string {
  return `chip status ${status}`;
}

function SessionRowView(props: { row: SessionRow; multiProject: boolean }) {
  const { row, multiProject } = props;
  const href = `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;
  const title = row.agent.description || row.agent.name || row.agent.id;
  return (
    <a class="row" href={href}>
      <div class="row-head">
        <span class={statusClass(row.status)}>{row.status}</span>
        {multiProject && <span class="chip project">{row.project}</span>}
        <span class="chip agent">{row.agent.name || row.agent.id}</span>
        <span class="chip trigger">{row.trigger}</span>
        {row.mock && <span class="chip mock">mock</span>}
        <span class="row-time" title={formatApprovalTime(row.createdAt)}>{formatRelativeTime(row.createdAt)}</span>
      </div>
      <div class="row-title">{title}</div>
      {row.errorMessage && <div class="row-decision">{errorText(row.errorMessage)}</div>}
      <div class="row-meta"><code>{row.sessionId}</code></div>
    </a>
  );
}

export default function SessionsList() {
  const location = useLocation();
  const q = location.query;
  const win = q.window || '24h';
  const statusFilter = q.status || '';
  const triggerFilter = q.trigger || '';
  const agentFilter = q.agent || undefined;
  const approvalFilter = q.approval || undefined;

  useTitle('AgentUse / Sessions');

  const key = `sessions:${win}:${statusFilter}:${triggerFilter}:${agentFilter ?? ''}:${approvalFilter ?? ''}`;
  const [streamData, setStreamData] = useState<SessionsPayload | null>(null);
  const [streamError, setStreamError] = useState<Error | null>(null);
  const [streamFallback, setStreamFallback] = useState(false);

  useEffect(() => {
    setStreamData(null);
    setStreamError(null);
    setStreamFallback(false);
  }, [key]);

  const fetched = useFetch(
    key,
    () => fetchSessions({
      window: win,
      status: statusFilter || undefined,
      trigger: triggerFilter || undefined,
      agent: agentFilter,
      approval: approvalFilter,
    }),
    streamFallback ? { refreshMs: 10_000 } : {}
  );

  useEffect(() => {
    if (streamFallback) fetched.refetch();
  }, [streamFallback, fetched.refetch]);

  useSessionsStream({
    window: win,
    status: statusFilter || undefined,
    trigger: triggerFilter || undefined,
    agent: agentFilter,
    approval: approvalFilter,
    enabled: !streamFallback,
    onData: (payload) => {
      setStreamData(payload);
      setStreamError(null);
    },
    onError: setStreamError,
    onFallback: () => setStreamFallback(true),
  });

  const resolvedData = streamFallback ? (fetched.data ?? streamData) : (streamData ?? fetched.data);
  const resolvedError = fetched.error ?? (!resolvedData ? streamError : null);
  const resolvedLoading = fetched.loading && !resolvedData;
  const rows = resolvedData?.sessions ?? [];
  const multiProject = new Set(rows.map((r) => r.project)).size > 1;

  // Build a URL that preserves the other active filters when one changes.
  const withParam = (key: string, value: string): string => {
    const params = new URLSearchParams();
    const base: Record<string, string | undefined> = {
      window: win, status: statusFilter, trigger: triggerFilter, agent: agentFilter, approval: approvalFilter,
    };
    base[key] = value;
    for (const [k, v] of Object.entries(base)) {
      if (v) params.set(k, v);
    }
    const qs = params.toString();
    return qs ? `/sessions?${qs}` : '/sessions';
  };

  const onSelect = (key: string) => (event: Event) => {
    location.route(withParam(key, (event.target as HTMLSelectElement).value));
  };

  return (
    <div class="page-sessions">
      <Topbar currentPage="sessions" right={<span class="pending-count">{rows.length} shown</span>} />
      <main>
        <h1>Sessions</h1>
        <div class="filters">
          <label>window
            <select value={win} onChange={onSelect('window')}>
              {WINDOWS.map((w) => <option value={w} key={w}>{w}</option>)}
            </select>
          </label>
          <label>status
            <select value={statusFilter} onChange={onSelect('status')}>
              {STATUSES.map((s) => <option value={s} key={s || 'any'}>{s || 'any'}</option>)}
            </select>
          </label>
          <label>trigger
            <select value={triggerFilter} onChange={onSelect('trigger')}>
              {TRIGGERS.map((t) => <option value={t} key={t || 'any'}>{t || 'any'}</option>)}
            </select>
          </label>
          {agentFilter && <a class="filter-clear" href={withParam('agent', '')}>agent: {agentFilter} ✕</a>}
          {approvalFilter && <a class="filter-clear" href={withParam('approval', '')}>approval: {approvalFilter} ✕</a>}
        </div>

        {resolvedError && <div class="errors">Failed to load sessions: {resolvedError.message}</div>}
        {resolvedData && resolvedData.errors.length > 0 && (
          <div class="errors">Some projects failed: <ul>{resolvedData.errors.map((e) => <li key={e.projectId}>{e.projectId}: {e.message}</li>)}</ul></div>
        )}
        {resolvedLoading && !resolvedData && <p class="empty">Loading sessions…</p>}
        {resolvedData && (rows.length === 0
          ? <p class="empty">No sessions in this window.</p>
          : <div class="rows">{rows.map((row) => <SessionRowView key={`${row.project}:${row.sessionId}`} row={row} multiProject={multiProject} />)}</div>)}
        <footer>{streamFallback ? 'auto-refreshes every 10s' : 'live updates'}</footer>
      </main>
    </div>
  );
}
