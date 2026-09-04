import { useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { fetchStores } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { Loading } from '../components/loading';
import { ErrorBanner } from '../components/error-banner';
import { ListFilter } from '../components/list-filter';
import { formatApprovalTime, formatRelativeTime, storeNeedsAttention } from '../lib/format';
import { statusBar, statusSlices, typeSummary } from '../lib/store-view';
import { pageTitle } from '../lib/brand';
import type { StoreBrowserSummary } from '../../stores';

type Segment = 'all' | 'attention' | 'pipelines' | 'quiet';

/** Nothing written in a month: shelved rather than in use. */
const QUIET_MS = 30 * 24 * 60 * 60 * 1000;
/** Status names the mix line has room for before it starts eliding. */
const MIX_STATUSES = 4;

export function isQuietStore(store: StoreBrowserSummary, now: number): boolean {
  return !store.updatedAt || now - store.updatedAt > QUIET_MS;
}

function ChevronRight() {
  return (
    <svg class="chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d="m9 6 6 6-6 6" />
    </svg>
  );
}

function PipelineMix(props: { store: StoreBrowserSummary }) {
  const { store } = props;
  if (store.display !== 'pipeline') return <span class="mix-none">—</span>;
  const bar = statusBar(store.statusCounts);
  const slices = statusSlices(store.statusCounts);
  if (bar.length === 0) return <span class="mix-none">—</span>;
  const shown = slices.slice(0, MIX_STATUSES);
  const rest = slices.length - shown.length;
  return (
    <div class="mix">
      <div class="mix-bar" aria-hidden="true">
        {bar.map((segment) => (
          <span key={segment.bucket} class={`seg ${segment.bucket}`} style={{ width: `${segment.pct}%` }} />
        ))}
      </div>
      <div class="mix-text">
        {shown.map((slice, index) => (
          <span key={slice.status}>
            {index > 0 && <span class="sep"> · </span>}
            <span class={slice.bucket}>{slice.count.toLocaleString()} {slice.status}</span>
          </span>
        ))}
        {rest > 0 && <span class="sep"> · {rest} more</span>}
      </div>
    </div>
  );
}

function StoreRow(props: { store: StoreBrowserSummary; href: string }) {
  const location = useLocation();
  const { store, href } = props;
  return (
    <div
      class="store-row"
      onClick={(event) => {
        if ((event.target as Element).closest('a')) return;
        location.route(href);
      }}
    >
      <div class="store-row-name">
        <a href={href}>{store.name}</a>
        <div class="store-row-types">{typeSummary(store.types) || <span class="dim">no types</span>}</div>
      </div>
      <div class="num">{store.itemCount.toLocaleString()}</div>
      <PipelineMix store={store} />
      <div class="when" title={store.updatedAt ? formatApprovalTime(store.updatedAt) : 'Never written'}>
        {store.updatedAt ? formatRelativeTime(store.updatedAt) : 'never'}
      </div>
      <ChevronRight />
    </div>
  );
}

export default function StoresIndex() {
  const location = useLocation();
  const project = location.query.project || undefined;
  const now = Date.now();

  useTitle(pageTitle('Stores'));

  const { data, error, loading } = useFetch(
    `stores:${project ?? ''}`,
    () => fetchStores(project)
  );

  const [segment, setSegment] = useState<Segment>('all');
  const [query, setQuery] = useState('');
  const [showQuiet, setShowQuiet] = useState(false);

  const multiProject = data?.multiProject ?? false;
  const stores = useMemo(() => data?.stores ?? [], [data]);

  const storeHref = (store: StoreBrowserSummary): string => {
    const params = new URLSearchParams();
    if (multiProject) params.set('project', store.projectId);
    return `/stores/${encodeURIComponent(store.name)}${params.toString() ? `?${params.toString()}` : ''}`;
  };

  const attention = useMemo(
    () => new Set(stores.filter((store) => store.display === 'pipeline' && storeNeedsAttention(store.statusCounts)).map((store) => `${store.projectId}:${store.name}`)),
    [stores]
  );
  const pipelines = stores.filter((store) => store.display === 'pipeline');
  const quiet = stores.filter((store) => isQuietStore(store, now));

  const matches = (store: StoreBrowserSummary): boolean => {
    const needle = query.trim().toLowerCase();
    if (!needle) return true;
    return [store.name, store.projectId, ...store.types].some((value) => value.toLowerCase().includes(needle));
  };

  const inSegment = (store: StoreBrowserSummary): boolean => {
    if (segment === 'attention') return attention.has(`${store.projectId}:${store.name}`);
    if (segment === 'pipelines') return store.display === 'pipeline';
    if (segment === 'quiet') return isQuietStore(store, now);
    return true;
  };

  const filtered = stores.filter((store) => matches(store) && inSegment(store));
  // Quiet stores are shelved, so they collapse to one footer row unless the
  // reader asked for them — either through the segment or by expanding it.
  const collapseQuiet = segment !== 'quiet' && !showQuiet;
  const visible = collapseQuiet ? filtered.filter((store) => !isQuietStore(store, now)) : filtered;
  const collapsed = collapseQuiet ? filtered.filter((store) => isQuietStore(store, now)) : [];

  const groups = useMemo(() => {
    if (!multiProject) return [{ projectId: '', list: visible }];
    const byProject = new Map<string, StoreBrowserSummary[]>();
    for (const store of visible) {
      const list = byProject.get(store.projectId);
      if (list) list.push(store);
      else byProject.set(store.projectId, [store]);
    }
    return [...byProject.entries()].map(([projectId, list]) => ({ projectId, list }));
  }, [visible, multiProject]);

  const projectCount = new Set(stores.map((store) => store.projectId)).size;
  const lede = data
    ? <>
      {stores.length} store{stores.length === 1 ? '' : 's'}
      {multiProject && <> across {projectCount} project{projectCount === 1 ? '' : 's'}</>}.
      {pipelines.length > 0 && <> {pipelines.length} {pipelines.length === 1 ? 'is a pipeline' : 'are pipelines'}
        {attention.size > 0
          ? <>, and <span class="attention">{attention.size} of those</span> {attention.size === 1 ? 'has' : 'have'} items waiting on you or blocked.</>
          : <>, and none of those have items waiting on you or blocked.</>}
      </>}
    </>
    : loading ? 'Loading stores…' : '';

  const seg = (id: Segment, label: string, n: number, tone?: string) => (
    <button type="button" class={`segment${segment === id ? ' active' : ''}`} aria-pressed={segment === id} onClick={() => setSegment(id)}>
      <span>{label}</span><span class={`count${tone ? ` ${tone}` : ''}`}>{n}</span>
    </button>
  );

  return (
    <div class="page-stores page-stores-index">
      <main>
        <header>
          <div class="header-text">
            <div class="eyebrow">shared state</div>
            <h1>Stores</h1>
            <p class="lede">{lede}</p>
          </div>
        </header>
        {error && <div class="errors" role="alert">Failed to load stores: {error.message}</div>}
        {data && <ErrorBanner errors={data.errors} />}

        {stores.length > 0 && (
          <div class="stores-toolbar">
            <ListFilter value={query} onInput={setQuery} placeholder="Filter stores…" label="Filter stores" />
            <div class="segments" role="group" aria-label="Filter stores">
              {seg('all', 'All', stores.length)}
              {seg('attention', 'Needs attention', attention.size, 'warn')}
              {seg('pipelines', 'Pipelines', pipelines.length)}
              {seg('quiet', 'Quiet', quiet.length, 'dim')}
            </div>
          </div>
        )}

        {loading && !data && <div class="panel"><Loading label="Loading stores…" /></div>}
        {data && stores.length === 0 && (
          <div class="panel"><div class="empty">No stores yet. Agents create them the first time they save data.</div></div>
        )}
        {data && stores.length > 0 && (
          visible.length === 0 && collapsed.length === 0
            ? <div class="panel"><div class="empty">Nothing matches this filter.</div></div>
            : <div class="stores-table surface">
              <div class="stores-head" aria-hidden="true">
                <span>Store</span><span>Items</span><span>Pipeline</span><span>Updated</span><span></span>
              </div>
              {groups.filter((group) => group.list.length > 0).map((group) => (
                <section class="group" key={group.projectId}>
                  {multiProject && (
                    <h2 class="group-title"><span>{group.projectId}</span><span class="count">{group.list.length} store{group.list.length === 1 ? '' : 's'}</span></h2>
                  )}
                  {group.list.map((store) => (
                    <StoreRow key={`${store.projectId}:${store.name}`} store={store} href={storeHref(store)} />
                  ))}
                </section>
              ))}
              {collapsed.length > 0 && (
                <div class="quiet-row">
                  <span class="quiet-label">Quiet</span>
                  <span class="quiet-note">{collapsed.length} store{collapsed.length === 1 ? '' : 's'}, nothing written in 30+ days</span>
                  <span class="quiet-names">{collapsed.map((store) => store.name).join(', ')}</span>
                  <button type="button" class="quiet-show" onClick={() => setShowQuiet(true)}>Show</button>
                </div>
              )}
            </div>
        )}
      </main>
    </div>
  );
}
