/**
 * Store tools that are injected into agents with store configuration
 */

import type { Tool } from 'ai';
import { z } from 'zod';
import type { Store } from './store';
import type { StoreCreateOptions, StoreUpdateOptions, StoreListOptions } from './types';

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
        const item = await store.create(options);
        return {
          success: true,
          item,
          message: `Created item with ID: ${item.id}`,
        };
      },
    },

    /**
     * Get an item by ID
     */
    store_get: {
      description: `Get an item from the "${storeName}" store by its ID.`,
      inputSchema: z.object({
        id: z.string().describe('The item ID to retrieve'),
      }),
      execute: async ({ id }: { id: string }) => {
        const item = await store.get(id);
        if (!item) {
          return {
            success: false,
            error: `Item not found: ${id}`,
          };
        }
        return {
          success: true,
          item,
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
        const item = await store.update(id, options);
        if (!item) {
          return {
            success: false,
            error: `Item not found: ${id}`,
          };
        }
        return {
          success: true,
          item,
          message: `Updated item: ${id}`,
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
          message: `Deleted item: ${id}`,
        };
      },
    },

    /**
     * List items with optional filtering
     */
    store_list: {
      description: `List items from the "${storeName}" store with optional filtering. Returns items sorted by creation date (newest first).`,
      inputSchema: z.object({
        type: z.string().optional().describe('Filter by item type'),
        status: z.string().optional().describe('Filter by status'),
        parentId: z.string().optional().describe('Filter by parent ID'),
        tag: z.string().optional().describe('Filter by tag'),
        limit: z.number().positive().optional().describe('Maximum number of items to return'),
        offset: z.number().nonnegative().optional().describe('Number of items to skip'),
      }),
      execute: async ({ type, status, parentId, tag, limit, offset }: {
        type?: string;
        status?: string;
        parentId?: string;
        tag?: string;
        limit?: number;
        offset?: number;
      }) => {
        const options: StoreListOptions = filterUndefined({ type, status, parentId, tag, limit, offset });
        const items = await store.list(options);
        return {
          success: true,
          count: items.length,
          items,
        };
      },
    },
  };
}
