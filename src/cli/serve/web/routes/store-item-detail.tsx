import { useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { fetchStoreItem } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { Topbar } from '../components/topbar';
import { formatApprovalTime, storeItemPreview, storeItemTitle, valueAsRecord } from '../lib/format';

function StoreDataValue(props: { value: unknown }) {
  const { value } = props;
  if (value === null || typeof value === 'number' || typeof value === 'boolean') {
    return <code>{JSON.stringify(value)}</code>;
  }
  if (typeof value === 'string') {
    return <>{value}</>;
  }
  return <pre>{JSON.stringify(value, null, 2)}</pre>;
}

export default function StoreItemDetail() {
  const { params } = useRoute();
  const location = useLocation();
  const storeName = decodeURIComponent(params.store ?? '');
  const itemId = decodeURIComponent(params.item ?? '');
  const project = location.query.project || undefined;
  const [tab, setTab] = useState<'table' | 'json'>('table');

  const { data, error, loading } = useFetch(
    `store-item:${storeName}:${itemId}:${project ?? ''}`,
    () => fetchStoreItem(storeName, itemId, project)
  );

  const item = data?.item;
  useTitle(item ? `AgentUse Store Item - ${storeItemTitle(item)}` : 'AgentUse Store Item');

  const backParams = new URLSearchParams();
  if (data?.project) backParams.set('project', data.project);
  backParams.set('highlight', itemId);
  const backHref = `/stores/${encodeURIComponent(storeName)}?${backParams.toString()}`;

  return (
    <div class="page-stores">
      <Topbar currentPage="stores" right={<span class="session-pill">store <code>{storeName}</code></span>} />
      <main>
        <a class="back-link" href={backHref}>Back to store table</a>
        {error && <div class="errors">Failed to load item: {error.message}</div>}
        {loading && !item && <div class="empty">Loading item…</div>}
        {item && (
          <>
            <header>
              <div class="eyebrow">store item</div>
              <h1>{storeItemTitle(item)}</h1>
              <p class="lede">{storeItemPreview(item, 260)}</p>
            </header>
            <div class="tabs" role="tablist" aria-label="Store item views">
              <button type="button" role="tab" id="tab-table" aria-controls="panel-table" aria-selected={tab === 'table'} onClick={() => setTab('table')}>Table</button>
              <button type="button" role="tab" id="tab-json" aria-controls="panel-json" aria-selected={tab === 'json'} onClick={() => setTab('json')}>Raw JSON</button>
            </div>
            <section id="panel-table" class="tab-panel" role="tabpanel" aria-labelledby="tab-table" hidden={tab !== 'table'}>
              <div class="detail-grid">
                <div class="detail-cell"><span class="detail-label">id</span><code>{item.id}</code></div>
                <div class="detail-cell"><span class="detail-label">type</span>{item.type ?? <span class="muted">none</span>}</div>
                <div class="detail-cell"><span class="detail-label">status</span>{item.status ? <span class="chip status">{item.status}</span> : <span class="muted">none</span>}</div>
                <div class="detail-cell"><span class="detail-label">created by</span>{item.createdBy ?? <span class="muted">unknown</span>}</div>
                <div class="detail-cell"><span class="detail-label">created</span>{formatApprovalTime(Date.parse(item.createdAt))}</div>
                <div class="detail-cell"><span class="detail-label">updated</span>{formatApprovalTime(Date.parse(item.updatedAt))}</div>
                {item.parentId && <div class="detail-cell"><span class="detail-label">parent</span><code>{item.parentId}</code></div>}
                {item.tags && item.tags.length > 0 && (
                  <div class="detail-cell">
                    <span class="detail-label">tags</span>
                    <span class="chips">{item.tags.map((tag) => <span class="chip" key={tag}>{tag}</span>)}</span>
                  </div>
                )}
              </div>
              <div class="panel">
                <div class="data-grid">
                  {Object.entries(valueAsRecord(item.data)).length === 0 && <div class="empty">No item data.</div>}
                  {Object.entries(valueAsRecord(item.data)).map(([key, value]) => (
                    <div class="data-field" key={key}>
                      <span class="data-key">{key}</span>
                      <div class="data-value"><StoreDataValue value={value} /></div>
                    </div>
                  ))}
                </div>
              </div>
            </section>
            <section id="panel-json" class="tab-panel panel" role="tabpanel" aria-labelledby="tab-json" hidden={tab !== 'json'}>
              <pre class="raw-json"><code>{JSON.stringify(item, null, 2)}</code></pre>
            </section>
          </>
        )}
      </main>
    </div>
  );
}
