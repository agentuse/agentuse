import { STORE_STATUS_BUCKETS, storeStatusBucket, type StoreDisplay, type StoreStatusBucket } from '../../../../store/display';

export type StoreViewChoice = 'auto' | StoreDisplay;

const VIEW_KEY_PREFIX = 'agentuse:store-view:';

function viewKey(project: string | undefined, store: string): string {
  return `${VIEW_KEY_PREFIX}${project ? `${project}/` : ''}${store}`;
}

/** Per-store display override, remembered in this browser. Auto follows the server's guess. */
export function readStoreView(project: string | undefined, store: string): StoreViewChoice {
  try {
    const raw = localStorage.getItem(viewKey(project, store));
    return raw === 'pipeline' || raw === 'table' ? raw : 'auto';
  } catch {
    return 'auto';
  }
}

export function writeStoreView(project: string | undefined, store: string, choice: StoreViewChoice): void {
  try {
    if (choice === 'auto') localStorage.removeItem(viewKey(project, store));
    else localStorage.setItem(viewKey(project, store), choice);
  } catch {
    // Private-mode browsers refuse storage; the view still works for this visit.
  }
}

/** Chip / bar class for a status, from its tone bucket. */
export function statusChipClass(status: string): string {
  const bucket = storeStatusBucket(status);
  if (bucket === 'blocked') return 'chip bad';
  if (bucket === 'attention') return 'chip warn';
  return 'chip status';
}

export interface StatusSlice {
  status: string;
  count: number;
  bucket: StoreStatusBucket;
}

/** Statuses, largest first — the order both the bar text and the segments use. */
export function statusSlices(statusCounts: Record<string, number>): StatusSlice[] {
  return Object.entries(statusCounts)
    .filter(([, count]) => count > 0)
    .map(([status, count]) => ({ status, count, bucket: storeStatusBucket(status) }))
    .sort((a, b) => b.count - a.count || a.status.localeCompare(b.status));
}

export interface BarSegment {
  bucket: StoreStatusBucket;
  count: number;
  pct: number;
}

/** The stacked bar: one segment per tone bucket, painted finished → failed. */
export function statusBar(statusCounts: Record<string, number>): BarSegment[] {
  const totals = new Map<StoreStatusBucket, number>();
  let total = 0;
  for (const slice of statusSlices(statusCounts)) {
    totals.set(slice.bucket, (totals.get(slice.bucket) ?? 0) + slice.count);
    total += slice.count;
  }
  if (total === 0) return [];
  return STORE_STATUS_BUCKETS
    .map((bucket) => ({ bucket, count: totals.get(bucket) ?? 0, pct: ((totals.get(bucket) ?? 0) / total) * 100 }))
    .filter((segment) => segment.count > 0);
}

/** "seo_post · task · seo_discovery_run" — or two names and a count past three. */
export function typeSummary(types: string[]): string {
  if (types.length === 0) return '';
  if (types.length <= 3) return types.join(' · ');
  return `${types.slice(0, 2).join(' · ')} · ${types.length - 2} more`;
}
