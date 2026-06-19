/**
 * Store tools that are injected into agents with store configuration
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import type { Store } from './store';
import type { StoreCreateOptions, StoreUpdateOptions, StoreListOptions, StoreItem } from './types';

/**
 * Helper to filter out undefined values from an object
 * This ensures we don't pass undefined to methods that don't expect it
 */
function filterUndefined<T extends Record<string, unknown>>(obj: T): Partial<T> {
  const result: Partial<T> = {};
  for (const key in obj) {
    if (obj[key] !== undefined) {
      result[key] = obj[key];
    }
  }
  return result;
}

/** A store item with its `data` payload optionally omitted or narrowed. */
type ProjectedItem = Omit<StoreItem, 'data'> & { data?: Record<string, unknown> };

/**
 * Project an item for a tool response to keep token usage down.
 * - `includeData`: return the full item unchanged.
 * - `fields`: include only those keys from `data`.
 * - neither: drop `data` entirely (metadata-only summary row).
 */
function projectItem(
  item: StoreItem,
  opts: { includeData?: boolean; fields?: string[] } = {}
): StoreItem | ProjectedItem {
  if (opts.includeData) return item;

  const { data, ...meta } = item;
  if (opts.fields && opts.fields.length > 0) {
    const picked: Record<string, unknown> = {};
    for (const key of opts.fields) {
      if (key in data) picked[key] = data[key];
    }
    return { ...meta, data: picked };
  }
  return meta;
}

/**
 * Build a short snippet showing where a free-text `q` matched, so a summary
 * row (which omits `data`) still explains why it was returned.
 */
function matchSnippet(item: StoreItem, q: string, window = 60): string | undefined {
  const needle = q.toLowerCase();
  const sources = [item.title, item.type, ...(item.tags ?? []), JSON.stringify(item.data)];
  for (const source of sources) {
    if (!source) continue;
    const idx = source.toLowerCase().indexOf(needle);
    if (idx === -1) continue;
    const start = Math.max(0, idx - window);
    const end = Math.min(source.length, idx + needle.length + window);
    const prefix = start > 0 ? '…' : '';
    const suffix = end < source.length ? '…' : '';
    return `${prefix}${source.slice(start, end).replace(/\s+/g, ' ').trim()}${suffix}`;
  }
  return undefined;
}

/**
 * Create store tools for an agent
 * @param store The Store instance
 * @returns Record of store tools
 */
export function createStoreTools(store: Store): Record<string, Tool> {
  const storeName = store.getStoreName();

  return {
    /**
     * Create a new item in the store
     */
    store_create: {
      description: `Create a new item in the "${storeName}" store. Use this to track work items, results, or any data you want to persist.`,
      inputSchema: z.object({
        type: z.string().optional().describe('Item type (e.g., "keyword", "outline", "draft")'),
        title: z.string().optional().describe('Human-readable title'),
        status: z.string().optional().describe('Status (e.g., "pending", "in_progress", "done")'),
        data: z.record(z.unknown()).describe('The item data payload'),
        parentId: z.string().optional().describe('ID of parent item to link to'),
        tags: z.array(z.string()).optional().describe('Tags for categorization'),
      }),
      execute: async ({ type, title, status, data, parentId, tags }: {
        type?: string;
        title?: string;
        status?: string;
        data: Record<string, unknown>;
        parentId?: string;
        tags?: string[];
      }) => {
        const options: StoreCreateOptions = {
          data,
          ...filterUndefined({ type, title, status, parentId, tags }),
        };
        let item;
        try {
          item = await store.create(options);
        } catch (error) {
          return {
            success: false,
            error: (error as Error).message,
          };
        }
        // Echo only metadata (no `data`) - the caller already has the payload
        // it sent; returning it again just burns tokens.
        return {
          success: true,
          store: storeName,
          id: item.id,
          item: projectItem(item),
        };
      },
    },

    /**
     * Get an item by ID
     */
    store_get: {
      description: `Get a single item (with its full data) from the "${storeName}" store by its ID.`,
      inputSchema: z.object({
        id: z.string().describe('The item ID to retrieve'),
        fields: z.array(z.string()).optional().describe('If set, return only these keys from the item data instead of the full payload'),
      }),
      execute: async ({ id, fields }: { id: string; fields?: string[] }) => {
        const item = await store.get(id);
        if (!item) {
          return {
            success: false,
            error: `Item not found: ${id}`,
          };
        }
        return {
          success: true,
          store: storeName,
          id: item.id,
          item: fields ? projectItem(item, { fields }) : item,
        };
      },
    },

    /**
     * Update an item by ID
     */
    store_update: {
      description: `Update an existing item in the "${storeName}" store. Only provided fields will be updated.`,
      inputSchema: z.object({
        id: z.string().describe('The item ID to update'),
        type: z.string().optional().describe('New item type'),
        title: z.string().optional().describe('New title'),
        status: z.string().optional().describe('New status'),
        data: z.record(z.unknown()).optional().describe('Data fields to merge into existing data'),
        parentId: z.string().optional().describe('New parent ID'),
        tags: z.array(z.string()).optional().describe('New tags (replaces existing)'),
      }),
      execute: async ({ id, type, title, status, data, parentId, tags }: {
        id: string;
        type?: string;
        title?: string;
        status?: string;
        data?: Record<string, unknown>;
        parentId?: string;
        tags?: string[];
      }) => {
        const options: StoreUpdateOptions = filterUndefined({ type, title, status, data, parentId, tags });
        let item;
        try {
          item = await store.update(id, options);
        } catch (error) {
          return {
            success: false,
            error: (error as Error).message,
          };
        }
        if (!item) {
          return {
            success: false,
            error: `Item not found: ${id}`,
          };
        }
        return {
          success: true,
          store: storeName,
          id: item.id,
          item: projectItem(item),
        };
      },
    },

    /**
     * Delete an item by ID
     */
    store_delete: {
      description: `Delete an item from the "${storeName}" store.`,
      inputSchema: z.object({
        id: z.string().describe('The item ID to delete'),
      }),
      execute: async ({ id }: { id: string }) => {
        const deleted = await store.delete(id);
        if (!deleted) {
          return {
            success: false,
            error: `Item not found: ${id}`,
          };
        }
        return {
          success: true,
          store: storeName,
          id,
          deleted: true,
        };
      },
    },

    /**
     * List/search items with optional filtering and projection
     */
    store_list: {
      description:
        `List/search items in the "${storeName}" store, newest first. ` +
        `Returns lightweight summary rows (no "data" payload, but a "dataKeys" list of available keys) ` +
        `so you can scan many items cheaply, then call store_get for the full data of the one you want. ` +
        `Narrow with filters or "q" before reading; set includeData/fields only when you truly need payloads.`,
      inputSchema: z.object({
        type: z.string().optional().describe('Filter by item type'),
        status: z.string().optional().describe('Filter by status'),
        parentId: z.string().optional().describe('Filter by parent ID'),
        tag: z.string().optional().describe('Filter by tag'),
        ids: z.array(z.string()).optional().describe('Fetch these specific item IDs in one call'),
        where: z.record(z.union([z.string(), z.number(), z.boolean()])).optional()
          .describe('Exact-match filters on keys inside item data, e.g. { "stage": "review" }'),
        q: z.string().optional().describe('Case-insensitive substring search across title, type, tags and data'),
        includeData: z.boolean().optional().describe('Include the full data payload of each item (default false)'),
        fields: z.array(z.string()).optional().describe('Include only these keys from each item data (ignored if includeData is true)'),
        limit: z.number().positive().optional().describe('Maximum number of items to return'),
        offset: z.number().nonnegative().optional().describe('Number of items to skip'),
      }),
      execute: async ({ type, status, parentId, tag, ids, where, q, includeData, fields, limit, offset }: {
        type?: string;
        status?: string;
        parentId?: string;
        tag?: string;
        ids?: string[];
        where?: Record<string, string | number | boolean>;
        q?: string;
        includeData?: boolean;
        fields?: string[];
        limit?: number;
        offset?: number;
      }) => {
        const options: StoreListOptions = filterUndefined({ type, status, parentId, tag, ids, where, q, limit, offset });
        const { items, total } = await store.query(options);

        const projection = { ...(includeData ? { includeData } : {}), ...(fields ? { fields } : {}) };
        const rows = items.map(item => {
          const row = projectItem(item, projection);
          if (includeData) return row;
          // Summary/fields rows omit some or all data: list available keys so the
          // agent knows what it could request, and show why a `q` match hit.
          const extra: Record<string, unknown> = { dataKeys: Object.keys(item.data) };
          if (q) {
            const snippet = matchSnippet(item, q);
            if (snippet) extra.match = snippet;
          }
          return { ...row, ...extra };
        });

        return {
          success: true,
          store: storeName,
          count: rows.length,
          total,
          items: rows,
        };
      },
    },
  };
}
