/**
 * Store types for persistent agent data storage
 */

/**
 * A single item in the store
 */
export interface StoreItem {
  // Auto-managed fields
  id: string;              // ULID
  createdAt: string;       // ISO timestamp
  updatedAt: string;       // ISO timestamp

  // Optional structure - explicitly allow undefined for exactOptionalPropertyTypes
  type?: string | undefined;           // "keyword" | "outline" | "draft" | custom
  status?: string | undefined;         // "pending" | "in_progress" | "done" | custom
  title?: string | undefined;          // human-readable

  // Ownership (for shared stores)
  createdBy?: string | undefined;      // agent name

  // Flexible payload
  data: Record<string, unknown>;

  // Relations
  parentId?: string | undefined;       // link items together
  tags?: string[] | undefined;
}

/**
 * Store configuration - can be:
 * - true: isolated store using agent name
 * - string: shared store with explicit name
 */
export type StoreConfig = true | string;

/**
 * Options for creating a store item
 */
export interface StoreCreateOptions {
  type?: string | undefined;
  title?: string | undefined;
  status?: string | undefined;
  data: Record<string, unknown>;
  parentId?: string | undefined;
  tags?: string[] | undefined;
}

/**
 * Options for updating a store item
 */
export interface StoreUpdateOptions {
  type?: string | undefined;
  title?: string | undefined;
  status?: string | undefined;
  data?: Record<string, unknown> | undefined;
  parentId?: string | undefined;
  tags?: string[] | undefined;
}

/**
 * Options for listing store items
 */
export interface StoreListOptions {
  type?: string | undefined;
  status?: string | undefined;
  parentId?: string | undefined;
  tag?: string | undefined;
  limit?: number | undefined;
  offset?: number | undefined;
}

/**
 * Store file structure (what's saved to disk)
 */
export interface StoreFile {
  version: 1;
  items: StoreItem[];
}
