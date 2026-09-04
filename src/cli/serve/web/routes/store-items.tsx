import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { fetchStoreRows } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { Loading } from '../components/loading';
import { ErrorBanner } from '../components/error-banner';
import { ListFilter } from '../components/list-filter';
import { StoreTable, type StoreTableColumn } from '../components/store-table';
import { CopyButton } from '../components/copy-button';
import { formatApprovalTime, formatRelativeTime, shortAgentName, storeItemPreview, storeItemTitle } from '../lib/format';
import { mergeStoreSummaries } from '../../../../store/display';
import { readStoreView, statusChipClass, statusSlices, writeStoreView, type StoreViewChoice } from '../lib/store-view';
import { pageTitle } from '../lib/brand';
import type { StoreItem } from '../../../../store/types';

interface ItemRow {
  projectId: string;
  item: StoreItem;
}

/** Status segments the toolbar has room for; the rest stay reachable through the filter. */
const STATUS_SEGMENTS = 6;
/** Past this many writers the lede names a count instead of a list. */
const MAX_NAMED_AGENTS = 3;

function haystack(row: ItemRow): string {
  const item = row.item;
  return [
    storeItemTitle(item),
    item.id,
    item.type ?? '',
    item.status ?? '',
    item.createdBy ?? '',
    ...(item.tags ?? []),
    JSON.stringify(item.data ?? {}),
  ].join(' ').toLowerCase();
}

function writtenBy(agents: string[]) {
  if (agents.length === 0) return null;
  const names = agents.map(shortAgentName);
  if (names.length > MAX_NAMED_AGENTS) return <> · written by {names.length} agents</>;
  return <> · written by {names.slice(0, -1).join(', ')}{names.length > 1 ? ' and ' : ''}{names[names.length - 1]}</>;
}

export default function StoreItems() {
  const { params } = useRoute();
  const location = useLocation();
  const storeName = decodeURIComponent(params.store ?? '');
  const project = location.query.project || undefined;
  const highlight = location.query.highlight || undefined;

  useTitle(pageTitle('Stores', storeName));

  const { data, error, loading } = useFetch(
    `store-items:${storeName}:${project ?? ''}`,
    () => fetchStoreRows(storeName, project)
  );

  const multiProject = data?.multiProject ?? false;
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('');
  const [type, setType] = useState('');
  const [agent, setAgent] = useState('');
  const [view, setView] = useState<StoreViewChoice>(() => readStoreView(project, storeName));

  const summary = useMemo(() => mergeStoreSummaries((data?.rows ?? []).map((group) => ({
    display: group.display,
    statusCounts: group.statusCounts,
    typeCounts: group.typeCounts,
    agents: group.agents,
  }))), [data]);

  const display = view === 'auto' ? summary.display : view;

  const allRows: ItemRow[] = useMemo(() => (data?.rows ?? [])
    .flatMap((group) => group.items.map((item) => ({ projectId: group.projectId, item })))
    .sort((a, b) => (Date.parse(b.item.updatedAt) || 0) - (Date.parse(a.item.updatedAt) || 0)
      || storeItemTitle(a.item).localeCompare(storeItemTitle(b.item))
      || a.projectId.localeCompare(b.projectId)), [data]);

  const rows = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return allRows.filter((row) => {
      if (status && row.item.status !== status) return false;
      if (type && row.item.type !== type) return false;
      if (agent && row.item.createdBy !== agent) return false;
      return !needle || haystack(row).includes(needle);
    });
  }, [allRows, query, status, type, agent]);

  useEffect(() => {
    if (!highlight || !data) return;
    const row = document.querySelector(`[data-store-item-id="${CSS.escape(highlight)}"]`);
    if (row) requestAnimationFrame(() => row.scrollIntoView({ block: 'center' }));
  }, [highlight, data]);

  const itemHref = (row: ItemRow): string => {
    const params = new URLSearchParams();
    if (multiProject) params.set('project', row.projectId);
    return `/stores/${encodeURIComponent(storeName)}/${encodeURIComponent(row.item.id)}${params.toString() ? `?${params.toString()}` : ''}`;
  };

  const itemColumn: StoreTableColumn<ItemRow> = {
    key: 'item',
    label: 'Item',
    sortValue: (row) => storeItemTitle(row.item),
    render: (row) => (
      <span class="title-cell">
        <a href={itemHref(row)}>{storeItemTitle(row.item)}</a>
        {storeItemPreview(row.item) && <span class="preview">{storeItemPreview(row.item)}</span>}
      </span>
    ),
  };
  const statusColumn: StoreTableColumn<ItemRow> = {
    key: 'status',
    label: 'Status',
    sortValue: (row) => row.item.status ?? '',
    render: (row) => row.item.status
      ? <span class={statusChipClass(row.item.status)}>{row.item.status}</span>
      : <span class="muted">—</span>,
  };
  const restColumns: Array<StoreTableColumn<ItemRow>> = [
    {
      key: 'type',
      label: 'Type',
      sortValue: (row) => row.item.type ?? '',
      render: (row) => row.item.type ? <span class="type-cell">{row.item.type}</span> : <span class="muted">—</span>,
    },
    {
      key: 'created-by',
      label: 'Created by',
      sortValue: (row) => row.item.createdBy ?? '',
      render: (row) => row.item.createdBy
        ? <span class="agent-cell" title={row.item.createdBy}>{shortAgentName(row.item.createdBy)}</span>
        : <span class="muted">unknown</span>,
    },
    {
      key: 'updated',
      label: 'Updated',
      type: 'number',
      sortValue: (row) => Date.parse(row.item.updatedAt) || 0,
      render: (row) => <span class="updated" title={formatApprovalTime(Date.parse(row.item.updatedAt))}>{formatRelativeTime(Date.parse(row.item.updatedAt))}</span>,
    },
    {
      key: 'id',
      label: 'ID',
      sortValue: (row) => row.item.id,
      render: (row) => (
        <span class="id-cell">
          <span class="id-tail" title={row.item.id}>…{row.item.id.slice(-7)}</span>
          <CopyButton text={row.item.id} label="item ID" />
        </span>
      ),
    },
  ];

  const columns = display === 'pipeline'
    ? [itemColumn, statusColumn, ...restColumns]
    : [itemColumn, ...restColumns];

  const slices = statusSlices(summary.statusCounts).slice(0, STATUS_SEGMENTS);
  const types = Object.keys(summary.typeCounts).sort();
  const updatedAt = allRows.length > 0 ? Date.parse(allRows[0]!.item.updatedAt) : undefined;

  const lede = data
    ? <>
      {allRows.length.toLocaleString()} item{allRows.length === 1 ? '' : 's'}
      {updatedAt ? <> · updated <span title={formatApprovalTime(updatedAt)}>{formatRelativeTime(updatedAt)}</span></> : null}
      {writtenBy(summary.agents)}
      {multiProject && data.rows.length > 0 && <code class="proj-tag">{data.rows.map((group) => group.projectId).join(', ')}</code>}
    </>
    : loading ? 'Loading items…' : '';

  const chooseView = (choice: StoreViewChoice) => {
    setView(choice);
    writeStoreView(project, storeName, choice);
  };

  return (
    <div class="page-stores page-store-items">
      <main>
        <div class="crumbs">
          <a href="/stores">Stores</a><span class="sep">›</span><span>{storeName}</span>
        </div>
        <header>
          <div class="header-text">
            <h1>{storeName}</h1>
            <p class="lede">{lede}</p>
          </div>
          {data && (
            <div class="header-actions">
              <CopyButton text={JSON.stringify(allRows.map((row) => row.item), null, 2)} label="store JSON" variant="button">Copy as JSON</CopyButton>
            </div>
          )}
        </header>
        {error && <div class="errors" role="alert">Failed to load store: {error.message}</div>}
        {data && <ErrorBanner errors={data.errors} />}

        {data && allRows.length > 0 && (
          <div class="stores-toolbar">
            <ListFilter value={query} onInput={setQuery} placeholder="Filter by title, tag, or field…" label="Filter items" />
            {display === 'pipeline' && slices.length > 0 && (
              <div class="segments" role="group" aria-label="Filter by status">
                <button type="button" class={`segment${status === '' ? ' active' : ''}`} aria-pressed={status === ''} onClick={() => setStatus('')}>
                  <span>All</span><span class="count">{allRows.length}</span>
                </button>
                {slices.map((slice) => (
                  <button key={slice.status} type="button" class={`segment${status === slice.status ? ' active' : ''}`} aria-pressed={status === slice.status} onClick={() => setStatus(slice.status)}>
                    <span>{slice.status}</span><span class={`count ${slice.bucket}`}>{slice.count}</span>
                  </button>
                ))}
              </div>
            )}
            {types.length > 1 && (
              <select class="project-filter" aria-label="Type" value={type} onChange={(e) => setType((e.currentTarget as HTMLSelectElement).value)}>
                <option value="">All types</option>
                {types.map((value) => <option key={value} value={value}>{value}</option>)}
              </select>
            )}
            {summary.agents.length > 1 && (
              <select class="project-filter" aria-label="Created by" value={agent} onChange={(e) => setAgent((e.currentTarget as HTMLSelectElement).value)}>
                <option value="">All agents</option>
                {summary.agents.map((value) => <option key={value} value={value}>{shortAgentName(value)}</option>)}
              </select>
            )}
            <select class="project-filter view-filter" aria-label="View" value={view} onChange={(e) => chooseView((e.currentTarget as HTMLSelectElement).value as StoreViewChoice)}>
              <option value="auto">View · Auto ({summary.display})</option>
              <option value="pipeline">View · Pipeline</option>
              <option value="table">View · Table</option>
            </select>
          </div>
        )}

        <div class="panel">
          {loading && !data && <Loading label="Loading items…" />}
          {data && allRows.length === 0 && <div class="empty">No items found in this store.</div>}
          {data && allRows.length > 0 && rows.length === 0 && <div class="empty">Nothing matches this filter.</div>}
          {data && rows.length > 0 && (
            <>
              <StoreTable
                columns={columns}
                rows={rows}
                defaultSortKey="updated"
                defaultSortDirection="desc"
                rowKey={(row) => `${row.projectId}:${row.item.id}`}
                rowProps={(row) => ({
                  id: `store-item-${row.item.id}`,
                  class: `clickable${highlight === row.item.id ? ' highlighted' : ''}`,
                  'data-store-item-id': row.item.id,
                  onClick: (event: MouseEvent) => {
                    const target = event.target as Element;
                    if (target.closest('a, button')) return;
                    location.route(itemHref(row));
                  },
                })}
              />
              {rows.length !== allRows.length && (
                <div class="table-footnote">
                  <span>Showing {rows.length.toLocaleString()} of {allRows.length.toLocaleString()}</span>
                  <span class="dim">Sorted by updated, newest first</span>
                </div>
              )}
            </>
          )}
        </div>
      </main>
    </div>
  );
}
