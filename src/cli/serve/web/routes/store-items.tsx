import { useEffect, useMemo } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { fetchStoreRows } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { ErrorBanner } from '../components/error-banner';
import { StoreTable, type StoreTableColumn } from '../components/store-table';
import { formatApprovalTime, storeItemPreview, storeItemTitle } from '../lib/format';
import type { StoreItem } from '../../../../store/types';

interface ItemRow {
  projectId: string;
  item: StoreItem;
}

export default function StoreItems() {
  const { params } = useRoute();
  const location = useLocation();
  const storeName = decodeURIComponent(params.store ?? '');
  const project = location.query.project || undefined;
  const highlight = location.query.highlight || undefined;

  useTitle(`AgentUse Store - ${storeName}`);

  const { data, error, loading } = useFetch(
    `store-items:${storeName}:${project ?? ''}`,
    () => fetchStoreRows(storeName, project)
  );

  const multiProject = data?.multiProject ?? false;

  const allRows: ItemRow[] = useMemo(() => (data?.rows ?? [])
    .flatMap((group) => group.items.map((item) => ({ projectId: group.projectId, item })))
    .sort((a, b) => (Date.parse(b.item.updatedAt) || 0) - (Date.parse(a.item.updatedAt) || 0)
      || storeItemTitle(a.item).localeCompare(storeItemTitle(b.item))
      || a.projectId.localeCompare(b.projectId)), [data]);

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

  const columns: Array<StoreTableColumn<ItemRow>> = [
    {
      key: 'item',
      label: 'Item',
      sortValue: (row) => storeItemTitle(row.item),
      render: (row) => (
        <span class="title-cell">
          <a href={itemHref(row)}>{storeItemTitle(row.item)}</a>
          <span class="preview">{storeItemPreview(row.item)}</span>
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status / type',
      sortValue: (row) => `${row.item.status ?? ''} ${row.item.type ?? ''}`,
      render: (row) => (
        <span class="chips">
          {row.item.status && <span class="chip status">{row.item.status}</span>}
          {row.item.type && <span class="chip">{row.item.type}</span>}
        </span>
      ),
    },
    {
      key: 'updated',
      label: 'Updated',
      type: 'number',
      sortValue: (row) => Date.parse(row.item.updatedAt) || 0,
      render: (row) => formatApprovalTime(Date.parse(row.item.updatedAt)),
    },
    {
      key: 'created-by',
      label: 'Created by',
      sortValue: (row) => row.item.createdBy ?? '',
      render: (row) => row.item.createdBy ?? <span class="muted">unknown</span>,
    },
    {
      key: 'id',
      label: 'ID',
      sortValue: (row) => row.item.id,
      render: (row) => (
        <>
          <code>{row.item.id}</code>
          {multiProject && <div class="muted">{row.projectId}</div>}
        </>
      ),
    },
  ];

  return (
    <div class="page-stores">
      <Topbar currentPage="stores" right={<span class="session-pill">store <code>{storeName}</code></span>} />
      <main>
        <header>
          <div class="eyebrow">store table</div>
          <h1>{storeName}</h1>
          <p class="lede">{allRows.length} item{allRows.length === 1 ? '' : 's'} visible in this serve daemon.</p>
        </header>
        {error && <div class="errors">Failed to load store: {error.message}</div>}
        {data && <ErrorBanner errors={data.errors} />}
        <div class="panel">
          {loading && !data && <div class="empty">Loading items…</div>}
          {data && allRows.length === 0 && <div class="empty">No items found in this store.</div>}
          {data && allRows.length > 0 && (
            <StoreTable
              columns={columns}
              rows={allRows}
              defaultSortKey="updated"
              defaultSortDirection="desc"
              rowKey={(row) => `${row.projectId}:${row.item.id}`}
              rowProps={(row) => ({
                id: `store-item-${row.item.id}`,
                class: `clickable${highlight === row.item.id ? ' highlighted' : ''}`,
                'data-store-item-id': row.item.id,
                onClick: (event: MouseEvent) => {
                  const target = event.target as Element;
                  if (target.closest('a')) return;
                  location.route(itemHref(row));
                },
              })}
            />
          )}
        </div>
      </main>
    </div>
  );
}
