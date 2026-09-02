import { Fragment } from 'preact';
import { useLocation } from 'preact-iso';
import { useCallback, useEffect, useState } from 'preact/hooks';
import type { SessionRow, SessionsPayload } from '../lib/api';
import { fetchSessions, fetchAgents, postSessionStop } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useMediaQuery } from '../hooks/use-media-query';
import { useSessionsStream } from '../hooks/use-sessions-stream';
import { useTitle } from '../hooks/use-title';
import { Loading } from '../components/loading';
import { PushBell } from '../components/push-bell';
import { AgentFilterSelect } from '../components/agent-filter-select';
import { GroupRail } from '../components/group-rail';
import { LogContent } from '../components/content';
import { formatApprovalTime, formatRelativeTime, errorText, displayStatusLabel } from '../lib/format';
import { pageTitle } from '../lib/brand';
import { term } from '../lib/terms';
import { useSessionListView, type SessionListView } from '../hooks/use-session-list-view';
import { useLastVisit } from '../hooks/use-last-visit';
import { isAttentionSessionDismissed, useGlobalApprovals } from '../hooks/use-global-approvals';
import { isExecutingSessionStatus, isLiveSessionStatus, SESSION_STATUS_FILTERS } from '../../../../session/status';

const WINDOWS = ['1h', '6h', '24h', '7d', '30d', '90d', 'all'];
const STATUSES = SESSION_STATUS_FILTERS;
// Triage is orthogonal to status: has an ended run been reviewed-and-discarded?
// 'undismissed' composes with status=error to reproduce the home "attention"
// set (open failures), without conflating triage into the status axis.
const TRIAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'any' },
  { value: 'undismissed', label: 'undismissed' },
  { value: 'dismissed', label: 'dismissed' },
];
const TRIGGERS = ['', 'manual', 'scheduled', 'slack', 'api'];
// Mock/test runs are excluded server-side by default so ops views stay real;
// this filter opts them back in (or isolates them) for test-loop inspection.
const MOCK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'hidden' },
  { value: 'include', label: 'shown' },
  { value: 'only', label: 'only mock' },
];

/** An ended failed run the reviewer can wave off: same rule the server's
 *  needs-attention filter and the home panel use. USER_STOPPED runs were the
 *  operator's own doing (never re-surface); already-dismissed ones are done. */
function isDiscardable(row: SessionRow): boolean {
  return row.status === 'error' && row.errorCode !== 'USER_STOPPED' && row.dismissedAt === undefined;
}

interface AgentGroup { agentId: string; agentName: string; rows: SessionRow[] }

function agentGroupAnchor(agentId: string): string {
  return `session-agent-${agentId.replace(/[^a-zA-Z0-9_-]/g, '-')}`;
}

/** Rows folded into per-agent buckets, in first-seen order (rows already arrive newest first). */
function groupRowsByAgent(rows: SessionRow[]): AgentGroup[] {
  const groups = new Map<string, AgentGroup>();
  for (const row of rows) {
    const revision = row.purpose?.kind === 'agent-revision' ? row.purpose : undefined;
    const agentId = revision ? 'internal:agent-revision' : row.agent.id;
    let group = groups.get(agentId);
    if (!group) {
      group = {
        agentId,
        agentName: revision ? 'Internal revisions' : row.agent.name || row.agent.id,
        rows: [],
      };
      groups.set(agentId, group);
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
  dismissed: boolean;
  onDiscard: (row: SessionRow) => void;
}) {
  const { row, view, multiProject, filterHref, statusFilter, triggerFilter, agentFilter, dismissed, onDiscard } = props;
  const href = `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;
  // A failed run the reviewer can wave off. Once dismissed (here or on the
  // server) the button gives way to a "dismissed" chip so the row's triage
  // state is always legible, the gap the raw error list left open.
  const discardable = isDiscardable(row) && !dismissed;
  const discardButton = discardable
    ? (
      <button
        type="button"
        class="row-discard"
        title="Mark reviewed and drop from Needs your attention"
        onClick={(event) => { event.preventDefault(); event.stopPropagation(); onDiscard(row); }}
      >Discard</button>
    )
    : null;
  const dismissedChip = dismissed ? <span class="chip dismissed" title="Reviewed and discarded">dismissed</span> : null;
  // stopped / timeout / incomplete render as their own chips (still status
  // 'error' on disk) so a skim distinguishes "crashed" from "agent declared
  // non-delivery" from "operator stopped it".
  const status = displayStatusLabel(row.status, row.errorCode);
  // A suspended parent parked on a running delegated child is live work, not a
  // human gate: show "running · subagent" with the running pill (statusKey drives
  // the CSS class, which keys off the status word). Filtering stays on raw status.
  const subagentActive = row.subagentActive === true;
  const statusText = subagentActive ? 'running · subagent' : status;
  const statusKey = subagentActive ? 'running' : status;
  // Status/trigger chips double as filter shortcuts: click applies that filter,
  // click again (when already applied) clears it. Incomplete is persisted as an
  // error with code INCOMPLETE, but it has its own API filter so the displayed
  // label remains a precise shortcut. Summary rows use a stretched title link;
  // feed cards keep links in the rendered response independently clickable.
  const statusFilterValue = status === 'incomplete' ? 'incomplete' : row.status;
  const statusActive = statusFilter === statusFilterValue;
  const triggerActive = triggerFilter === row.trigger;
  const agentActive = agentFilter === row.agent.id;
  const revision = row.purpose?.kind === 'agent-revision' ? row.purpose : undefined;
  const displayName = revision
    ? `Revising ${revision.targetAgentName}`
    : row.agent.name || row.agent.id;
  const originHref = revision
    ? `/sessions/${encodeURIComponent(revision.originSessionId)}?project=${encodeURIComponent(row.project)}`
    : undefined;
  const avatar = (row.agent.name || row.agent.id)
    .split(/[\s/_-]+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((word) => word[0])
    .join('')
    .toUpperCase();
  return (
    <div
      class={`row${view === 'feed' ? ' session-feed-card' : ''}${dismissed ? ' is-dismissed' : ''}`}
      role={view === 'feed' ? 'article' : undefined}
      aria-label={view === 'feed' ? `${displayName} session` : undefined}
      // Programmatically focusable (never in the Tab order): j/k move focus card
      // to card, and the focused card is what Space expands.
      tabIndex={view === 'feed' ? -1 : undefined}
    >
      {view === 'summary'
        ? (
          <>
            <div class="row-head">
              <a
                class={statusClass(statusKey)}
                href={filterHref('status', statusActive ? '' : statusFilterValue)}
                title={statusActive ? `Stop filtering by status: ${statusFilterValue}` : `Filter sessions by status: ${statusFilterValue}`}
              >{statusText}</a>
              {multiProject && <span class="chip project">{row.project}</span>}
              {revision
                ? <span class="chip internal">internal revision</span>
                : <><a
                  class="chip trigger"
                  href={filterHref('trigger', triggerActive ? '' : row.trigger)}
                  title={triggerActive ? `Stop filtering by trigger: ${row.trigger}` : `Filter sessions by trigger: ${row.trigger}`}
                >{row.trigger}</a><a
                  class="chip agent"
                  href={filterHref('agent', agentActive ? '' : row.agent.id)}
                  title={agentActive ? `Stop filtering by agent: ${row.agent.id}` : `Filter sessions by agent: ${row.agent.id}`}
                >{row.agent.id}</a></>}
              {row.mock && <span class="chip mock">mock</span>}
              {dismissedChip}
              <span class="row-time" title={formatApprovalTime(row.createdAt)}>{formatRelativeTime(row.createdAt)}</span>
              {discardButton}
            </div>
            <a class="row-title row-link" href={href}>{displayName}</a>
            {revision
              ? <div class="row-sub">AgentUse internal session · From session {revision.originSessionId.slice(0, 8)}…</div>
              : row.agent.description && <div class="row-sub">{row.agent.description}</div>}
            {row.errorMessage && <div class="row-decision">{errorText(row.errorMessage)}</div>}
          </>
        )
        : (
          <div class="session-feed-header">
            {/* The initials tile carries the agent filter: the card title is the
                agent's name, so repeating its id in the byline (as the row view
                does) would only duplicate what is already on screen. */}
            {revision
              ? <span class="session-feed-avatar is-internal" aria-hidden="true">↻</span>
              : <a
                class="session-feed-avatar"
                href={filterHref('agent', agentActive ? '' : row.agent.id)}
                title={agentActive ? `Stop filtering by agent: ${row.agent.id}` : `Filter sessions by agent: ${row.agent.id}`}
                aria-label={agentActive ? `Stop filtering by agent: ${row.agent.id}` : `Filter sessions by agent: ${row.agent.id}`}
              >{avatar}</a>}
            <div class="session-feed-identity">
              <a class="row-title" href={href}>{displayName}</a>
              {!revision && row.agent.description && <div class="row-sub">{row.agent.description}</div>}
              <div class="session-feed-byline">
                {revision
                  ? <><span class="chip internal">internal revision</span><span aria-hidden="true">·</span><a href={originHref}>from session {revision.originSessionId.slice(0, 8)}…</a></>
                  : <a
                    href={filterHref('trigger', triggerActive ? '' : row.trigger)}
                    title={triggerActive ? `Stop filtering by trigger: ${row.trigger}` : `Filter sessions by trigger: ${row.trigger}`}
                  >{row.trigger}</a>}
                {multiProject && <><span aria-hidden="true">·</span><span>{row.project}</span></>}
                {row.mock && <><span aria-hidden="true">·</span><span>mock</span></>}
                <span aria-hidden="true">·</span>
                <span title={formatApprovalTime(row.createdAt)}>{formatRelativeTime(row.createdAt)}</span>
              </div>
            </div>
            <div class="session-feed-status">
              {dismissedChip}
              <a
                class={statusClass(statusKey)}
                href={filterHref('status', statusActive ? '' : statusFilterValue)}
                title={statusActive ? `Stop filtering by status: ${statusFilterValue}` : `Filter sessions by status: ${statusFilterValue}`}
              >{statusText}</a>
            </div>
          </div>
        )}
      {view === 'feed' && row.errorMessage && <div class="session-feed-error">{errorText(row.errorMessage)}</div>}
      {view === 'feed' && (
        <FeedResponse
          value={row.finalResponse}
          status={status}
          subagentActive={subagentActive}
          href={href}
        />
      )}
      {view === 'summary'
        ? <div class="row-meta"><code>{row.sessionId}</code></div>
        : (
          <div class="session-feed-footer">
            <code>{row.sessionId}</code>
            {discardButton}
            <a class="session-feed-open" href={href}>Open session <span aria-hidden="true">→</span></a>
          </div>
        )}
    </div>
  );
}

/** The one line that answers "which of these have I already seen": everything
 *  above it started after the reader's previous visit. A single divider, not a
 *  per-session read flag, so nothing has to be marked, synced, or cleaned up. */
export function NewSinceLastVisit(props: { count: number }) {
  const label = `${props.count} new since your last visit`;
  return <div class="feed-watermark" role="separator" aria-label={label}>{label}</div>;
}

export function FeedResponse(props: { value: string | undefined; status: string; subagentActive?: boolean; href: string }) {
  const [expanded, setExpanded] = useState(false);
  const long = Boolean(props.value && (props.value.length > 1_800 || props.value.split(/\r?\n/).length > 18));
  // subagentActive reads as live (like running): the response lands when the
  // delegated sub-agent returns.
  const live = isLiveSessionStatus(props.status) || props.subagentActive === true;
  const emptyMessage = props.subagentActive
    ? 'Working in a delegated sub-agent. Its response will appear here when the sub-agent returns.'
    : props.status === 'preparing'
      ? 'Preparing project context. The agent will start when its safe workspace is ready.'
      : isExecutingSessionStatus(props.status)
      ? 'Agent is working. Its response will appear here as it becomes available.'
      : props.status === 'suspended' || props.status === 'waiting'
        ? 'Waiting on an approval or a delegated sub-agent. No final response yet.'
        : 'This session ended without a final response.';

  return (
    <div class="session-feed-response" aria-live={live ? 'polite' : undefined}>
      <div class="session-feed-response-label">{live ? 'Latest response' : 'Final response'}</div>
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
  const triageFilter = q.triage || '';
  const triggerFilter = q.trigger || '';
  const agentFilter = q.agent || undefined;
  const approvalFilter = q.approval || undefined;
  const mockFilter = q.mock === 'include' || q.mock === 'only' ? q.mock : '';
  const mockParam = mockFilter === '' ? undefined : mockFilter;
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
    triageFilter !== '',
    triggerFilter !== '',
    mockFilter !== '',
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
    ...(triageFilter ? [{ key: 'triage', label: 'Triage', value: triageFilter }] : []),
    ...(triggerFilter ? [{ key: 'trigger', label: 'Trigger', value: triggerFilter }] : []),
    ...(mockFilter ? [{ key: 'mock', label: 'Mock runs', value: mockFilter === 'only' ? 'only mock' : 'shown' }] : []),
    ...(agentFilter ? [{ key: 'agent', label: 'Agent', value: agentFilter }] : []),
    ...(approvalFilter ? [{ key: 'approval', label: 'Approval', value: approvalFilter }] : []),
  ];
  const advancedFilterCount = [triageFilter !== '', triggerFilter !== '', mockFilter !== ''].filter(Boolean).length;
  const [filtersOpen, setFiltersOpen] = useState(activeCount > 0);
  const [advancedFiltersOpen, setAdvancedFiltersOpen] = useState(advancedFilterCount > 0);
  const [groupByAgent, setGroupByAgent] = useState(false);
  useEffect(() => {
    if (advancedFilterCount > 0) setAdvancedFiltersOpen(true);
  }, [advancedFilterCount]);
  // App-root optimistic discard state lets Sessions and Home reconcile the
  // same action immediately, even while their independent SSE snapshots lag.
  const attentionState = useGlobalApprovals();

  const key = `sessions:${win}:${statusFilter}:${triageFilter}:${triggerFilter}:${mockFilter}:${agentFilter ?? ''}:${approvalFilter ?? ''}:${view}`;
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
      triage: triageFilter || undefined,
      trigger: triggerFilter || undefined,
      agent: agentFilter,
      approval: approvalFilter,
      limit: 50,
      detail: feedDetail,
      mock: mockParam,
    }),
    streamFallback ? { refreshMs: 10_000 } : {}
  );

  useEffect(() => {
    if (streamFallback) fetched.refetch();
  }, [streamFallback, fetched.refetch]);

  useSessionsStream({
    window: win,
    status: statusFilter || undefined,
    triage: triageFilter || undefined,
    trigger: triggerFilter || undefined,
    agent: agentFilter,
    approval: approvalFilter,
    limit: 50,
    detail: feedDetail,
    mock: mockParam,
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
  // Agent options are useful once the feed is visible, but building the full
  // fleet payload is not allowed to delay the session list itself.
  const agentsFetch = useFetch('sessions-agent-options', () => fetchAgents(), { enabled: resolvedData !== null });
  const agentOptions = (() => {
    const byId = new Map<string, string>();
    for (const a of agentsFetch.data?.agents ?? []) {
      const id = a.path.replace(/\.agentuse$/, '');
      if (!byId.has(id)) byId.set(id, a.name);
    }
    return [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  })();
  // Page 1 keeps refreshing (SSE snapshots / polling) while loadedMore holds
  // older rows, so the two can overlap; keep the first (freshest) copy of each
  // row so list keys stay unique.
  const seenRowKeys = new Set<string>();
  const rows = [...(resolvedData?.sessions ?? []), ...loadedMore].filter((row) => {
    const rowKey = `${row.project}\0${row.sessionId}`;
    if (seenRowKeys.has(rowKey)) return false;
    seenRowKeys.add(rowKey);
    // In the undismissed view an optimistically discarded row no longer belongs, so
    // hide it right away; every other view keeps it (marked "dismissed").
    if (triageFilter === 'undismissed' && isAttentionSessionDismissed(attentionState.dismissedAttentionSessions, row)) return false;
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
      const next = await fetchSessions({ window: win, status: statusFilter || undefined, triage: triageFilter || undefined, trigger: triggerFilter || undefined, agent: agentFilter, approval: approvalFilter, limit: 50, cursor: nextCursor, detail: feedDetail, mock: mockParam });
      setLoadedMore((current) => [...current, ...next.sessions]);
      setPagedCursor({ ...(next.nextCursor && { cursor: next.nextCursor }) });
    } finally {
      setLoadingMore(false);
    }
  };

  // Discard = the reviewer's "reviewed, wave it off" on an ended failed run.
  // Reuses the stop endpoint, which stamps dismissedAt for an already-ended
  // failed session (identical to the home panel's "×").
  const discardRow = useCallback((row: SessionRow) => {
    const identity = { project: row.project, sessionId: row.sessionId };
    attentionState.dismissAttentionSession(identity);
    postSessionStop(row.sessionId, undefined, { project: row.project, reason: 'Discarded from sessions list' })
      .catch(() => {
        // Discard did not land; restore the row so it isn't silently lost.
        attentionState.restoreAttentionSession(identity);
      });
  }, [attentionState.dismissAttentionSession, attentionState.restoreAttentionSession]);
  const isDismissed = (row: SessionRow): boolean =>
    row.dismissedAt !== undefined || isAttentionSessionDismissed(attentionState.dismissedAttentionSessions, row);

  // How far down the feed "you have already seen this" starts. Rows arrive
  // newest first, so the count of rows started since the last visit is also the
  // index the divider belongs at. Grouping by agent replaces the time ordering
  // the divider reads against, so it stands down there.
  const lastVisit = useLastVisit();
  const newSinceLastVisit = lastVisit === null || groupByAgent
    ? 0
    : rows.filter((row) => row.createdAt > lastVisit).length;

  // Feed keyboard nav: j/k step through the cards, Space expands/collapses the
  // one you are on, Enter opens it. The card that has DOM focus *is* the
  // selection, so live SSE snapshots, agent grouping and Load more can reshape
  // the list without a second source of truth drifting out of sync with it.
  useEffect(() => {
    if (view !== 'feed') return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key !== 'j' && event.key !== 'k' && event.key !== ' ' && event.key !== 'Enter') return;
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      // Text entry owns its keys, and while a dialog (palette, decision) is up
      // the keypress belongs to that surface.
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (document.querySelector('dialog[open], [role="dialog"]')) return;
      const cards = [...document.querySelectorAll<HTMLElement>('.session-feed-card')];
      if (cards.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const current = active?.closest<HTMLElement>('.session-feed-card') ?? null;
      const onInteractive = Boolean(active?.closest('a, button, select, summary, [role="button"]'));
      if (event.key === 'Enter') {
        // Opens through the card's own "Open session" link, so the keyboard
        // goes exactly where the pointer would (and through the SPA router
        // rather than a full page load).
        if (!current || onInteractive) return;
        event.preventDefault();
        current.querySelector<HTMLAnchorElement>('.session-feed-open')?.click();
        return;
      }
      if (event.key === ' ') {
        // Space drives the card's own Show more/less control, so keyboard and
        // pointer stay on one toggle. On a link or button inside the card the
        // browser's own activation wins. Cards short enough to render whole have
        // no toggle: swallow the key anyway rather than scrolling the selection
        // off screen.
        if (!current || onInteractive) return;
        event.preventDefault();
        current.querySelector<HTMLButtonElement>('.session-feed-more')?.click();
        // Same landing spot as j/k: collapsing from deep inside a long card
        // should return you to that card's top, not leave you mid-page.
        current.scrollIntoView({ block: 'start' });
        return;
      }
      event.preventDefault();
      const index = current ? cards.indexOf(current) : -1;
      // Clamped, not wrapping: j at the bottom should sit still, not teleport
      // back to the newest session.
      const next = event.key === 'j'
        ? cards[Math.min(index + 1, cards.length - 1)]
        : cards[Math.max(index - 1, 0)];
      next?.focus({ preventScroll: true });
      // Pin the card you moved to at the top of the reading area (scroll-margin
      // clears the sticky topbar), so every j/k lands the entry in the same
      // place instead of leaving it wherever it happened to sit.
      next?.scrollIntoView({ block: 'start' });
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [view]);

  // Build a URL that preserves the other active filters when one changes.
  // The window is carried only when the operator explicitly picked one: pinning
  // the resolved default (24h) into chip-built URLs would defeat the adaptive
  // 30d default that kicks in when an agent filter is applied.
  const withParam = (key: string, value: string): string => {
    const params = new URLSearchParams();
    const base: Record<string, string | undefined> = {
      window: q.window, status: statusFilter, triage: triageFilter, trigger: triggerFilter, mock: mockFilter, agent: agentFilter, approval: approvalFilter,
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
      <GroupRail items={railItems} />
      <main>
        <div class="sessions-head">
          <h1>Sessions <PushBell category="sessions" /></h1>
          <span class="sessions-count">{rows.length} in {win === 'all' ? 'all time' : win}</span>
        </div>
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
            <span class="filters-title">Filter sessions</span>
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
          <div class="filter-grid filter-grid-primary">
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
            <label class="filter-field filter-field-agent">agent
              <AgentFilterSelect options={agentOptions} value={agentFilter ?? ''} onChange={commitAgent} />
            </label>
          </div>
          <details
            class="filters-advanced"
            open={advancedFiltersOpen}
            onToggle={(event) => setAdvancedFiltersOpen(event.currentTarget.open)}
          >
            <summary>More filters{advancedFilterCount > 0 && <span>{advancedFilterCount}</span>}</summary>
            <div class="filter-grid filter-grid-advanced">
              <label class="filter-field filter-field-triage">triage
                <select value={triageFilter} onChange={onSelect('triage')}>
                  {TRIAGE_OPTIONS.map((t) => <option value={t.value} key={t.value || 'any'}>{t.label}</option>)}
                </select>
              </label>
              <label class="filter-field filter-field-trigger">trigger
                <select value={triggerFilter} onChange={onSelect('trigger')}>
                  {TRIGGERS.map((t) => <option value={t} key={t || 'any'}>{t || 'any'}</option>)}
                </select>
              </label>
              <label class="filter-field filter-field-mock">mock runs
                <select value={mockFilter} onChange={onSelect('mock')}>
                  {MOCK_OPTIONS.map((m) => <option value={m.value} key={m.value || 'hidden'}>{m.label}</option>)}
                </select>
              </label>
            </div>
          </details>
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
                const liveCount = group.rows.filter((r) => isExecutingSessionStatus(r.status) || r.subagentActive).length;
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
                          dismissed={isDismissed(row)}
                          onDiscard={discardRow}
                        />
                      ))}
                    </div>
                  </details>
                );
              })}</div>
            : <div class={`rows${view === 'feed' ? ' session-feed' : ''}`}>{rows.map((row, index) => (
              <Fragment key={`${row.project}:${row.sessionId}`}>
                {/* Nothing is drawn when every loaded row is new (no index can
                    equal the count): a line under the whole page would claim
                    the reader had seen sessions that simply are not loaded. */}
                {newSinceLastVisit > 0 && index === newSinceLastVisit && <NewSinceLastVisit count={newSinceLastVisit} />}
                <SessionRowView
                  row={row}
                  view={view}
                  multiProject={multiProject}
                  filterHref={withParam}
                  statusFilter={statusFilter}
                  triggerFilter={triggerFilter}
                  agentFilter={agentFilter ?? ''}
                  dismissed={isDismissed(row)}
                  onDiscard={discardRow}
                />
              </Fragment>
            ))}</div>)}
        {nextCursor && (
          <button type="button" class={loadingMore ? 'load-more btn-busy' : 'load-more'} onClick={loadMore} disabled={loadingMore}>
            {loadingMore ? <><span class="btn-spinner" aria-hidden="true" />Loading…</> : 'Load more'}
          </button>
        )}
        <footer>
          {streamFallback ? 'auto-refreshes every 10s' : 'live updates'}
          {view === 'feed' && !narrow && rows.length > 0 && (
            <span class="feed-keys"> · <kbd>j</kbd>/<kbd>k</kbd> move · <kbd>space</kbd> expand · <kbd>enter</kbd> open</span>
          )}
        </footer>
      </main>
    </div>
  );
}
