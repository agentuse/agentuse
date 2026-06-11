import { useLocation } from 'preact-iso';
import { fetchStores } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { ErrorBanner } from '../components/error-banner';
import { StoreTable, type StoreTableColumn } from '../components/store-table';
import { formatApprovalTime } from '../lib/format';
import type { StoreBrowserSummary } from '../../stores';

export default function StoresIndex() {
  const location = useLocation();
  const project = location.query.project || undefined;

  useTitle('AgentUse Stores');

  const { data, error, loading } = useFetch(
    `stores:${project ?? ''}`,
    () => fetchStores(project)
  );

  const multiProject = data?.multiProject ?? false;

  const storeHref = (store: StoreBrowserSummary): string => {
    const params = new URLSearchParams();
    if (multiProject) params.set('project', store.projectId);
    return `/stores/${encodeURIComponent(store.name)}${params.toString() ? `?${params.toString()}` : ''}`;
  };

  const columns: Array<StoreTableColumn<StoreBrowserSummary>> = [
    {
      key: 'store',
      label: 'Store',
      sortValue: (store) => store.name,
      render: (store) => (
        <span class="title-cell">
          <a href={storeHref(store)}>{store.name}</a>
          {multiProject && <span class="muted">{store.projectId}</span>}
        </span>
      ),
    },
    {
      key: 'items',
      label: 'Items',
      type: 'number',
      sortValue: (store) => store.itemCount,
      render: (store) => String(store.itemCount),
    },
    {
      key: 'updated',
      label: 'Updated',
      type: 'number',
      sortValue: (store) => store.updatedAt ?? 0,
      render: (store) => store.updatedAt ? formatApprovalTime(store.updatedAt) : <span class="muted">never</span>,
    },
    {
      key: 'types',
      label: 'Types',
      sortValue: (store) => store.types.join(' '),
      render: (store) => (
        <span class="chips">
          {store.types.slice(0, 6).map((type) => <span class="chip" key={type}>{type}</span>)}
          {store.types.length === 0 && <span class="muted">none</span>}
        </span>
      ),
    },
    {
      key: 'status',
      label: 'Status',
      sortValue: (store) => store.statuses.join(' '),
      render: (store) => (
        <span class="chips">
          {store.statuses.slice(0, 6).map((status) => <span class="chip status" key={status}>{status}</span>)}
          {store.statuses.length === 0 && <span class="muted">none</span>}
        </span>
      ),
    },
  ];

  return (
    <div class="page-stores">
      <Topbar currentPage="stores" />
      <main>
        <header>
          <div class="eyebrow">shared state</div>
          <h1>Stores</h1>
          <p class="lede">Browse persistent state that agents can share across runs.</p>
        </header>
        {error && <div class="errors">Failed to load stores: {error.message}</div>}
        {data && <ErrorBanner errors={data.errors} />}
        <div class="panel">
          {loading && !data && <div class="empty">Loading stores…</div>}
          {data && data.stores.length === 0 && <div class="empty">No stores found for this serve daemon.</div>}
          {data && data.stores.length > 0 && (
            <StoreTable
              columns={columns}
              rows={data.stores}
              defaultSortKey="updated"
              defaultSortDirection="desc"
              rowKey={(store) => `${store.projectId}:${store.name}`}
            />
          )}
        </div>
      </main>
    </div>
  );
}
