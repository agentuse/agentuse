import { useLocation } from 'preact-iso';
import { useEffect, useState } from 'preact/hooks';
import type { SessionRow, SessionsPayload } from '../lib/api';
import { fetchSessions, fetchAgents } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useMediaQuery } from '../hooks/use-media-query';
import { useSessionsStream } from '../hooks/use-sessions-stream';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { Loading } from '../components/loading';
import { PushBell } from '../components/push-bell';
import { AgentFilterSelect } from '../components/agent-filter-select';
import { GroupRail } from '../components/group-rail';
import { LogContent } from '../components/content';
import { formatApprovalTime, formatRelativeTime, errorText, displayStatusLabel } from '../lib/format';
import { pageTitle } from '../lib/brand';
import { term } from '../lib/terms';
import { useSessionListView, type SessionListView } from '../hooks/use-session-list-view';

const WINDOWS = ['1h', '6h', '24h', '7d', '30d', '90d', 'all'];
const STATUSES = ['', 'running', 'suspended', 'completed', 'error', 'incomplete'];
const TRIGGERS = ['', 'manual', 'scheduled', 'slack', 'api'];
const LIVE_SESSION_STATUSES = new Set(['running', 'resuming', 'continuing']);

interface AgentGroup { agentId: string; agentName: string; rows: SessionRow[] }

function agentGroupAnchor(agentId: string): string {
  return `session-agent-${agentId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** Rows folded into per-agent buckets, in first-seen order (rows already arrive newest first). */
function groupRowsByAgent(rows: SessionRow[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const row of rows) {
    let group = groups.get(row.agent.id);
    if (!group) {
      group = { agentId: row.agent.id, agentName: row.agent.name || row.agent.id, rows: [] };
      groups.set(row.agent.id, group);
    }
    group.rows.push(row);
  }
  return [...groups.values()];
}

// Map a raw session status to the status-chip class set used by the CSS.
function statusClass(status: string): string {
  return `chip status ${status}`;
}

export function SessionRowView(props: {
  row: SessionRow;
  view: SessionListView;
  multiProject: boolean;
  filterHref: (key: string, value: string) => string;
  statusFilter: string;
  triggerFilter: string;
  agentFilter: string;
}) {
  const { row, view, multiProject, filterHref, statusFilter, triggerFilter, agentFilter } = props;
  const href = `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;
  // stopped / timeout / incomplete render as their own chips (still status
  // 'error' on disk) so a skim distinguishes "crashed" from "agent declared
  // non-delivery" from "operator stopped it".
  const status = displayStatusLabel(row.status, row.errorCode);
  // Status/trigger chips double as filter shortcuts: click applies that filter,
  // click again (when already applied) clears it. Incomplete is persisted as an
  // error with code INCOMPLETE, but it has its own API filter so the displayed
  // label remains a precise shortcut. Summary rows use a stretched title link;
  // feed cards keep links in the rendered response independently clickable.
  const statusFilterValue = status === 'incomplete' ? 'incomplete' : row.status;
  const statusActive = statusFilter === statusFilterValue;
  const triggerActive = triggerFilter === row.trigger;
  const agentActive = agentFilter === row.agent.id;
  const avatar = (row.agent.name || row.agent.id)
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  return (
    <div
      class={`row${view === 'feed' ? ' session-feed-card' : ''}`}
      role={view === 'feed' ? 'article' : undefined}
      aria-label={view === 'feed' ? `${row.agent.name || row.agent.id} session` : undefined}
    >
      {view === 'summary'
        ? (
          <>
            <div class="row-head">
              <a
                class={statusClass(status)}
                href={filterHref('status', statusActive ? '' : statusFilterValue)}
                title={statusActive ? `Stop filtering by status: ${statusFilterValue}` : `Filter sessions by status: ${statusFilterValue}`}
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
          </>
        )
        : (
          <div class="session-feed-header">
            <div class="session-feed-avatar" aria-hidden="true">{avatar}</div>
            <div class="session-feed-identity">
              <a class="row-title" href={href}>{row.agent.name || row.agent.id}</a>
              {row.agent.description && <div class="row-sub">{row.agent.description}</div>}
              <div class="session-feed-byline">
                <a
                  href={filterHref('agent', agentActive ? '' : row.agent.id)}
                  title={agentActive ? `Stop filtering by agent: ${row.agent.id}` : `Filter sessions by agent: ${row.agent.id}`}
                >{row.agent.id}</a>
                <span aria-hidden="true">·</span>
                <a
                  href={filterHref('trigger', triggerActive ? '' : row.trigger)}
                  title={triggerActive ? `Stop filtering by trigger: ${row.trigger}` : `Filter sessions by trigger: ${row.trigger}`}
                >{row.trigger}</a>
                {multiProject && <><span aria-hidden="true">·</span><span>{row.project}</span></>}
                {row.mock && <><span aria-hidden="true">·</span><span>mock</span></>}
                <span aria-hidden="true">·</span>
                <span title={formatApprovalTime(row.createdAt)}>{formatRelativeTime(row.createdAt)}</span>
              </div>
            </div>
            <a
              class={statusClass(status)}
              href={filterHref('status', statusActive ? '' : statusFilterValue)}
              title={statusActive ? `Stop filtering by status: ${statusFilterValue}` : `Filter sessions by status: ${statusFilterValue}`}
            >{status}</a>
          </div>
        )}
      {view === 'feed' && row.errorMessage && <div class="session-feed-error">{errorText(row.errorMessage)}</div>}
      {view === 'feed' && (
        <FeedResponse
          value={row.finalResponse}
          status={status}
          href={href}
        />
      )}
      {view === 'summary'
        ? <div class="row-meta"><code>{row.sessionId}</code></div>
        : (
          <div class="session-feed-footer">
            <code>{row.sessionId}</code>
            <a class="session-feed-open" href={href}>Open session <span aria-hidden="true">→</span></a>
          </div>
        )}
    </div>
  );
}

export function FeedResponse(props: { value: string | undefined; status: string; href: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = Boolean(props.value && (props.value.length > 1_800 || props.value.split(/\r?\n/).length > 18));
  const emptyMessage = props.status === 'running'
    ? 'Agent is working. Its response will appear here as it becomes available.'
    : props.status === 'suspended'
      ? 'Waiting on an approval or a delegated sub-agent. No final response yet.'
      : 'This session ended without a final response.';

  return (
    <div class="session-feed-response" aria-live={props.status === 'running' ? 'polite' : undefined}>
      <div class="session-feed-response-label">{props.status === 'running' ? 'Latest response' : 'Final response'}</div>
      {props.value
        ? (
          <div class={`session-feed-content${long && !expanded ? ' is-collapsed' : ''}`}>
            <LogContent value={props.value} forceMarkdown />
          </div>
        )
        : <p class="session-feed-empty">{emptyMessage} <a href={props.href}>View session details</a></p>}
      {long && (
        <button
          type="button"
          class="session-feed-more"
          aria-expanded={expanded}
          onClick={() => setExpanded((current) => !current)}
        >{expanded ? 'Show less' : 'Show more'}</button>
      )}
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
  const { view } = useSessionListView();
  const feedDetail = view === 'feed' ? 'feed' as const : undefined;
  // Default to 24h for the general feed, but widen to 30d when an agent or
  // approval filter is active: those runs are often days old, and a 24h default
  // would show "no sessions" for an agent that simply hasn't run today.
  const defaultWin = agentFilter || approvalFilter ? '30d' : '24h';
  const win = q.window || defaultWin;

  useTitle(pageTitle('Sessions'));

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
  // The collapsed mobile control should still explain *which* sessions are in
  // view. Native selects hide that context until the operator reopens the
  // whole panel, so surface every non-default filter as a removable summary.
  // Keeping the time window out when it is the contextual default (24h, or
  // 30d for a selected agent) avoids presenting an implementation detail as an
  // active constraint.
  const activeFilters = [
    ...(win !== defaultWin ? [{ key: 'window', label: 'Time', value: win }] : []),
    ...(statusFilter ? [{ key: 'status', label: 'Status', value: statusFilter }] : []),
    ...(triggerFilter ? [{ key: 'trigger', label: 'Trigger', value: triggerFilter }] : []),
    ...(agentFilter ? [{ key: 'agent', label: 'Agent', value: agentFilter }] : []),
    ...(approvalFilter ? [{ key: 'approval', label: 'Approval', value: approvalFilter }] : []),
  ];
  const [filtersOpen, setFiltersOpen] = useState(activeCount > 0);
  const [groupByAgent, setGroupByAgent] = useState(false);

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

  const key = `sessions:${win}:${statusFilter}:${triggerFilter}:${agentFilter ?? ''}:${approvalFilter ?? ''}:${view}`;
  const [streamData, setStreamData] = useState<SessionsPayload | null>(null);
  const [streamError, setStreamError] = useState<Error | null>(null);
  const [streamFallback, setStreamFallback] = useState(false);
  const [loadedMore, setLoadedMore] = useState<SessionRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  // Cursor advanced by Load more. It must live outside the page-1 payload:
  // every SSE snapshot replaces streamData wholesale (always carrying page 1's
  // cursor), and in polling fallback resolvedData reads from fetched.data —
  // either way a cursor read back out of resolvedData never advances past
  // page 1. null = not paged yet; { cursor: undefined } = no further pages.
  const [pagedCursor, setPagedCursor] = useState<{ cursor?: string } | null>(null);

  useEffect(() => {
    setStreamData(null);
    setStreamError(null);
    setStreamFallback(false);
    setLoadedMore([]);
    setPagedCursor(null);
  }, [key]);

  const fetched = useFetch(
    key,
    () => fetchSessions({
      window: win,
      status: statusFilter || undefined,
      trigger: triggerFilter || undefined,
      agent: agentFilter,
      approval: approvalFilter,
      limit: 50,
      detail: feedDetail,
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
    limit: 50,
    detail: feedDetail,
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
  // Page 1 keeps refreshing (SSE snapshots / polling) while loadedMore holds
  // older rows, so the two can overlap; keep the first (freshest) copy of each
  // row so list keys stay unique.
  const seenRowKeys = new Set<string>();
  const rows = [...(resolvedData?.sessions ?? []), ...loadedMore].filter((row) => {
    const rowKey = `${row.project}\0${row.sessionId}`;
    if (seenRowKeys.has(rowKey)) return false;
    seenRowKeys.add(rowKey);
    return true;
  });
  const multiProject = new Set(rows.map((r) => r.project)).size > 1;
  const agentGroups = groupByAgent ? groupRowsByAgent(rows) : [];
  const railItems = agentGroups.map((g) => ({ id: agentGroupAnchor(g.agentId), label: g.agentName, count: g.rows.length }));
  // Empty-state escape hatch: the most common cause of "no sessions" is a
  // too-narrow window, so offer one jump to 30d (or all time from 30d/90d)
  // rather than making the operator walk the select.
  const widerWindow = WINDOWS.indexOf(win) < WINDOWS.indexOf('30d') ? '30d' : 'all';
  const nextCursor = pagedCursor ? pagedCursor.cursor : resolvedData?.nextCursor;
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await fetchSessions({ window: win, status: statusFilter || undefined, trigger: triggerFilter || undefined, agent: agentFilter, approval: approvalFilter, limit: 50, cursor: nextCursor, detail: feedDetail });
      setLoadedMore((current) => [...current, ...next.sessions]);
      setPagedCursor({ ...(next.nextCursor && { cursor: next.nextCursor }) });
    } finally {
      setLoadingMore(false);
    }
  };

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
      <GroupRail items={railItems} />
      <main>
        <h1>Sessions <PushBell category="sessions" /></h1>
        {narrow && (
          <div class="filters-summary">
            <button
              type="button"
              class={`filters-toggle${filtersOpen ? ' is-open' : ''}`}
              aria-expanded={filtersOpen}
              aria-controls="session-filters"
              onClick={() => setFiltersOpen((o) => !o)}
            >
              <span>filters</span>
              {activeCount > 0 && <span class="filters-toggle-count">{activeCount}</span>}
              <span class="filters-toggle-caret" aria-hidden="true">⌄</span>
            </button>
            <div class="active-filters" aria-live="polite">
              {activeFilters.length > 0
                ? activeFilters.map((filter) => (
                  <a
                    class="active-filter"
                    href={withParam(filter.key, '')}
                    key={filter.key}
                    title={`Remove ${filter.label.toLowerCase()} filter: ${filter.value}`}
                  >
                    <span class="active-filter-label">{filter.label}</span>
                    <span class="active-filter-value">{filter.value}</span>
                    <span class="active-filter-remove" aria-hidden="true">×</span>
                  </a>
                ))
                : <span class="filters-context">all sessions · {win}</span>}
            </div>
            {activeCount > 0 && <a class="filters-reset" href="/sessions">Clear</a>}
          </div>
        )}
        <div id="session-filters" class={`filters${narrow && !filtersOpen ? ' collapsed' : ''}`}>
          <div class="filters-heading">
            <div>
              <div class="filters-title">Filter sessions</div>
              <div class="filters-description">Narrow the live feed by time, state, source, or agent.</div>
            </div>
            <div class="filters-heading-actions">
              <button
                type="button"
                class={groupByAgent ? 'group-toggle on' : 'group-toggle'}
                aria-pressed={groupByAgent}
                onClick={() => setGroupByAgent((v) => !v)}
                title={groupByAgent ? 'Show a flat list' : 'Collapse concurrent sessions under their agent'}
              >group by agent</button>
              {activeCount > 0 && <a class="filters-reset" href="/sessions">Clear all</a>}
            </div>
          </div>
          <div class="filter-grid">
            <label class="filter-field filter-field-window">window
              <select value={win} onChange={onSelect('window')}>
                {WINDOWS.map((w) => <option value={w} key={w}>{w}</option>)}
              </select>
            </label>
            <label class="filter-field filter-field-status">status
              <select value={statusFilter} onChange={onSelect('status')}>
                {STATUSES.map((s) => <option value={s} key={s || 'any'}>{s || 'any'}</option>)}
              </select>
            </label>
            <label class="filter-field filter-field-trigger">trigger
              <select value={triggerFilter} onChange={onSelect('trigger')}>
                {TRIGGERS.map((t) => <option value={t} key={t || 'any'}>{t || 'any'}</option>)}
              </select>
            </label>
            <label class="filter-field filter-field-agent">agent
              <AgentFilterSelect options={agentOptions} value={agentFilter ?? ''} onChange={commitAgent} />
            </label>
          </div>
        </div>

        {resolvedError && <div class="errors" role="alert">Failed to load sessions: {resolvedError.message}</div>}
        {resolvedData && resolvedData.errors.length > 0 && (
          <div class="errors" role="alert">Some {term('project', 2)} failed: <ul>{resolvedData.errors.map((e) => <li key={e.projectId}>{e.projectId}: {e.message}</li>)}</ul></div>
        )}
        {resolvedLoading && !resolvedData && <Loading label="Loading sessions…" />}
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
          : groupByAgent
            ? <div class="agent-groups">{agentGroups.map((group) => {
                const liveCount = group.rows.filter((r) => LIVE_SESSION_STATUSES.has(r.status)).length;
                return (
                  <details class="agent-group" open id={agentGroupAnchor(group.agentId)} key={group.agentId}>
                    <summary>
                      <span class="agent-group-name">{group.agentName}</span>
                      {liveCount > 0 && <span class="agent-group-live">{liveCount} running</span>}
                      <span class="agent-group-count">{group.rows.length}</span>
                      <span class="agent-group-rule"></span>
                    </summary>
                    <div class={`rows${view === 'feed' ? ' session-feed' : ''}`}>
                      {group.rows.map((row) => (
                        <SessionRowView
                          key={`${row.project}:${row.sessionId}`}
                          row={row}
                          view={view}
                          multiProject={multiProject}
                          filterHref={withParam}
                          statusFilter={statusFilter}
                          triggerFilter={triggerFilter}
                          agentFilter={agentFilter ?? ''}
                        />
                      ))}
                    </div>
                  </details>
                );
              })}</div>
            : <div class={`rows${view === 'feed' ? ' session-feed' : ''}`}>{rows.map((row) => (
              <SessionRowView
                key={`${row.project}:${row.sessionId}`}
                row={row}
                view={view}
                multiProject={multiProject}
                filterHref={withParam}
                statusFilter={statusFilter}
                triggerFilter={triggerFilter}
                agentFilter={agentFilter ?? ''}
              />
            ))}</div>)}
        {nextCursor && (
          <button type="button" class={loadingMore ? 'load-more btn-busy' : 'load-more'} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <><span class="btn-spinner" aria-hidden="true" />Loading…</> : 'Load more'}
          </button>
        )}
        <footer>{streamFallback ? 'auto-refreshes every 10s' : 'live updates'}</footer>
      </main>
    </div>
  );
}
