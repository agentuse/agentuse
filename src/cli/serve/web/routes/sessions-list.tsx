import { Fragment, type ComponentChildren } from 'preact';
import { useLocation } from 'preact-iso';
import { useCallback, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { SessionRow, SessionsPayload } from '../lib/api';
import { fetchSessions, fetchAgents, runAgentDetached } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useMediaQuery } from '../hooks/use-media-query';
import { useSessionsStream } from '../hooks/use-sessions-stream';
import { useTitle } from '../hooks/use-title';
import { Loading } from '../components/loading';
import { PushBell } from '../components/push-bell';
import { AgentFilterSelect } from '../components/agent-filter-select';
import { LogContent } from '../components/content';
import { writeClipboardText } from '../lib/clipboard';
import { formatApprovalTime, errorText, displayStatusLabel } from '../lib/format';
import { pageTitle } from '../lib/brand';
import { term } from '../lib/terms';
import { isExecutingSessionStatus, isIncompleteOutcome, isLiveSessionStatus } from '../../../../session/status';

/** Time windows offered as the list's segmented control. */
const WINDOWS = ['24h', '7d', '30d', 'all'];
/** Windows the URL accepts but the segmented control does not show. */
const EXTRA_WINDOWS = ['1h', '6h', '90d'];
const TRIAGE_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'any' },
  { value: 'undismissed', label: 'undismissed' },
  { value: 'dismissed', label: 'dismissed' },
];
const TRIGGERS = ['', 'manual', 'scheduled', 'slack', 'api'];
const MOCK_OPTIONS: Array<{ value: string; label: string }> = [
  { value: '', label: 'hidden' },
  { value: 'include', label: 'shown' },
  { value: 'only', label: 'only mock' },
];
const PHONE_QUERY = '(max-width: 700px)';

export function rowKey(row: Pick<SessionRow, 'project' | 'sessionId'>): string {
  return `${row.project}:${row.sessionId}`;
}

export function sessionHref(row: Pick<SessionRow, 'project' | 'sessionId'>): string {
  return `/sessions/${encodeURIComponent(row.sessionId)}?project=${encodeURIComponent(row.project)}`;
}

export function isRunningRow(row: Pick<SessionRow, 'status' | 'subagentActive'>): boolean {
  return isExecutingSessionStatus(row.status) || row.subagentActive === true;
}

/** The five dots the list uses. A run the agent declared incomplete gets its
 *  own dot: it did not crash, it stopped short and wants a human — a skim
 *  should tell the two apart. Everything else reads as an ordinary finished
 *  run. */
export function statusDot(
  row: Pick<SessionRow, 'status' | 'subagentActive' | 'errorCode'>
): 'running' | 'waiting' | 'failed' | 'incomplete' | 'done' {
  if (isRunningRow(row)) return 'running';
  if (isLiveSessionStatus(row.status)) return 'waiting';
  if (isIncompleteOutcome(row.status, row.errorCode)) return 'incomplete';
  if (row.status === 'error') return 'failed';
  return 'done';
}

export function displayName(row: SessionRow): string {
  const revision = row.purpose?.kind === 'agent-revision' ? row.purpose : undefined;
  return revision ? `Revising ${revision.targetAgentName}` : row.agent.name || row.agent.id;
}

/**
 * The one line under an agent name: what the run actually said. Markdown is
 * stripped rather than rendered, because a list line has no room for structure
 * and a stray `**` reads as noise.
 */
export function outputPreview(value: string | undefined): string {
  if (!value) return '';
  let heading = '';
  for (const raw of value.split(/\r?\n/)) {
    const isHeading = /^\s*#{1,6}\s/.test(raw);
    const line = raw
      .replace(/^\s*[#>]+\s*/, '')
      .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
      .replace(/^\s*\|/, '')
      .replace(/`{1,3}([^`]*)`{1,3}/g, '$1')
      .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
      .replace(/(\*\*|__|\*|_|~~)/g, '')
      .trim();
    if (!line || /^[-=|:\s]+$/.test(line)) continue;
    // A heading is usually the run's own label ("Inbox triage"), which the agent
    // name already says. Prefer the first line of substance, and fall back to
    // the heading only when the output is nothing but headings.
    if (isHeading) {
      if (!heading) heading = line;
      continue;
    }
    return line;
  }
  return heading;
}

export function formatElapsed(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return minutes % 60 === 0 ? `${hours}h` : `${hours}h ${minutes % 60}m`;
}

function clockTime(value: number): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

function dayKey(value: number): string {
  const date = new Date(value);
  return `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
}

export function dayLabel(value: number, now: number = Date.now()): string {
  const today = new Date(now);
  const yesterday = new Date(now - 86_400_000);
  if (dayKey(value) === dayKey(today.getTime())) return 'Today';
  if (dayKey(value) === dayKey(yesterday.getTime())) return 'Yesterday';
  return new Date(value).toLocaleDateString(undefined, { weekday: 'short', day: 'numeric', month: 'short' });
}

/** Wraps every case-insensitive hit on `query` in <mark>, so a search result
 *  shows *why* it matched instead of leaving the reader to find the word. */
export function Highlight(props: { text: string; query: string }): ComponentChildren {
  const query = props.query.trim();
  if (!query) return props.text;
  const lower = props.text.toLowerCase();
  const needle = query.toLowerCase();
  const parts: ComponentChildren[] = [];
  let cursor = 0;
  for (;;) {
    const at = lower.indexOf(needle, cursor);
    if (at === -1) break;
    if (at > cursor) parts.push(props.text.slice(cursor, at));
    parts.push(<mark>{props.text.slice(at, at + needle.length)}</mark>);
    cursor = at + needle.length;
  }
  if (parts.length === 0) return props.text;
  if (cursor < props.text.length) parts.push(props.text.slice(cursor));
  return <>{parts}</>;
}

/**
 * One run in the left list: a status dot, the agent name, and a single line of
 * what the run produced. Name and line are stacked so the line can be long
 * enough to answer "is this the run I want" without opening it.
 */
export function SessionListItem(props: {
  row: SessionRow;
  selected: boolean;
  query: string;
  href: string;
  now?: number | undefined;
  onSelect?: ((event: MouseEvent) => void) | undefined;
}) {
  const { row, selected, query } = props;
  const dot = statusDot(row);
  const running = dot === 'running';
  const name = displayName(row);
  const failed = row.status === 'error';
  const incomplete = dot === 'incomplete';
  const now = props.now ?? Date.now();

  let line: ComponentChildren;
  let lineClass = 'it-line';
  if (running) {
    lineClass = 'it-line live';
    line = `Working · ${formatElapsed(now - row.createdAt)}`;
  } else if (dot === 'waiting') {
    lineClass = 'it-line live';
    line = 'Waiting on you';
  } else if (failed) {
    // An incomplete run reads in amber and leads with its reason: the code word
    // is already the dot's colour, and the reason is what a reader acts on.
    lineClass = incomplete ? 'it-line warn' : 'it-line err';
    const detail = errorText(row.errorMessage);
    const code = incomplete ? displayStatusLabel(row.status, row.errorCode) : row.errorCode;
    line = [code, detail].filter(Boolean).join(' · ') || displayStatusLabel(row.status, row.errorCode);
  } else {
    const preview = outputPreview(row.finalResponse);
    line = preview
      ? <Highlight text={preview} query={query} />
      : 'No final output.';
    if (!preview) lineClass = 'it-line is-empty';
  }

  return (
    <a
      class={`it${selected ? ' sel' : ''}`}
      href={props.href}
      aria-current={selected ? 'true' : undefined}
      data-session-item={rowKey(row)}
      onClick={props.onSelect}
    >
      <span class={`dot ${dot}`} aria-hidden="true" />
      <span class="it-body">
        <span class="it-agent"><Highlight text={name} query={query} /></span>
        <span class={lineClass}>{line}</span>
      </span>
      <span class="it-time" title={formatApprovalTime(row.createdAt)}>
        {running ? 'now' : clockTime(row.createdAt)}
      </span>
    </a>
  );
}

/** The reader pane: the whole final output, plus the three things a reader does
 *  with it (copy it, run the agent again, open the full session). */
export function SessionReader(props: {
  row: SessionRow;
  newer?: SessionRow | undefined;
  older?: SessionRow | undefined;
  onNavigate?: (row: SessionRow) => void;
  showKeyHints?: boolean;
  copySignal?: number | undefined;
  /** Phone reader: the same three actions, in labels that fit one row. */
  compact?: boolean | undefined;
}) {
  const { row } = props;
  const location = useLocation();
  const [copied, setCopied] = useState(false);
  const [running, setRunning] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const live = isRunningRow(row) || isLiveSessionStatus(row.status);
  const status = displayStatusLabel(row.status, row.errorCode);
  const statusText = row.subagentActive ? 'running · subagent' : status;

  const copy = useCallback(() => {
    if (!row.finalResponse) return;
    void writeClipboardText(row.finalResponse).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1_500);
    });
  }, [row.finalResponse]);

  // `c` is handled by the page's one keydown listener; it nudges this counter
  // rather than reaching into the pane, so the shortcut and the button run the
  // exact same copy.
  const signal = props.copySignal ?? 0;
  const lastSignal = useRef(signal);
  useEffect(() => {
    if (signal !== lastSignal.current) {
      lastSignal.current = signal;
      copy();
    }
  }, [signal, copy]);

  useEffect(() => { setCopied(false); setRunError(null); }, [rowKey(row)]);

  const runAgain = async () => {
    const path = row.agent.filePath ?? row.agent.id;
    if (running) return;
    setRunning(true);
    setRunError(null);
    try {
      const res = await runAgentDetached(path, row.project);
      const params = new URLSearchParams({ pending: '1', project: row.project });
      if (res.token) params.set('token', res.token);
      location.route(`/sessions/${encodeURIComponent(res.sessionId)}?${params.toString()}`);
    } catch (err) {
      setRunError((err as Error).message);
      setRunning(false);
    }
  };

  return (
    <section class="reader" aria-label={`${displayName(row)} output`}>
      <div class="reader-head">
        <div class="reader-identity">
          <div class="reader-title">{displayName(row)}</div>
          <div class="reader-meta">
            <span class={`chip status ${row.subagentActive ? 'running' : status}`}>{statusText}</span>
            <span class="chip trigger">{row.trigger}</span>
            <span>{formatApprovalTime(row.createdAt)}</span>
            <span>{formatElapsed(Math.max(0, row.updatedAt - row.createdAt))}</span>
            <code>{row.sessionId}</code>
          </div>
        </div>
        <div class="reader-actions">
          <button
            type="button"
            class="btn primary"
            onClick={copy}
            disabled={!row.finalResponse}
            title={row.finalResponse ? 'Copy the final output as Markdown' : 'This run produced no final output'}
          >{copied ? 'Copied' : props.compact ? 'Copy' : 'Copy output'}</button>
          <button
            type="button"
            class={running ? 'btn btn-busy' : 'btn'}
            onClick={() => void runAgain()}
            disabled={running}
          >{running ? 'Starting…' : 'Run again'}</button>
          <a class="btn" href={sessionHref(row)}>{props.compact ? 'Session' : 'Full session'}</a>
        </div>
      </div>
      {runError && <div class="errors" role="alert">Could not start a run: {runError}</div>}
      <div class="out">
        <div class="out-label">
          {live ? 'Latest output' : 'Final output'}
          {live && <span class="out-live"><span class="dot running" aria-hidden="true" />live</span>}
        </div>
        {row.errorMessage && <p class="out-error">{errorText(row.errorMessage)}</p>}
        {row.finalResponse
          ? <LogContent value={row.finalResponse} forceMarkdown />
          : (
            <p class="out-empty">
              {live
                ? 'The agent is still working. Its output will appear here.'
                : 'This run ended without a final output.'}
              {' '}<a href={sessionHref(row)}>Open the full session</a>
            </p>
          )}
      </div>
      <div class="prevnext">
        {/* Buttons, not links: the SPA router routes every same-origin anchor
            click at the document level (it never checks defaultPrevented), so
            an <a> here would open the full session page instead of moving
            the reader to the neighbouring run. */}
        {props.newer
          ? <button type="button" class="prevnext-step" onClick={() => props.onNavigate?.(props.newer!)}>← Newer: {displayName(props.newer)}</button>
          : <span class="prevnext-end">Newest run</span>}
        <span class="prevnext-gap" />
        {props.older
          ? <button type="button" class="prevnext-step" onClick={() => props.onNavigate?.(props.older!)}>Older: {displayName(props.older)} →</button>
          : <span class="prevnext-end">Oldest loaded run</span>}
        {props.showKeyHints && <span class="prevnext-keys"><kbd>j</kbd>/<kbd>k</kbd></span>}
      </div>
    </section>
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
  const mockParam: 'include' | 'only' | undefined = mockFilter === '' ? undefined : mockFilter;
  const searchParam = q.q || '';
  const openParam = q.open || '';

  // 7d, not 24h: this page is opened to find a run someone remembers, and most
  // of those are older than today. An agent/approval filter widens further,
  // because a single agent often has not run at all this week.
  const defaultWin = agentFilter || approvalFilter ? '30d' : '7d';
  const win = q.window || defaultWin;

  useTitle(pageTitle('Sessions'));
  const narrow = useMediaQuery(PHONE_QUERY);

  // The input is local so typing stays instant; the URL (and therefore the
  // query the server runs) catches up on a short debounce.
  const [searchText, setSearchText] = useState(searchParam);
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => { setSearchText(searchParam); }, [searchParam]);

  const advancedFilterCount = [triageFilter !== '', triggerFilter !== '', mockFilter !== ''].filter(Boolean).length;
  const [advancedOpen, setAdvancedOpen] = useState(advancedFilterCount > 0);
  useEffect(() => { if (advancedFilterCount > 0) setAdvancedOpen(true); }, [advancedFilterCount]);

  const activeCount = [
    win !== defaultWin,
    statusFilter !== '',
    triageFilter !== '',
    triggerFilter !== '',
    mockFilter !== '',
    searchParam !== '',
    Boolean(agentFilter),
    Boolean(approvalFilter),
  ].filter(Boolean).length;

  const key = `sessions:${win}:${statusFilter}:${triageFilter}:${triggerFilter}:${mockFilter}:${agentFilter ?? ''}:${approvalFilter ?? ''}:${searchParam}`;
  const [streamData, setStreamData] = useState<SessionsPayload | null>(null);
  const [streamError, setStreamError] = useState<Error | null>(null);
  const [streamFallback, setStreamFallback] = useState(false);
  const [loadedMore, setLoadedMore] = useState<SessionRow[]>([]);
  const [loadingMore, setLoadingMore] = useState(false);
  const [pagedCursor, setPagedCursor] = useState<{ cursor?: string } | null>(null);

  useEffect(() => {
    setStreamData(null);
    setStreamError(null);
    setStreamFallback(false);
    setLoadedMore([]);
    setPagedCursor(null);
  }, [key]);

  const query = {
    window: win,
    status: statusFilter || undefined,
    triage: triageFilter || undefined,
    trigger: triggerFilter || undefined,
    agent: agentFilter,
    approval: approvalFilter,
    q: searchParam || undefined,
    limit: 50,
    detail: 'feed' as const,
    mock: mockParam,
  };

  const fetched = useFetch(key, () => fetchSessions(query), streamFallback ? { refreshMs: 10_000 } : {});

  useEffect(() => {
    if (streamFallback) fetched.refetch();
  }, [streamFallback, fetched.refetch]);

  useSessionsStream({
    ...query,
    enabled: !streamFallback,
    onData: (payload) => { setStreamData(payload); setStreamError(null); },
    onError: setStreamError,
    onFallback: () => setStreamFallback(true),
  });

  const resolvedData = streamFallback ? (fetched.data ?? streamData) : (streamData ?? fetched.data);
  const resolvedError = fetched.error ?? (!resolvedData ? streamError : null);
  const resolvedLoading = fetched.loading && !resolvedData;

  const agentsFetch = useFetch('sessions-agent-options', () => fetchAgents(), { enabled: resolvedData !== null });
  const agentOptions = useMemo(() => {
    const byId = new Map<string, string>();
    for (const a of agentsFetch.data?.agents ?? []) {
      const id = a.path.replace(/\.agentuse$/, '');
      if (!byId.has(id)) byId.set(id, a.name);
    }
    return [...byId.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  }, [agentsFetch.data]);

  const seen = new Set<string>();
  const rows = [...(resolvedData?.sessions ?? []), ...loadedMore].filter((row) => {
    const id = rowKey(row);
    if (seen.has(id)) return false;
    seen.add(id);
    return true;
  });
  // The server orders by last activity (a run that started yesterday and timed
  // out this morning sorts among today's runs), but the list shows start times
  // and groups by start day, so order by start here. Live runs still lead.
  rows.sort((a, b) =>
    (isRunningRow(a) ? 0 : 1) - (isRunningRow(b) ? 0 : 1) ||
    b.createdAt - a.createdAt ||
    a.sessionId.localeCompare(b.sessionId)
  );
  const counts = resolvedData?.counts;
  const runningCount = counts?.running ?? rows.filter(isRunningRow).length;

  // Selection is a session key, not an index: SSE snapshots reorder and replace
  // rows constantly, and an index would silently point at a different run.
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const selectedIndex = selectedKey ? rows.findIndex((row) => rowKey(row) === selectedKey) : -1;
  const effectiveIndex = selectedIndex >= 0 ? selectedIndex : (rows.length > 0 ? 0 : -1);
  const selected = effectiveIndex >= 0 ? rows[effectiveIndex] : undefined;
  const openRow = openParam ? rows.find((row) => row.sessionId === openParam) : undefined;

  const select = useCallback((row: SessionRow) => {
    setSelectedKey(rowKey(row));
    requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-session-item="${CSS.escape(rowKey(row))}"]`)
        ?.scrollIntoView({ block: 'nearest' });
    });
  }, []);

  const [copySignal, setCopySignal] = useState(0);

  const withParam = useCallback((changes: Record<string, string>): string => {
    const params = new URLSearchParams();
    const base: Record<string, string | undefined> = {
      window: q.window, status: statusFilter, triage: triageFilter, trigger: triggerFilter,
      mock: mockFilter, agent: agentFilter, approval: approvalFilter, q: searchParam, open: openParam,
    };
    for (const [k, v] of Object.entries(changes)) base[k] = v;
    for (const [k, v] of Object.entries(base)) if (v) params.set(k, v);
    const qs = params.toString();
    return qs ? `/sessions?${qs}` : '/sessions';
  }, [q.window, statusFilter, triageFilter, triggerFilter, mockFilter, agentFilter, approvalFilter, searchParam, openParam]);

  // Debounced URL sync for the search box.
  useEffect(() => {
    if (searchText === searchParam) return;
    const timer = setTimeout(() => {
      location.route(withParam({ q: searchText.trim(), open: '' }), true);
    }, 280);
    return () => clearTimeout(timer);
  }, [searchText, searchParam, withParam]);

  const onSelect = (key: string) => (event: Event) => {
    location.route(withParam({ [key]: (event.target as HTMLSelectElement).value }));
  };

  const commitAgent = (value: string) => {
    const next = value.trim();
    if (next === (agentFilter ?? '')) return;
    location.route(withParam({ agent: next }));
  };

  // One keydown listener for the whole page. Selection lives in state (not DOM
  // focus) because the reader renders from it, so the handler moves the index
  // and lets render put the row and the reader back in sync.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      const target = event.target as HTMLElement | null;
      if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable)) return;
      if (document.querySelector('dialog[open], [role="dialog"]')) return;
      if (event.key === '/') {
        event.preventDefault();
        searchRef.current?.focus();
        searchRef.current?.select();
        return;
      }
      if (rows.length === 0) return;
      if (event.key === 'j' || event.key === 'k') {
        event.preventDefault();
        const base = selectedIndex >= 0 ? selectedIndex : 0;
        const next = event.key === 'j'
          ? Math.min(base + (selectedIndex >= 0 ? 1 : 0), rows.length - 1)
          : Math.max(base - 1, 0);
        const row = rows[next];
        if (row) select(row);
        return;
      }
      if (event.key === 'c') {
        event.preventDefault();
        setCopySignal((n) => n + 1);
        return;
      }
      if (event.key === 'Enter') {
        const row = rows[effectiveIndex];
        if (!row) return;
        event.preventDefault();
        location.route(sessionHref(row));
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [rows, selectedIndex, effectiveIndex, select]);

  const nextCursor = pagedCursor ? pagedCursor.cursor : resolvedData?.nextCursor;
  const loadMore = async () => {
    if (!nextCursor || loadingMore) return;
    setLoadingMore(true);
    try {
      const next = await fetchSessions({ ...query, cursor: nextCursor });
      setLoadedMore((current) => [...current, ...next.sessions]);
      setPagedCursor({ ...(next.nextCursor && { cursor: next.nextCursor }) });
    } finally {
      setLoadingMore(false);
    }
  };

  const widerWindow = win === '30d' || win === '90d' ? 'all' : '30d';

  const groups: Array<{ key: string; label: string; rows: SessionRow[] }> = [];
  for (const row of rows) {
    const day = dayKey(row.createdAt);
    const last = groups[groups.length - 1];
    if (last && last.key === day) last.rows.push(row);
    else groups.push({ key: day, label: dayLabel(row.createdAt), rows: [row] });
  }

  const statusChip = (value: string, label: string, count: number | undefined, dot?: string) => {
    const on = statusFilter === value;
    return (
      <a class={`qc${on ? ' on' : ''}`} href={withParam({ status: on ? '' : value })} aria-pressed={on}>
        {dot && <span class={`dot ${dot}`} aria-hidden="true" />}
        {label}
        {count !== undefined && <span class="n">{count}</span>}
      </a>
    );
  };

  const listPane = (
    <div class="sessions-pane">
      <div class="sessions-search">
        <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="11" cy="11" r="6.5" /><path d="m20 20-4.3-4.3" /></svg>
        <input
          ref={searchRef}
          type="search"
          value={searchText}
          placeholder="Search agents and outputs"
          aria-label="Search sessions"
          onInput={(event) => setSearchText((event.target as HTMLInputElement).value)}
        />
        {!narrow && <kbd>/</kbd>}
      </div>
      <div class="sessions-hint">Searches agent names and the final output text.</div>
      <div class="quick">
        {statusChip('', 'All', counts?.all)}
        {statusChip('running', 'Running', counts?.running, 'running')}
        {statusChip('completed', 'Done', counts?.done)}
        {statusChip('incomplete', 'Incomplete', counts?.incomplete, 'incomplete')}
        {statusChip('error', 'Failed', counts?.failed, 'failed')}
        <AgentFilterSelect options={agentOptions} value={agentFilter ?? ''} onChange={commitAgent} />
        <div class="seg" role="group" aria-label="Time window">
          {[...WINDOWS, ...(EXTRA_WINDOWS.includes(win) ? [win] : [])].map((w) => (
            <a class={`seg-i${w === win ? ' on' : ''}`} href={withParam({ window: w })} key={w} aria-current={w === win ? 'true' : undefined}>{w}</a>
          ))}
        </div>
      </div>
      <details class="filters-advanced" open={advancedOpen} onToggle={(event) => setAdvancedOpen(event.currentTarget.open)}>
        <summary>More{advancedFilterCount > 0 && <span>{advancedFilterCount}</span>}</summary>
        <div class="filter-grid filter-grid-advanced">
          <label class="filter-field">triage
            <select value={triageFilter} onChange={onSelect('triage')}>
              {TRIAGE_OPTIONS.map((t) => <option value={t.value} key={t.value || 'any'}>{t.label}</option>)}
            </select>
          </label>
          <label class="filter-field">trigger
            <select value={triggerFilter} onChange={onSelect('trigger')}>
              {TRIGGERS.map((t) => <option value={t} key={t || 'any'}>{t || 'any'}</option>)}
            </select>
          </label>
          <label class="filter-field">mock runs
            <select value={mockFilter} onChange={onSelect('mock')}>
              {MOCK_OPTIONS.map((m) => <option value={m.value} key={m.value || 'hidden'}>{m.label}</option>)}
            </select>
          </label>
        </div>
      </details>

      {resolvedError && <div class="errors" role="alert">Failed to load sessions: {resolvedError.message}</div>}
      {resolvedData && resolvedData.errors.length > 0 && (
        <div class="errors" role="alert">Some {term('project', 2)} failed: <ul>{resolvedData.errors.map((e) => <li key={e.projectId}>{e.projectId}: {e.message}</li>)}</ul></div>
      )}
      {resolvedLoading && <Loading label="Loading sessions…" />}
      {resolvedData && (rows.length === 0
        ? (
          <p class="empty">
            {searchParam
              ? <>No run mentions “{searchParam}”.</>
              : activeCount > 0 ? 'No sessions match the current filters.' : 'No sessions in this window.'}
            {win !== 'all' && (
              <a class="empty-action" href={withParam({ window: widerWindow })}>
                {widerWindow === 'all' ? 'Search all time' : `Widen to ${widerWindow}`}
              </a>
            )}
            {activeCount > 0 && <a class="empty-action" href="/sessions">Clear all filters</a>}
          </p>
        )
        : (
          <div class="list">
            {groups.map((group) => (
              <Fragment key={group.key}>
                <div class="day"><span>{group.label}</span><span class="rule" /></div>
                {group.rows.map((row) => (
                  <SessionListItem
                    key={rowKey(row)}
                    row={row}
                    query={searchParam}
                    selected={!narrow && selected !== undefined && rowKey(selected) === rowKey(row)}
                    href={narrow ? withParam({ open: row.sessionId }) : sessionHref(row)}
                    onSelect={narrow ? undefined : (event) => {
                      // Let modifier/middle clicks open the full session in a new tab.
                      if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey || event.button !== 0) return;
                      event.preventDefault();
                      // The router routes every same-origin anchor click at the window
                      // level without checking defaultPrevented, so stop it here.
                      event.stopPropagation();
                      select(row);
                    }}
                  />
                ))}
              </Fragment>
            ))}
          </div>
        ))}
      {nextCursor && (
        <button type="button" class={loadingMore ? 'load-more btn-busy' : 'load-more'} onClick={loadMore} disabled={loadingMore}>
          {loadingMore ? <><span class="btn-spinner" aria-hidden="true" />Loading…</> : 'Load more'}
        </button>
      )}
    </div>
  );

  // Phone: one thing at a time. The list is the page; tapping a run swaps in
  // the reader, addressed by ?open= so back and share both work.
  if (narrow && openRow) {
    const index = rows.findIndex((row) => rowKey(row) === rowKey(openRow));
    return (
      <div class="page-sessions is-phone">
        <main>
          <a class="reader-back" href={withParam({ open: '' })}>← Sessions</a>
          <SessionReader
            row={openRow}
            newer={index > 0 ? rows[index - 1] : undefined}
            older={index >= 0 && index + 1 < rows.length ? rows[index + 1] : undefined}
            onNavigate={(row) => location.route(withParam({ open: row.sessionId }))}
            compact
          />
        </main>
      </div>
    );
  }

  return (
    <div class={`page-sessions${narrow ? ' is-phone' : ''}`}>
      <main>
        <div class="sessions-head">
          <h1>Sessions <PushBell category="sessions" /></h1>
          <span class="sessions-lede">Find a finished run and read what it produced.</span>
          <span class="sessions-count">
            {counts?.all ?? rows.length} runs in {win === 'all' ? 'all time' : win}
            {runningCount > 0 && ` · ${runningCount} running`}
          </span>
        </div>
        {narrow
          ? listPane
          : (
            <div class="sessions-split">
              {listPane}
              {selected
                ? (
                  <SessionReader
                    row={selected}
                    newer={effectiveIndex > 0 ? rows[effectiveIndex - 1] : undefined}
                    older={effectiveIndex + 1 < rows.length ? rows[effectiveIndex + 1] : undefined}
                    onNavigate={select}
                    showKeyHints
                    copySignal={copySignal}
                  />
                )
                : <section class="reader reader-blank"><p class="out-empty">Pick a run to read its output.</p></section>}
            </div>
          )}
        {!narrow && (
          <div class="sessions-keys">
            <kbd>/</kbd> search · <kbd>j</kbd>/<kbd>k</kbd> next / previous run · <kbd>c</kbd> copy output · <kbd>enter</kbd> full session
          </div>
        )}
        <footer>{streamFallback ? 'auto-refreshes every 10s' : 'live updates'}</footer>
      </main>
    </div>
  );
}
