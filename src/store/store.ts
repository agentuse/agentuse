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
  private agentName: string | undefined;
  private storeName: string;

  // A store lock is held only for the duration of a single read-modify-write
  // op (milliseconds), never across an agent run. So any lock older than this
  // is, by definition, abandoned - no op takes seconds. We steal a stale lock
  // even when its PID is still alive, which is the case that used to strand a
  // store forever: a session errors inside the long-lived `serve` worker, its
  // lock leaks, and the worker PID stays alive so the dead-PID check never
  // fires. Age, not PID liveness, is the load-bearing staleness signal.
  private static readonly STALE_LOCK_MS = 30_000;
  // When another *live, fresh* process holds the lock, retry briefly before
  // giving up - per-op holds clear in milliseconds, so a short wait wins.
  private static readonly ACQUIRE_RETRY_MS = 25;
  private static readonly ACQUIRE_MAX_WAIT_MS = 5_000;

  // Per-lockPath promise chain that serializes whole transactions in-process.
  // The serve worker handles execute/resume requests concurrently
  // (src/index.ts), so multiple Store instances in the same process can run
  // ops on the same store at once. Running each transaction inside this chain
  // means no two in-process read-modify-write cycles overlap, so the on-disk
  // lock only has to guard against *other* processes - and we need no ref
  // counting (the source of the old drift that stranded locks on disk).
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
   * Run a read-modify-write transaction under the store lock. The lock is held
   * only for this op: acquire -> read fresh from disk -> mutate -> atomic write
   * -> release. The whole body runs inside withLockChain so concurrent ops in
   * this process serialize (no lost update), and the on-disk lock guards
   * against other processes. `mutate` is synchronous and must throw before
   * returning to abort the write, leaving the store untouched.
   */
  private withWriteLock<T>(
    mutate: (items: StoreItem[]) => { items: StoreItem[]; result: T }
  ): Promise<T> {
    return Store.withLockChain(this.lockPath, async () => {
      await this.acquireFileLock();
      try {
        const items = await this.readItems();
        const { items: next, result } = mutate(items);
        await this.writeItems(next);
        return result;
      } finally {
        await this.releaseFileLock();
      }
    });
  }

  /**
   * Read the store file fresh from disk. Does not take the lock - atomic
   * writes (temp + rename) mean a reader always sees a whole prior or next
   * file, never a torn one, so reads can run lock-free.
   */
  private async readItems(): Promise<StoreItem[]> {
    if (!existsSync(this.storePath)) return [];
    try {
      const content = await readFile(this.storePath, 'utf-8');
      const data = JSON.parse(content);
      const validated = StoreFileSchema.parse(data);
      // Cast is safe because Zod schema matches our type structure
      return validated.items as StoreItem[];
    } catch (error) {
      // If file is corrupted, start fresh but log warning
      logger.warn(`[Store] Failed to load store from ${this.storePath}: ${(error as Error).message}`);
      return [];
    }
  }

  /**
   * Atomically write items to disk (temp file, then rename). Prevents
   * corruption if the process is killed mid-write. Caller must hold the lock.
   */
  private async writeItems(items: StoreItem[]): Promise<void> {
    const storeDir = dirname(this.storePath);
    if (!existsSync(storeDir)) {
      await mkdir(storeDir, { recursive: true });
    }

    const storeFile: StoreFile = { version: 1, items };
    const tempPath = `${this.storePath}.${randomBytes(4).toString('hex')}.tmp`;
    await writeFile(tempPath, JSON.stringify(storeFile, null, 2), 'utf-8');
    await rename(tempPath, this.storePath);
  }

  /**
   * Take the on-disk lock for this op. MUST run inside withLockChain so no
   * concurrent in-process acquire/release interleaves. Steals an abandoned
   * lock (own PID, corrupted, dead PID, or older than STALE_LOCK_MS), and
   * retries briefly when a live, fresh lock from another process blocks us.
   */
  private async acquireFileLock(): Promise<void> {
    const storeDir = dirname(this.lockPath);
    if (!existsSync(storeDir)) {
      await mkdir(storeDir, { recursive: true });
    }

    const deadline = Date.now() + Store.ACQUIRE_MAX_WAIT_MS;
    for (;;) {
      const blocker = await this.inspectLock();
      if (!blocker) {
        await this.writeLockFile();
        return;
      }
      if (Date.now() >= deadline) {
        throw new Error(
          `Store "${this.storeName}" is locked by another process.\n` +
          `  PID: ${blocker.pid}\n` +
          `  Agent: ${blocker.agent || 'unknown'}\n` +
          `  Locked: ${blocker.ageStr}\n` +
          `Wait for it to complete, or remove the lock file:\n` +
          `  rm "${this.lockPath}"`
        );
      }
      await new Promise<void>((resolve) => setTimeout(resolve, Store.ACQUIRE_RETRY_MS));
    }
  }

  /**
   * Inspect any on-disk lock. Returns null when we may take it (no file, our
   * own leftover, corrupted, stale-by-age, or dead PID), or details of a live,
   * fresh lock from another process that we must wait on.
   */
  private async inspectLock(): Promise<{ pid: number; agent?: string | undefined; ageStr: string } | null> {
    if (!existsSync(this.lockPath)) return null;

    let lockData: { pid?: number; agent?: string; timestamp?: string } | null;
    try {
      lockData = JSON.parse(await readFile(this.lockPath, 'utf-8'));
    } catch {
      logger.warn(`[Store] Removing corrupted lock file`);
      return null;
    }

    const pid = lockData?.pid;
    if (typeof pid !== 'number') {
      logger.warn(`[Store] Removing lock file with no PID`);
      return null;
    }

    // Our own leftover from a write killed mid-flight: reclaim it.
    if (pid === process.pid) return null;

    const ageMs = Date.now() - new Date(lockData?.timestamp ?? 0).getTime();

    // Age is the load-bearing signal: a lock older than a single op could
    // possibly take is abandoned, even if its PID still runs (the leaked-in-
    // worker case). An unparseable timestamp counts as infinitely old.
    if (!Number.isFinite(ageMs) || ageMs >= Store.STALE_LOCK_MS) {
      logger.warn(`[Store] Stealing stale lock from PID ${pid} (age ${Math.round(ageMs / 1000)}s)`);
      return null;
    }

    if (!isProcessRunning(pid)) {
      logger.warn(`[Store] Removing stale lock from dead PID ${pid}`);
      return null;
    }

    const ageStr = ageMs > 60000
      ? `${Math.round(ageMs / 60000)}m ago`
      : `${Math.round(ageMs / 1000)}s ago`;
    return { pid, agent: lockData?.agent, ageStr };
  }

  /**
   * Write our identity into the lock file.
   */
  private async writeLockFile(): Promise<void> {
    const lockData = {
      pid: process.pid,
      agent: this.agentName,
      timestamp: new Date().toISOString(),
    };
    await writeFile(this.lockPath, JSON.stringify(lockData, null, 2), 'utf-8');
  }

  /**
   * Remove the on-disk lock if we still own it. Best-effort.
   */
  private async releaseFileLock(): Promise<void> {
    try {
      if (!existsSync(this.lockPath)) return;
      const content = await readFile(this.lockPath, 'utf-8').catch(() => null);
      const lockData = content ? JSON.parse(content) : null;
      if (!lockData || lockData.pid === process.pid) {
        await unlink(this.lockPath).catch(() => {});
      }
    } catch {
      // Ignore errors when releasing the lock.
    }
  }

  /**
   * Defensive sweep, kept for callers that ran in the old run-scoped model
   * (preparation cleanup, run.ts, subagent). Per-op locking already releases
   * after every write, so by the time this runs no transaction is in flight;
   * it just clears any lock file this process leaked. Idempotent.
   */
  async releaseLock(): Promise<void> {
    await Store.withLockChain(this.lockPath, () => this.releaseFileLock());
  }

  /**
   * Create a new item in the store
   */
  async create(options: StoreCreateOptions): Promise<StoreItem> {
    const now = new Date().toISOString();
    // Validate the payload before taking the lock so a bad call fails fast
    // without any lock churn.
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

    return this.withWriteLock((items) => {
      items.push(item);
      return { items, result: item };
    });
  }

  /**
   * Get an item by ID
   */
  async get(id: string): Promise<StoreItem | null> {
    const items = await this.readItems();
    return items.find(item => item.id === id) || null;
  }

  /**
   * Update an item by ID
   */
  async update(id: string, options: StoreUpdateOptions): Promise<StoreItem | null> {
    // Validate before taking the lock; a rejected payload leaves the store
    // untouched (the mutate body never runs).
    const normalizedData = options.data !== undefined ? normalizeStoreData(options.data) : undefined;

    return this.withWriteLock((items) => {
      const index = items.findIndex(item => item.id === id);
      if (index === -1) return { items, result: null };

      const existing = items[index];
      const updated: StoreItem = {
        ...existing,
        updatedAt: new Date().toISOString(),
        ...(options.type !== undefined && { type: options.type }),
        ...(options.title !== undefined && { title: options.title }),
        ...(options.status !== undefined && { status: options.status }),
        ...(options.parentId !== undefined && { parentId: options.parentId }),
        ...(options.tags !== undefined && { tags: options.tags }),
        ...(normalizedData !== undefined && {
          data: { ...existing.data, ...normalizedData }
        }),
      };

      items[index] = updated;
      return { items, result: updated };
    });
  }

  /**
   * Delete an item by ID
   */
  async delete(id: string): Promise<boolean> {
    return this.withWriteLock((items) => {
      const index = items.findIndex(item => item.id === id);
      if (index === -1) return { items, result: false };

      items.splice(index, 1);
      return { items, result: true };
    });
  }

  /**
   * Apply filters and newest-first sorting (no pagination).
   */
  private filterAndSort(items: StoreItem[], options: StoreListOptions): StoreItem[] {
    let results = [...items];

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
    const items = await this.readItems();
    return this.paginate(this.filterAndSort(items, options), options);
  }

  /**
   * Query items with optional filtering, returning the requested page plus the
   * total number of items matching the filters (before limit/offset). Lets
   * callers paginate without re-fetching the whole store.
   */
  async query(options: StoreListOptions = {}): Promise<StoreQueryResult> {
    const items = await this.readItems();
    const filtered = this.filterAndSort(items, options);
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
