/**
 * Store class for persistent agent data storage
 */

import { readFile, writeFile, mkdir, unlink, rename } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import process from 'node:process';
import { randomBytes } from 'crypto';
import { ulid } from 'ulid';
import { logger } from '../utils/logger';
import { StoreFileSchema } from './schema';
import type {
  StoreItem,
  StoreFile,
  StoreCreateOptions,
  StoreUpdateOptions,
  StoreListOptions,
  StoreQueryResult,
} from './types';

/**
 * Loose equality used by `where` filters. Models routinely pass `"5"` for a
 * numeric field or `"true"` for a boolean, so we accept a string form that
 * matches the stored value's string form in addition to strict equality.
 */
function looseEquals(stored: unknown, filter: string | number | boolean): boolean {
  if (stored === filter) return true;
  if (stored === null || stored === undefined) return false;
  if (typeof stored === 'object') return false;
  return String(stored) === String(filter);
}

/**
 * Build the lowercased haystack a free-text `q` search scans for an item:
 * title, type, tags and the stringified data payload.
 */
function searchHaystack(item: StoreItem): string {
  const parts = [item.title, item.type, ...(item.tags ?? []), JSON.stringify(item.data)];
  return parts.filter(Boolean).join(' ').toLowerCase();
}

/**
 * Check if a value is a plain object (not null, not an array).
 * Spreading anything else into store data corrupts it:
 *   {...["a","b"]} -> {0:"a",1:"b"}, {...null} -> {}, {..."str"} -> {0:"s",...}
 */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Normalize an incoming `data` payload to a plain object before it is stored.
 *
 * Callers (and AI models calling the store tools) sometimes pass `data` as a
 * stringified JSON object instead of an object. Without this guard, the store
 * spreads the raw value and silently persists corruption (numeric character
 * keys for strings, index keys for arrays). We accept a plain object as-is,
 * parse a JSON string that decodes to a plain object, and otherwise throw so
 * the caller fails fast instead of corrupting the store.
 */
function normalizeStoreData(data: unknown): Record<string, unknown> {
  if (isPlainObject(data)) return data;

  if (typeof data === 'string') {
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      throw new Error(
        `Store data must be a plain object, received a string that is not valid JSON. ` +
        `Pass an object, e.g. { "field": "value" }.`
      );
    }
    if (isPlainObject(parsed)) return parsed;
    throw new Error(
      `Store data must be a plain object, received a JSON string that decoded to ${describeType(parsed)}. ` +
      `Pass an object, e.g. { "field": "value" }.`
    );
  }

  throw new Error(
    `Store data must be a plain object, received ${describeType(data)}. ` +
    `Pass an object, e.g. { "field": "value" }.`
  );
}

/**
 * Human-readable type description for error messages.
 */
function describeType(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return typeof value;
}

/**
 * Check if a process with given PID is running
 */
function isProcessRunning(pid: number): boolean {
  try {
    // Sending signal 0 checks if process exists without actually sending a signal
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Store class that manages persistent data for agents
 */
export class Store {
  private storePath: string;
  private lockPath: string;
  private items: StoreItem[] = [];
  private loaded = false;
  private locked = false;
  private agentName: string | undefined;
  private storeName: string;
  private static lockRefCounts: Map<string, number> = new Map();
  // Per-lockPath promise chain that serializes acquire/release for a given
  // lock file. The serve worker handles execute/resume requests concurrently
  // (src/index.ts), so multiple Store instances in the same process can call
  // acquireLock/releaseLock on the same path at once. Those methods check the
  // lock file and the ref count across `await` points; without serialization
  // the interleavings drift the ref count and leave the lock file on disk with
  // a live PID, permanently blocking every other process.
  private static lockChains: Map<string, Promise<unknown>> = new Map();

  /**
   * Run an operation inside the per-lockPath critical section so concurrent
   * acquire/release calls for the same lock never interleave.
   */
  private static withLockChain<T>(lockPath: string, operation: () => Promise<T>): Promise<T> {
    const previous = Store.lockChains.get(lockPath) ?? Promise.resolve();
    const result = previous.then(operation, operation);
    // Keep the chain alive regardless of this operation's outcome.
    Store.lockChains.set(lockPath, result.then(() => {}, () => {}));
    return result;
  }

  /**
   * Create a new Store instance
   * @param projectRoot The project root directory
   * @param storeName The name of the store (agent name or shared name)
   * @param agentName Optional agent name for tracking createdBy
   */
  constructor(
    projectRoot: string,
    storeName: string,
    agentName?: string
  ) {
    const storeDir = join(projectRoot, '.agentuse', 'store', storeName);
    this.storePath = join(storeDir, 'items.json');
    this.lockPath = join(storeDir, 'lock');
    this.storeName = storeName;
    this.agentName = agentName;
  }

  /**
   * Acquire exclusive lock on the store
   * @throws Error if store is already locked by another process
   */
  private async acquireLock(): Promise<void> {
    if (this.locked) return;
    await Store.withLockChain(this.lockPath, () => this.acquireLockUnsafe());
  }

  /**
   * Core acquire logic. MUST run inside withLockChain so the check-then-act
   * sequence below is never interleaved with a concurrent acquire/release on
   * the same lock path.
   */
  private async acquireLockUnsafe(): Promise<void> {
    if (this.locked) return;

    // The ref count is the sole authority for same-process re-entrancy. If we
    // already hold this lock in this process, just share it - never re-read the
    // file's PID to decide re-entrancy (that path fabricated phantom holders
    // when a leftover lock file lingered, leaking the lock permanently).
    const existingCount = Store.lockRefCounts.get(this.lockPath) ?? 0;
    if (existingCount > 0) {
      Store.lockRefCounts.set(this.lockPath, existingCount + 1);
      this.locked = true;
      return;
    }

    const storeDir = dirname(this.lockPath);

    // Ensure directory exists
    if (!existsSync(storeDir)) {
      await mkdir(storeDir, { recursive: true });
    }

    // No same-process holder: inspect any on-disk lock before taking it.
    if (existsSync(this.lockPath)) {
      try {
        const lockContent = await readFile(this.lockPath, 'utf-8');
        const lockData = JSON.parse(lockContent);
        const { pid, agent, timestamp } = lockData;

        if (pid === process.pid) {
          // Our own PID but no live ref count: a leftover from a prior holder
          // in this process. Reclaim it instead of counting a phantom holder.
          logger.warn(`[Store] Reclaiming leftover lock from this process`);
        } else if (isProcessRunning(pid)) {
          // Lock is held by a different running process
          const lockAge = Date.now() - new Date(timestamp).getTime();
          const lockAgeStr = lockAge > 60000
            ? `${Math.round(lockAge / 60000)}m ago`
            : `${Math.round(lockAge / 1000)}s ago`;

          throw new Error(
            `Store "${this.storeName}" is locked by another process.\n` +
            `  PID: ${pid}\n` +
            `  Agent: ${agent || 'unknown'}\n` +
            `  Locked: ${lockAgeStr}\n` +
            `Wait for it to complete, or remove the lock file:\n` +
            `  rm "${this.lockPath}"`
          );
        } else {
          // Stale lock from dead process - we can steal it
          logger.warn(`[Store] Removing stale lock from PID ${pid}`);
        }
      } catch (error) {
        if ((error as Error).message.includes('is locked by another process')) {
          throw error;
        }
        // Lock file is corrupted, remove it
        logger.warn(`[Store] Removing corrupted lock file`);
      }
    }

    // Write our lock
    const lockData = {
      pid: process.pid,
      agent: this.agentName,
      timestamp: new Date().toISOString(),
    };
    await writeFile(this.lockPath, JSON.stringify(lockData, null, 2), 'utf-8');
    this.locked = true;
    Store.lockRefCounts.set(this.lockPath, 1);
  }

  /**
   * Release the lock on the store
   */
  async releaseLock(): Promise<void> {
    if (!this.locked) return;
    await Store.withLockChain(this.lockPath, () => this.releaseLockUnsafe());
  }

  /**
   * Core release logic. MUST run inside withLockChain so it never interleaves
   * with a concurrent acquire/release on the same lock path.
   */
  private async releaseLockUnsafe(): Promise<void> {
    if (!this.locked) return;
    // Mark this instance released up front so the ref count tracks the number
    // of live holders exactly, even if the file I/O below throws.
    this.locked = false;

    try {
      const currentCount = (Store.lockRefCounts.get(this.lockPath) ?? 1) - 1;
      if (currentCount > 0) {
        // Other holders in this process remain - keep the file in place.
        Store.lockRefCounts.set(this.lockPath, currentCount);
        return;
      }

      Store.lockRefCounts.delete(this.lockPath);

      if (existsSync(this.lockPath)) {
        // Only remove if we still own the lock
        const lockContent = await readFile(this.lockPath, 'utf-8').catch(() => null);
        const lockData = lockContent ? JSON.parse(lockContent) : null;
        if (!lockData || lockData.pid === process.pid) {
          await unlink(this.lockPath);
        }
      }
    } catch {
      // Ignore errors when releasing lock
    }
  }

  /**
   * Ensure the store is loaded from disk
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    // Acquire lock before loading
    await this.acquireLock();

    if (existsSync(this.storePath)) {
      try {
        const content = await readFile(this.storePath, 'utf-8');
        const data = JSON.parse(content);
        const validated = StoreFileSchema.parse(data);
        // Cast is safe because Zod schema matches our type structure
        this.items = validated.items as StoreItem[];
      } catch (error) {
        // If file is corrupted, start fresh but log warning
        logger.warn(`[Store] Failed to load store from ${this.storePath}: ${(error as Error).message}`);
        this.items = [];
      }
    }

    this.loaded = true;
  }

  /**
   * Save the store to disk using atomic write (write to temp, then rename)
   * This prevents data corruption if the process is killed mid-write
   */
  private async save(): Promise<void> {
    const storeDir = dirname(this.storePath);

    // Ensure directory exists
    if (!existsSync(storeDir)) {
      await mkdir(storeDir, { recursive: true });
    }

    const storeFile: StoreFile = {
      version: 1,
      items: this.items,
    };

    // Atomic write: write to temp file, then rename
    const tempPath = `${this.storePath}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tempPath, JSON.stringify(storeFile, null, 2), 'utf-8');
    await rename(tempPath, this.storePath);
  }

  /**
   * Create a new item in the store
   */
  async create(options: StoreCreateOptions): Promise<StoreItem> {
    await this.ensureLoaded();

    const now = new Date().toISOString();
    const item: StoreItem = {
      id: ulid(),
      createdAt: now,
      updatedAt: now,
      data: normalizeStoreData(options.data),
      ...(options.type && { type: options.type }),
      ...(options.title && { title: options.title }),
      ...(options.status && { status: options.status }),
      ...(options.parentId && { parentId: options.parentId }),
      ...(options.tags && { tags: options.tags }),
      ...(this.agentName && { createdBy: this.agentName }),
    };

    this.items.push(item);
    await this.save();

    return item;
  }

  /**
   * Get an item by ID
   */
  async get(id: string): Promise<StoreItem | null> {
    await this.ensureLoaded();
    return this.items.find(item => item.id === id) || null;
  }

  /**
   * Update an item by ID
   */
  async update(id: string, options: StoreUpdateOptions): Promise<StoreItem | null> {
    await this.ensureLoaded();

    const index = this.items.findIndex(item => item.id === id);
    if (index === -1) return null;

    const existing = this.items[index];
    const updated: StoreItem = {
      ...existing,
      updatedAt: new Date().toISOString(),
      ...(options.type !== undefined && { type: options.type }),
      ...(options.title !== undefined && { title: options.title }),
      ...(options.status !== undefined && { status: options.status }),
      ...(options.parentId !== undefined && { parentId: options.parentId }),
      ...(options.tags !== undefined && { tags: options.tags }),
      ...(options.data !== undefined && {
        data: { ...existing.data, ...normalizeStoreData(options.data) }
      }),
    };

    this.items[index] = updated;
    await this.save();

    return updated;
  }

  /**
   * Delete an item by ID
   */
  async delete(id: string): Promise<boolean> {
    await this.ensureLoaded();

    const index = this.items.findIndex(item => item.id === id);
    if (index === -1) return false;

    this.items.splice(index, 1);
    await this.save();

    return true;
  }

  /**
   * Apply filters and newest-first sorting (no pagination).
   */
  private filterAndSort(options: StoreListOptions): StoreItem[] {
    let results = [...this.items];

    if (options.ids) {
      const ids = new Set(options.ids);
      results = results.filter(item => ids.has(item.id));
    }
    if (options.type) {
      results = results.filter(item => item.type === options.type);
    }
    if (options.status) {
      results = results.filter(item => item.status === options.status);
    }
    if (options.parentId) {
      results = results.filter(item => item.parentId === options.parentId);
    }
    if (options.tag) {
      results = results.filter(item => item.tags?.includes(options.tag!));
    }
    if (options.where) {
      const entries = Object.entries(options.where);
      results = results.filter(item =>
        entries.every(([key, value]) => looseEquals(item.data[key], value))
      );
    }
    if (options.q) {
      const needle = options.q.toLowerCase();
      results = results.filter(item => searchHaystack(item).includes(needle));
    }

    // Sort by createdAt descending (newest first)
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    return results;
  }

  /**
   * Apply limit/offset pagination to an already-filtered list.
   */
  private paginate(items: StoreItem[], options: StoreListOptions): StoreItem[] {
    let results = items;
    if (options.offset) {
      results = results.slice(options.offset);
    }
    if (options.limit) {
      results = results.slice(0, options.limit);
    }
    return results;
  }

  /**
   * List items with optional filtering and pagination.
   */
  async list(options: StoreListOptions = {}): Promise<StoreItem[]> {
    await this.ensureLoaded();
    return this.paginate(this.filterAndSort(options), options);
  }

  /**
   * Query items with optional filtering, returning the requested page plus the
   * total number of items matching the filters (before limit/offset). Lets
   * callers paginate without re-fetching the whole store.
   */
  async query(options: StoreListOptions = {}): Promise<StoreQueryResult> {
    await this.ensureLoaded();
    const filtered = this.filterAndSort(options);
    return { items: this.paginate(filtered, options), total: filtered.length };
  }

  /**
   * Get the store name
   */
  getStoreName(): string {
    return this.storeName;
  }

  /**
   * Get the store file path
   */
  getStorePath(): string {
    return this.storePath;
  }
}

/**
 * Create a Store instance from config
 * @param projectRoot The project root directory
 * @param storeConfig The store configuration (true for isolated, string for shared)
 * @param agentId The agent ID (file-path-based identifier, used when storeConfig is true)
 */
export function createStore(
  projectRoot: string,
  storeConfig: true | string,
  agentId: string
): Store {
  const storeName = storeConfig === true ? agentId : storeConfig;
  return new Store(projectRoot, storeName, agentId);
}
