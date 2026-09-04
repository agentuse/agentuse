/**
 * Display helpers shared by the server (session-log store events, the stores
 * API) and the web app (stores index, store table, item detail). Kept free of
 * runtime dependencies so it can be bundled into the browser build.
 */
import type { StoreItem } from "./types";

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

/** A 26-char Crockford base32 ULID. Item ids read as noise in a preview line. */
export function looksLikeUlid(value: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(value);
}

/** An ISO-8601 date or datetime. Real content, but never what identifies a row. */
export function looksLikeTimestamp(value: string): boolean {
  return /^\d{4}-\d{2}-\d{2}([T ]\d{2}:\d{2}|$)/.test(value);
}

export function storeItemTitle(item: StoreItem): string {
  if (item.title) return item.title;
  const data = asRecord(item.data);
  const candidates = ['title', 'name', 'headline', 'subject', 'url'];
  for (const key of candidates) {
    const value = data[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return item.id;
}

/**
 * One line of the item's own content, for the row under its title.
 *
 * Earlier this fell back to a shape summary ("object · 39 keys: a, b, …"),
 * which described the payload without saying anything about the item. Instead
 * take the first few top-level scalar fields and print their values: those are
 * what an operator recognizes a row by.
 *
 * Anything the row already shows is dropped, or the preview just restates the
 * line above it: text the title contains, the writing agent's name, and item
 * ids. Timestamps are held back and used only when nothing else survives.
 */
export function storeItemPreview(item: StoreItem, max = 110): string {
  const data = asRecord(item.data);
  const title = storeItemTitle(item).toLowerCase();
  const parts: string[] = [];
  const timestamps: string[] = [];
  for (const [key, value] of Object.entries(data)) {
    if (parts.length >= 4) break;
    if (typeof value === 'string') {
      const compact = value.trim().replace(/\s+/g, ' ');
      if (!compact || compact.length > 60 || looksLikeUlid(compact)) continue;
      if (compact === item.createdBy || compact.startsWith('agents/')) continue;
      if (title.includes(compact.toLowerCase())) continue;
      if (looksLikeTimestamp(compact)) { timestamps.push(compact); continue; }
      parts.push(compact);
    } else if (typeof value === 'number' || typeof value === 'boolean') {
      parts.push(`${key.replace(/_/g, ' ')} ${value}`);
    }
  }
  const line = (parts.length > 0 ? parts : timestamps.slice(0, 1)).join(' · ');
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

/**
 * Tone bucket for a free-form store status. Statuses are agent-authored, so
 * this matches on substrings rather than an enum: only an actual failure is
 * red, anything that reads as waiting on a human is amber, anything that
 * reads as finished is grey, and everything else is in-flight cyan.
 * Checked failure-first so "review failed" reads as a failure, not a review.
 *
 * "rejected", "expired", "skipped" and friends are terminal outcomes, not
 * failures: an item that was considered and dropped is finished, and counting
 * it as red made every pipeline look like it needed attention.
 */
export type StoreStatusBucket = 'blocked' | 'attention' | 'done' | 'active';

export function storeStatusBucket(status: string): StoreStatusBucket {
  const value = status.toLowerCase();
  if (/block|fail|error/.test(value)) return 'blocked';
  if (/await|pending|review|measur|draft|ready/.test(value)) return 'attention';
  if (/done|complete|publish|posted|sent|consumed|skipped|rejected|expired|abandoned|cleared|success|^ok$/.test(value)) return 'done';
  return 'active';
}

/** Order the stacked bar paints in: finished, in-flight, waiting, failed. */
export const STORE_STATUS_BUCKETS: StoreStatusBucket[] = ['done', 'active', 'attention', 'blocked'];

/** Does this status mix have anything a human should look at? */
export function storeNeedsAttention(statusCounts: Record<string, number>): boolean {
  return Object.entries(statusCounts).some(([status, count]) => {
    if (count <= 0) return false;
    const bucket = storeStatusBucket(status);
    return bucket === 'attention' || bucket === 'blocked';
  });
}

/** An agent name is a path (`newsletter/pipeline`); rows only have room for the leaf. */
export function shortAgentName(name: string): string {
  return name.split('/').filter(Boolean).pop() ?? name;
}

/**
 * A store is a pipeline when its items carry a status and actually move
 * through it: nearly everything is labelled, and at least half the items were
 * updated meaningfully after they were created. A log or a metrics dump has
 * write-once rows and fails the second test even when it does carry statuses.
 */
export const PIPELINE_STATUS_RATIO = 0.95;
export const PIPELINE_MOVED_RATIO = 0.5;
export const PIPELINE_MOVED_MS = 60_000;

export type StoreDisplay = 'pipeline' | 'table';

export interface StoreItemsSummary {
  display: StoreDisplay;
  statusCounts: Record<string, number>;
  typeCounts: Record<string, number>;
  agents: string[];
}

export function summarizeStoreItems(items: StoreItem[]): StoreItemsSummary {
  const statusCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  const agents = new Set<string>();
  let withStatus = 0;
  let moved = 0;

  for (const item of items) {
    if (item.status) {
      withStatus += 1;
      statusCounts[item.status] = (statusCounts[item.status] ?? 0) + 1;
    }
    if (item.type) typeCounts[item.type] = (typeCounts[item.type] ?? 0) + 1;
    if (item.createdBy) agents.add(item.createdBy);
    const created = Date.parse(item.createdAt);
    const updated = Date.parse(item.updatedAt);
    if (Number.isFinite(created) && Number.isFinite(updated) && updated - created > PIPELINE_MOVED_MS) moved += 1;
  }

  const display: StoreDisplay = items.length > 0
    && withStatus / items.length >= PIPELINE_STATUS_RATIO
    && moved / items.length >= PIPELINE_MOVED_RATIO
    ? 'pipeline'
    : 'table';

  return { display, statusCounts, typeCounts, agents: [...agents].sort() };
}

/** Merge per-project summaries into the one the store page renders from. */
export function mergeStoreSummaries(summaries: StoreItemsSummary[]): StoreItemsSummary {
  const statusCounts: Record<string, number> = {};
  const typeCounts: Record<string, number> = {};
  const agents = new Set<string>();
  let pipeline = false;
  for (const summary of summaries) {
    if (summary.display === 'pipeline') pipeline = true;
    for (const [key, count] of Object.entries(summary.statusCounts)) statusCounts[key] = (statusCounts[key] ?? 0) + count;
    for (const [key, count] of Object.entries(summary.typeCounts)) typeCounts[key] = (typeCounts[key] ?? 0) + count;
    for (const agent of summary.agents) agents.add(agent);
  }
  return { display: pipeline ? 'pipeline' : 'table', statusCounts, typeCounts, agents: [...agents].sort() };
}
