import { useLocation } from 'preact-iso';
import { useEffect, useState } from 'preact/hooks';
import type { SessionRow, SessionsPayload } from '../lib/api';
import { fetchSessions, fetchAgents } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useMediaQuery } from '../hooks/use-media-query';
import { useSessionsStream } from '../hooks/use-sessions-stream';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { PushBell } from '../components/push-bell';
import { AgentFilterSelect } from '../components/agent-filter-select';
import { formatApprovalTime, formatRelativeTime, errorText, displayStatusLabel } from '../lib/format';

const WINDOWS = ['1h', '6h', '24h', '7d', '30d', '90d', 'all'];
const STATUSES = ['', 'running', 'suspended', 'completed', 'error'];
const TRIGGERS = ['', 'manual', 'scheduled', 'slack', 'api'];

// Map a raw session status to the status-chip class set used by the CSS.
function statusClass(status: string): string {
  return `chip status ${status}`;
}

function SessionRowView(props: {
  row: SessionRow;
  multiProject: boolean;
  filterHref: (key: string, value: string) => string;
  statusFilter: string;
  triggerFilter: string;
  agentFilter: string;
}) {
  const { row, multiProject, filterHref, statusFilter, triggerFilter, agentFilter } = props;
  const href = `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;
  // stopped / timeout / incomplete render as their own chips (still status
  // 'error' on disk) so a skim distinguishes "crashed" from "agent declared
  // non-delivery" from "operator stopped it".
  const status = displayStatusLabel(row.status, row.errorCode);
  // Status/trigger chips double as filter shortcuts: click applies that filter,
  // click again (when already applied) clears it. The status chip filters by the
  // on-disk status (`error`), not the display label (`timeout`), because that is
  // what the API accepts. The row itself is a div with a stretched link on the
  // title so the chips are real anchors, not links nested inside a link.
  const statusActive = statusFilter === row.status;
  const triggerActive = triggerFilter === row.trigger;
  const agentActive = agentFilter === row.agent.id;
  return (
    <div class="row">
      <div class="row-head">
        <a
          class={statusClass(status)}
          href={filterHref('status', statusActive ? '' : row.status)}
          title={statusActive ? `Stop filtering by status: ${row.status}` : `Filter sessions by status: ${row.status}`}
        >{status}</a>
        {multiProject && <span class="chip project">{row.project}</span>}
        <a
          class="chip trigger"
          href={filterHref('trigger', triggerActive ? '' : row.trigger)}
          title={triggerActive ? `Stop filtering by trigger: ${row.trigger}` : `Filter sessions by trigger: ${row.trigger}`}
        >{row.trigger}</a>
        <a
          class="chip agent"
          href={filterHref('agent', agentActive ? '' : row.agent.id)}
          title={agentActive ? `Stop filtering by agent: ${row.agent.id}` : `Filter sessions by agent: ${row.agent.id}`}
        >{row.agent.id}</a>
        {row.mock && <span class="chip mock">mock</span>}
        <span class="row-time" title={formatApprovalTime(row.createdAt)}>{formatRelativeTime(row.createdAt)}</span>
      </div>
      <a class="row-title row-link" href={href}>{row.agent.name || row.agent.id}</a>
      {row.agent.description && <div class="row-sub">{row.agent.description}</div>}
      {row.errorMessage && <div class="row-decision">{errorText(row.errorMessage)}</div>}
      <div class="row-meta"><code>{row.sessionId}</code></div>
    </div>
  );
}

export default function SessionsList() {
  const location = useLocation();
  const q = location.query;
  const statusFilter = q.status || '';
  const triggerFilter = q.trigger || '';
  const agentFilter = q.agent || undefined;
  const approvalFilter = q.approval || undefined;
  // Default to 24h for the general feed, but widen to 30d when an agent or
  // approval filter is active: those runs are often days old, and a 24h default
  // would show "no sessions" for an agent that simply hasn't run today.
  const defaultWin = agentFilter || approvalFilter ? '30d' : '24h';
  const win = q.window || defaultWin;

  useTitle('AgentUse / Sessions');

  // On phones the four-filter row fills the first screen before any session
  // shows, so collapse it behind a toggle. Start expanded when a non-default
  // filter is already applied - the operator is mid-narrowing and needs to see
  // (and clear) it. Desktop keeps the row always visible.
  const narrow = useMediaQuery('(max-width: 700px)');
  const activeCount = [
    win !== defaultWin,
    statusFilter !== '',
    triggerFilter !== '',
    Boolean(agentFilter),
    Boolean(approvalFilter),
  ].filter(Boolean).length;
  const [filtersOpen, setFiltersOpen] = useState(activeCount > 0);

  // Agent list powers the filter's type-ahead so operators pick a real agent id
  // instead of guessing a substring (which silently misses renamed/moved ids).
  const agentsFetch = useFetch('sessions-agent-options', () => fetchAgents(), {});
  const agentOptions = (() => {
    const byId = new Map<string, string>();
    for (const a of agentsFetch.data?.agents ?? []) {
      const id = a.path.replace(/\.agentuse$/, '');
      if (!byId.has(id)) byId.set(id, a.name);
    }
    return [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  })();

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
  // Empty-state escape hatch: the most common cause of "no sessions" is a
  // too-narrow window, so offer one jump to 30d (or all time from 30d/90d)
  // rather than making the operator walk the select.
  const widerWindow = WINDOWS.indexOf(win) < WINDOWS.indexOf('30d') ? '30d' : 'all';

  // Build a URL that preserves the other active filters when one changes.
  // The window is carried only when the operator explicitly picked one: pinning
  // the resolved default (24h) into chip-built URLs would defeat the adaptive
  // 30d default that kicks in when an agent filter is applied.
  const withParam = (key: string, value: string): string => {
    const params = new URLSearchParams();
    const base: Record<string, string | undefined> = {
      window: q.window, status: statusFilter, trigger: triggerFilter, agent: agentFilter, approval: approvalFilter,
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

  // Commit the agent filter on change/Enter (not per keystroke), navigating only
  // when the value actually differs from what's already applied.
  const commitAgent = (value: string) => {
    const next = value.trim();
    if (next === (agentFilter ?? '')) return;
    location.route(withParam('agent', next));
  };

  return (
    <div class="page-sessions">
      <Topbar currentPage="sessions" right={<span class="pending-count">{rows.length} in {win === 'all' ? 'all time' : win}</span>} />
      <main>
        <h1>Sessions <PushBell category="sessions" /></h1>
        {narrow && (
          <button
            type="button"
            class="filters-toggle"
            aria-expanded={filtersOpen}
            aria-controls="session-filters"
            onClick={() => setFiltersOpen((o) => !o)}
          >
            filters{activeCount ? ` (${activeCount} active)` : ''}
          </button>
        )}
        <div id="session-filters" class={`filters${narrow && !filtersOpen ? ' collapsed' : ''}`}>
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
          <label>agent
            <AgentFilterSelect options={agentOptions} value={agentFilter ?? ''} onChange={commitAgent} />
          </label>
          {approvalFilter && <a class="filter-clear" href={withParam('approval', '')}>approval: {approvalFilter} ✕</a>}
        </div>

        {resolvedError && <div class="errors" role="alert">Failed to load sessions: {resolvedError.message}</div>}
        {resolvedData && resolvedData.errors.length > 0 && (
          <div class="errors" role="alert">Some projects failed: <ul>{resolvedData.errors.map((e) => <li key={e.projectId}>{e.projectId}: {e.message}</li>)}</ul></div>
        )}
        {resolvedLoading && !resolvedData && <p class="empty">Loading sessions…</p>}
        {resolvedData && (rows.length === 0
          ? (
            <p class="empty">
              {activeCount > 0 ? 'No sessions match the current filters.' : 'No sessions in this window.'}
              {win !== 'all' && (
                <a class="empty-action" href={withParam('window', widerWindow)}>
                  {widerWindow === 'all' ? 'Search all time' : `Widen to ${widerWindow}`}
                </a>
              )}
              {activeCount > 0 && <a class="empty-action" href="/sessions">Clear all filters</a>}
            </p>
          )
          : <div class="rows">{rows.map((row) => (
            <SessionRowView
              key={`${row.project}:${row.sessionId}`}
              row={row}
              multiProject={multiProject}
              filterHref={withParam}
              statusFilter={statusFilter}
              triggerFilter={triggerFilter}
              agentFilter={agentFilter ?? ''}
            />
          ))}</div>)}
        <footer>{streamFallback ? 'auto-refreshes every 10s' : 'live updates'}</footer>
      </main>
    </div>
  );
}
