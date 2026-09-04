import { existsSync } from "fs";
import { readFile } from "fs/promises";
import { dirname, join } from "path";
import { glob } from "glob";
import { StoreFileSchema, isSafeStoreName } from "../../store/schema";
import type { StoreItem } from "../../store/types";
import { storeItemPreview, storeItemTitle, summarizeStoreItems } from "../../store/display";
import type { StoreDisplay } from "../../store/display";
import { escapeHtml, formatApprovalTime, isJsonLikeContent, valueAsRecord } from "./ui";

export { isSafeStoreName };
export { storeItemPreview, storeItemTitle };
export type { StoreDisplay };

interface StoreLogEntry {
  tool?: string;
  message?: string;
}

export interface StoreBrowserSummary {
  projectId: string;
  name: string;
  itemCount: number;
  updatedAt?: number;
  types: string[];
  statuses: string[];
  /** Per-status item counts, so the index can draw the pipeline mix. */
  statusCounts: Record<string, number>;
  /** Distinct `createdBy` values. */
  agents: string[];
  /** Which table shape this store reads as; the client may override it. */
  display: StoreDisplay;
}

export interface StoreBrowserRows {
  projectId: string;
  storeName: string;
  items: StoreItem[];
  statusCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  agents: string[];
  display: StoreDisplay;
}

/** A parent or child item, resolved to what a link needs to render. */
export interface StoreItemRef {
  id: string;
  title: string;
  type?: string;
  status?: string;
}

export interface StoreItemRelations {
  item: StoreItem;
  parent: StoreItemRef | null;
  children: StoreItemRef[];
}

function toItemRef(item: StoreItem): StoreItemRef {
  return {
    id: item.id,
    title: storeItemTitle(item),
    ...(item.type ? { type: item.type } : {}),
    ...(item.status ? { status: item.status } : {})
  };
}

export interface StoreProjectRef {
  id: string;
  root: string;
}


function parseStoreToolPayload(message?: string): Record<string, unknown> | undefined {
  if (!message || !isJsonLikeContent(message)) return undefined;
  try {
    const parsed = JSON.parse(message);
    return valueAsRecord(parsed);
  } catch {
    return undefined;
  }
}

function storeToolEvent(entry: StoreLogEntry, projectId?: string): { store?: string; itemId?: string; item?: StoreItem; href?: string } | undefined {
  if (!entry.tool?.startsWith('store_')) return undefined;
  const payload = parseStoreToolPayload(entry.message);
  if (!payload) return undefined;
  const item = valueAsRecord(payload.item) as unknown as StoreItem;
  const store = typeof payload.store === 'string' && payload.store ? payload.store : undefined;
  const itemId = typeof payload.itemId === 'string' && payload.itemId
    ? payload.itemId
    : typeof payload.id === 'string' && payload.id
      ? payload.id
      : typeof item.id === 'string' && item.id
        ? item.id
        : undefined;
  const params = new URLSearchParams();
  if (projectId) params.set('project', projectId);
  if (itemId) params.set('highlight', itemId);
  const href = store
    ? `/stores/${encodeURIComponent(store)}${params.toString() ? `?${params.toString()}` : ''}`
    : undefined;
  return {
    ...(store ? { store } : {}),
    ...(itemId ? { itemId } : {}),
    ...(typeof item.id === 'string' ? { item } : {}),
    ...(href ? { href } : {})
  };
}

export function renderStoreToolEvent(entry: StoreLogEntry, projectId?: string): string {
  const event = storeToolEvent(entry, projectId);
  if (!event) return '';
  const item = event.item;
  const summary = item
    ? `<div class="store-event-title">${escapeHtml(storeItemTitle(item))}</div>
       <div class="store-event-meta">
        ${item.type ? `<span>${escapeHtml(item.type)}</span>` : ''}
        ${item.status ? `<span>${escapeHtml(item.status)}</span>` : ''}
        ${event.itemId ? `<code>${escapeHtml(event.itemId)}</code>` : ''}
       </div>
       ${storeItemPreview(item) ? `<div class="store-event-preview">${escapeHtml(storeItemPreview(item))}</div>` : ''}`
    : `<div class="store-event-title">${escapeHtml(event.itemId ?? 'Store operation')}</div>`;
  return `<div class="store-event">
    <div>
      ${event.store ? `<div class="store-event-store">Store: <code>${escapeHtml(event.store)}</code></div>` : ''}
      ${summary}
    </div>
    ${event.href ? `<a class="store-event-link" href="${escapeHtml(event.href)}">Open in Store</a>` : ''}
  </div>`;
}

function resolveStoreRoot(projectRoot: string): string {
  return join(projectRoot, '.agentuse', 'store');
}

async function readStoreItems(projectRoot: string, storeName: string): Promise<StoreItem[]> {
  if (!isSafeStoreName(storeName)) throw new Error('Invalid store name');
  const storePath = join(resolveStoreRoot(projectRoot), storeName, 'items.json');
  const parsed = StoreFileSchema.parse(JSON.parse(await readFile(storePath, 'utf-8')));
  return parsed.items as StoreItem[];
}

export async function listProjectStores(project: StoreProjectRef): Promise<{ stores: StoreBrowserSummary[]; errors: Array<{ storeName?: string; message: string }> }> {
  const storeRoot = resolveStoreRoot(project.root);
  if (!existsSync(storeRoot)) return { stores: [], errors: [] };
  const stores: StoreBrowserSummary[] = [];
  const errors: Array<{ storeName?: string; message: string }> = [];
  const files = await glob('**/items.json', { cwd: storeRoot, nodir: true, dot: true });

  for (const file of files.sort()) {
    const storeName = dirname(file);
    if (!isSafeStoreName(storeName)) continue;
    try {
      const items = await readStoreItems(project.root, storeName);
      const timestamps = items
        .map((item) => Date.parse(item.updatedAt))
        .filter((value) => Number.isFinite(value));
      const types = [...new Set(items.map((item) => item.type).filter((value): value is string => Boolean(value)))].sort();
      const statuses = [...new Set(items.map((item) => item.status).filter((value): value is string => Boolean(value)))].sort();
      const summary = summarizeStoreItems(items);
      stores.push({
        projectId: project.id,
        name: storeName,
        itemCount: items.length,
        ...(timestamps.length > 0 && { updatedAt: Math.max(...timestamps) }),
        types,
        statuses,
        statusCounts: summary.statusCounts,
        agents: summary.agents,
        display: summary.display
      });
    } catch (err) {
      errors.push({ storeName, message: (err as Error).message });
    }
  }

  stores.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0) || a.name.localeCompare(b.name));
  return { stores, errors };
}

export async function listStoreRows(project: StoreProjectRef, storeName: string): Promise<StoreBrowserRows> {
  const items = await readStoreItems(project.root, storeName);
  items.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  return { projectId: project.id, storeName, items, ...summarizeStoreItems(items) };
}

/**
 * The item plus the two links a reader needs to move through a pipeline: the
 * item it came from, and the items that came from it. Resolved inside the same
 * store, which is where `parentId` is meaningful.
 */
export async function findStoreItemRelations(project: StoreProjectRef, storeName: string, itemId: string): Promise<StoreItemRelations | null> {
  const items = await readStoreItems(project.root, storeName);
  const item = items.find((entry) => entry.id === itemId);
  if (!item) return null;
  const parentItem = item.parentId ? items.find((entry) => entry.id === item.parentId) : undefined;
  const children = items.filter((entry) => entry.parentId === item.id).map(toItemRef);
  return { item, parent: parentItem ? toItemRef(parentItem) : null, children };
}

export function storeItemUpdatedTime(item: StoreItem): string {
  return formatApprovalTime(Date.parse(item.updatedAt));
}
