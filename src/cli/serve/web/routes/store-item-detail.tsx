import { useMemo, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import { fetchStoreItem } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { useTitle } from '../hooks/use-title';
import { useSmartBack } from '../hooks/use-smart-back';
import { Loading } from '../components/loading';
import { CopyButton } from '../components/copy-button';
import { ListFilter } from '../components/list-filter';
import { formatApprovalTime, formatRelativeTime, looksLikeUlid, shortAgentName, storeItemTitle, valueAsRecord } from '../lib/format';
import { statusChipClass } from '../lib/store-view';
import { pageTitle } from '../lib/brand';
import type { StoreItemRef } from '../../stores';

/** Nested fields step in by this much per level, matching the mock's tree. */
const INDENT_PX = 22;
/** Scalar children named in a collapsed group's summary line. */
const SUMMARY_CHILDREN = 4;
/** Linked items listed by title before the rest become a count. */
const LINKED_SHOWN = 3;

function isContainer(value: unknown): value is Record<string, unknown> | unknown[] {
  return value !== null && typeof value === 'object';
}

function entriesOf(value: Record<string, unknown> | unknown[]): Array<[string, unknown]> {
  return Array.isArray(value)
    ? value.map((entry, index) => [String(index), entry] as [string, unknown])
    : Object.entries(value);
}

function scalarText(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'string') return value;
  return String(value);
}

/** "8 fields" / "6 items", plus whichever scalar children fit after it. */
function containerSummary(value: Record<string, unknown> | unknown[]): string {
  const entries = entriesOf(value);
  const head = Array.isArray(value)
    ? `${entries.length} item${entries.length === 1 ? '' : 's'}`
    : `${entries.length} field${entries.length === 1 ? '' : 's'}`;
  const preview: string[] = [];
  for (const [key, child] of entries) {
    if (preview.length >= SUMMARY_CHILDREN) break;
    if (isContainer(child)) continue;
    const text = scalarText(child);
    if (!text || text.length > 40) continue;
    preview.push(Array.isArray(value) ? text : `${key} ${text}`);
  }
  return preview.length > 0 ? `${head} · ${preview.join(', ')}` : head;
}

function textOf(value: unknown): string {
  if (!isContainer(value)) return scalarText(value);
  return entriesOf(value).map(([key, child]) => `${key} ${textOf(child)}`).join(' ');
}

function nodeMatches(key: string, value: unknown, needle: string): boolean {
  if (!needle) return true;
  return key.toLowerCase().includes(needle) || textOf(value).toLowerCase().includes(needle);
}

function Chevron(props: { open: boolean }) {
  return (
    <svg class="field-chev" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <path d={props.open ? 'm6 9 6 6 6-6' : 'm9 6 6 6-6 6'} />
    </svg>
  );
}

function FieldValue(props: { value: unknown; links: Map<string, { href: string; title: string }> }) {
  const { value, links } = props;
  if (value === null) return <code class="field-null">null</code>;
  if (typeof value === 'number' || typeof value === 'boolean') return <code class="field-num">{String(value)}</code>;
  const text = String(value);
  if (looksLikeUlid(text)) {
    const link = links.get(text);
    return link
      ? <><a class="field-id" href={link.href}>{text}</a> <span class="field-id-title">→ {link.title}</span></>
      : <code class="field-id">{text}</code>;
  }
  return <>{text}</>;
}

function FieldNode(props: {
  name: string;
  value: unknown;
  depth: number;
  needle: string;
  links: Map<string, { href: string; title: string }>;
}) {
  const { name, value, depth, needle, links } = props;
  const [open, setOpen] = useState(false);
  const indent = { paddingLeft: `${18 + depth * INDENT_PX}px` };

  if (!isContainer(value)) {
    return (
      <div class="field-row" style={indent}>
        <span class="field-key">{name}</span>
        <span class="field-value"><FieldValue value={value} links={links} /></span>
      </div>
    );
  }

  // A search hit deep in a collapsed group is invisible, so filtering opens
  // every group on the path to a match.
  const expanded = open || (needle !== '' && nodeMatches(name, value, needle));
  const children = entriesOf(value).filter(([key, child]) => !needle || nodeMatches(key, child, needle));
  return (
    <>
      <button type="button" class={`field-row field-group${expanded ? ' open' : ''}`} style={indent} aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <span class="field-key"><Chevron open={expanded} />{name}</span>
        <span class="field-summary">{containerSummary(value)}</span>
      </button>
      {expanded && children.map(([key, child]) => (
        <FieldNode key={key} name={key} value={child} depth={depth + 1} needle={needle} links={links} />
      ))}
    </>
  );
}

export default function StoreItemDetail() {
  const { params } = useRoute();
  const location = useLocation();
  const storeName = decodeURIComponent(params.store ?? '');
  const itemId = decodeURIComponent(params.item ?? '');
  const project = location.query.project || undefined;
  const [tab, setTab] = useState<'fields' | 'json'>('fields');
  const [query, setQuery] = useState('');

  const { data, error, loading } = useFetch(
    `store-item:${storeName}:${itemId}:${project ?? ''}`,
    () => fetchStoreItem(storeName, itemId, project)
  );

  const item = data?.item;
  const multiProject = data?.multiProject ?? false;
  useTitle(item ? pageTitle('Stores', storeName, storeItemTitle(item)) : pageTitle('Stores', storeName));

  const storeParams = new URLSearchParams();
  if (multiProject && data?.project) storeParams.set('project', data.project);
  const backParams = new URLSearchParams(storeParams);
  backParams.set('highlight', itemId);
  const backHref = `/stores/${encodeURIComponent(storeName)}?${backParams.toString()}`;
  const goBack = useSmartBack(backHref);

  const refHref = (ref: StoreItemRef): string =>
    `/stores/${encodeURIComponent(storeName)}/${encodeURIComponent(ref.id)}${storeParams.toString() ? `?${storeParams.toString()}` : ''}`;

  const links = useMemo(() => {
    const map = new Map<string, { href: string; title: string }>();
    for (const ref of [data?.parent, ...(data?.children ?? [])]) {
      if (ref) map.set(ref.id, { href: refHref(ref), title: ref.title });
    }
    return map;
  }, [data]);

  const fields = item ? Object.entries(valueAsRecord(item.data)) : [];
  const needle = query.trim().toLowerCase();
  const visibleFields = fields.filter(([key, value]) => nodeMatches(key, value, needle));

  return (
    <div class="page-stores page-store-item">
      <main>
        <div class="crumbs">
          <a href="/stores">Stores</a><span class="sep">›</span>
          <a href={backHref} onClick={goBack}>{storeName}</a>
          {item && <><span class="sep">›</span><span>{storeItemTitle(item)}</span></>}
        </div>
        {error && <div class="errors" role="alert">Failed to load item: {error.message}</div>}
        {loading && !item && <div class="panel"><Loading label="Loading item…" /></div>}
        {item && data && (
          <>
            <header>
              <div class="header-text">
                <div class="item-chips">
                  {item.status && <span class={statusChipClass(item.status)}>{item.status}</span>}
                  {item.type && <span class="chip">{item.type}</span>}
                  {multiProject && <code class="proj-tag">{data.project}</code>}
                </div>
                <h1>{storeItemTitle(item)}</h1>
                <p class="lede">
                  {item.createdBy ? <>Written by {shortAgentName(item.createdBy)} on </> : <>Created </>}
                  {formatApprovalTime(Date.parse(item.createdAt))}
                  {' · last updated '}
                  <span title={formatApprovalTime(Date.parse(item.updatedAt))}>{formatRelativeTime(Date.parse(item.updatedAt))}</span>
                </p>
              </div>
              <div class="header-actions">
                <CopyButton text={item.id} label="item ID" variant="button">Copy ID</CopyButton>
                <CopyButton text={JSON.stringify(item, null, 2)} label="item JSON" variant="button">Copy JSON</CopyButton>
              </div>
            </header>

            <div class="item-meta surface">
              <div class="item-meta-cell">
                <div class="caps">ID</div>
                <code>{item.id}</code>
              </div>
              {data.parent && (
                <div class="item-meta-cell">
                  <div class="caps">Parent</div>
                  <a href={refHref(data.parent)}>{data.parent.title}</a>
                  <code class="item-meta-sub">{[data.parent.type, data.parent.status, data.parent.id].filter(Boolean).join(' · ')}</code>
                </div>
              )}
              <div class="item-meta-cell">
                <div class="caps">Linked items</div>
                {data.children.length === 0
                  ? <span class="muted">None</span>
                  : <>
                    <span class="item-meta-count">{data.children.length} item{data.children.length === 1 ? '' : 's'} point{data.children.length === 1 ? 's' : ''} here</span>
                    <span class="item-meta-sub">
                      {data.children.slice(0, LINKED_SHOWN).map((child, index) => (
                        <span key={child.id}>{index > 0 && ' · '}<a href={refHref(child)}>{child.title}</a></span>
                      ))}
                      {data.children.length > LINKED_SHOWN && <span class="muted"> · {data.children.length - LINKED_SHOWN} more</span>}
                    </span>
                  </>}
              </div>
              {item.tags && item.tags.length > 0 && (
                <div class="item-meta-cell wide">
                  <div class="caps">Tags</div>
                  <div class="chips">{item.tags.map((tag) => <span class="chip" key={tag}>{tag}</span>)}</div>
                </div>
              )}
            </div>

            <div class="item-tabs">
              <div class="segments" role="tablist" aria-label="Store item views">
                <button type="button" role="tab" id="tab-fields" aria-controls="panel-fields" aria-selected={tab === 'fields'} class={`segment${tab === 'fields' ? ' active' : ''}`} onClick={() => setTab('fields')}>
                  <span>Fields</span><span class="count">{fields.length}</span>
                </button>
                <button type="button" role="tab" id="tab-json" aria-controls="panel-json" aria-selected={tab === 'json'} class={`segment${tab === 'json' ? ' active' : ''}`} onClick={() => setTab('json')}>
                  <span>Raw JSON</span>
                </button>
              </div>
              {tab === 'fields' && fields.length > 0 && (
                <ListFilter value={query} onInput={setQuery} placeholder="Find a field…" label="Find a field" />
              )}
            </div>

            <section id="panel-fields" class="tab-panel surface field-tree" role="tabpanel" aria-labelledby="tab-fields" hidden={tab !== 'fields'}>
              {fields.length === 0 && <div class="empty">No item data.</div>}
              {fields.length > 0 && visibleFields.length === 0 && <div class="empty">No field matches “{query}”.</div>}
              {visibleFields.map(([key, value]) => (
                <FieldNode key={key} name={key} value={value} depth={0} needle={needle} links={links} />
              ))}
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
