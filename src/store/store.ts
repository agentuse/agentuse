/**
 * Store class for persistent agent data storage
 */

import { readFile, mkdir, rename, open, stat } from 'fs/promises';
import { existsSync, lstatSync, cpSync, rmSync, readdirSync, statSync } from 'fs';
import { join, dirname, resolve, relative, isAbsolute } from 'path';
import { randomBytes } from 'crypto';
import { ulid } from 'ulid';
import { logger } from '../utils/logger';
import { withOwnershipLock } from '../utils/ownership-lock';
import { isMockMode } from '../runner/mock-tools';
import { StoreFileSchema, StoreItemSchema, isSafeStoreName } from './schema';
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

/** The string forms of an item that a free-text `q` search needs. */
export interface ItemSearchStrings {
  /** The stringified `data` payload. */
  json: string;
  /** Lowercased title, type, tags and `json` joined - what `q` scans. */
  haystack: string;
}

/**
 * Memoized per item: `JSON.stringify(item.data)` dominates the cost of a `q`
 * query, and it used to be paid twice per matching row (once building the
 * haystack here, once more building the match snippet in tools.ts). Items are
 * immutable once stored - every write builds a new object rather than mutating
 * one in place - so the strings stay valid for the item's lifetime, and a
 * WeakMap lets them go when the item does.
 */
const searchStringCache = new WeakMap<StoreItem, ItemSearchStrings>();

export function searchStrings(item: StoreItem): ItemSearchStrings {
  let cached = searchStringCache.get(item);
  if (!cached) {
    const json = JSON.stringify(item.data);
    const parts = [item.title, item.type, ...(item.tags ?? []), json];
    cached = { json, haystack: parts.filter(Boolean).join(' ').toLowerCase() };
    searchStringCache.set(item, cached);
  }
  return cached;
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
 * Mock-run store isolation. Stores are cross-run agent memory (dedup keys,
 * baselines, dashboard metrics), so a mock/test run writing to the REAL store
 * would contaminate production state even though the run itself is fabricated.
 * Under mock mode every Store in this process is rooted at a per-run scratch
 * base, `<projectRoot>/.agentuse/store-mock/<timestamp>-<pid>/`, seeded by
 * copying the real store dir on first use. Reads therefore see real state,
 * writes read back consistently, and nothing persists into the real store; the
 * scratch dir is left on disk for post-run inspection.
 *
 * One scratch base per process per project: a CLI run is one process, so this
 * is exactly per-run isolation there. (A long-lived worker running many mock
 * sessions would share one base across them, still fully isolated from the
 * real store.)
 */
const MOCK_STORE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const mockStoreBases = new Map<string, string>();

function mockStoreBase(projectRoot: string): string {
  const key = resolve(projectRoot);
  let base = mockStoreBases.get(key);
  if (!base) {
    const parent = resolve(key, '.agentuse', 'store-mock');
    // Best-effort sweep of scratch bases from old runs so they don't pile up.
    try {
      for (const entry of readdirSync(parent)) {
        const dir = join(parent, entry);
        if (Date.now() - statSync(dir).mtimeMs > MOCK_STORE_MAX_AGE_MS) {
          rmSync(dir, { recursive: true, force: true });
        }
      }
    } catch { /* parent may not exist yet */ }
    base = join(parent, `${Date.now()}-${process.pid}`);
    mockStoreBases.set(key, base);
    logger.info(`[Mock] stores isolated at ${base} (real store untouched)`);
  }
  return base;
}

function assertNoSymlinkPathSegments(projectRoot: string, storeName: string): void {
  let current = resolve(projectRoot);
  for (const segment of ['.agentuse', 'store', ...storeName.split('/')]) {
    current = join(current, segment);
    if (!existsSync(current)) continue;
    try {
      if (lstatSync(current).isSymbolicLink()) {
        throw new Error(`Invalid store path: ${current} is a symbolic link`);
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue;
      throw error;
    }
  }
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
 * Identity of the store file a cache entry was parsed from. Every write here
 * lands via temp file + rename, so a changed file always has a new inode, and
 * an in-place edit by anything else still moves mtime or size.
 */
interface FileIdentity {
  mtimeNs: bigint;
  size: bigint;
  ino: bigint;
}

interface StoreCacheEntry {
  identity: FileIdentity;
  items: StoreItem[];
}

/**
 * Parsed store files, keyed by store path.
 *
 * Every op reads the whole file, JSON.parses it and Zod-validates every item:
 * ~6ms on a 3.25MB/1290-item store, paid again on each of a run's N ops, and
 * paid in full by read-only ops that change nothing. The parse stays good for
 * as long as the file on disk is the one it came from, which a stat answers.
 *
 * Entries hold the parsed array itself and `readItems` hands out a shallow
 * copy. Items are shared, not copied: no code path mutates a stored item in
 * place (create/update/upsert build a fresh object via spread), so sharing
 * them is safe and keeps the copy O(n) pointers instead of a deep clone. The
 * *array* is copied because the write path does mutate it - create pushes,
 * delete splices - and an aborted write must not leave those edits in the
 * cache.
 *
 * Bounded so a long-lived `serve` worker touching many projects' stores does
 * not hold every one of them resident; entries are evicted least-recently-used.
 */
const MAX_CACHED_STORES = 16;
const parsedStoreCache = new Map<string, StoreCacheEntry>();

function cacheGet(path: string): StoreCacheEntry | undefined {
  const entry = parsedStoreCache.get(path);
  if (!entry) return undefined;
  // Re-insert so the most recently used entry sorts last for eviction.
  parsedStoreCache.delete(path);
  parsedStoreCache.set(path, entry);
  return entry;
}

function cacheSet(path: string, entry: StoreCacheEntry): void {
  parsedStoreCache.delete(path);
  parsedStoreCache.set(path, entry);
  if (parsedStoreCache.size > MAX_CACHED_STORES) {
    const oldest = parsedStoreCache.keys().next();
    if (!oldest.done) parsedStoreCache.delete(oldest.value);
  }
}

/**
 * Identify the store file, or null when it does not exist yet. Any other stat
 * failure throws: treating an unreadable file as "no file" would let a write
 * transaction persist `[]` over a healthy store.
 */
async function fileIdentity(path: string): Promise<FileIdentity | null> {
  try {
    const stats = await stat(path, { bigint: true });
    return { mtimeNs: stats.mtimeNs, size: stats.size, ino: stats.ino };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw new Error(`[Store] Failed to stat store at ${path}: ${(error as Error).message}`);
  }
}

function sameFile(a: FileIdentity, b: FileIdentity): boolean {
  return a.mtimeNs === b.mtimeNs && a.size === b.size && a.ino === b.ino;
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
    if (!isSafeStoreName(storeName)) {
      throw new Error(`Invalid store name: ${storeName}`);
    }
    const storeRoot = resolve(projectRoot, '.agentuse', 'store');
    let storeDir = resolve(storeRoot, storeName);
    const relativeStoreDir = relative(storeRoot, storeDir);
    if (relativeStoreDir.startsWith('..') || isAbsolute(relativeStoreDir)) {
      throw new Error(`Invalid store name: ${storeName}`);
    }
    assertNoSymlinkPathSegments(projectRoot, storeName);
    // Mock-run isolation: re-root at the per-run scratch base, seeded from the
    // real store dir so reads ground in real state while writes never touch it.
    // Validation above ran against the REAL path first, so a hostile storeName
    // cannot use the mock swap to escape containment.
    if (isMockMode()) {
      const realStoreDir = storeDir;
      storeDir = join(mockStoreBase(projectRoot), storeName);
      if (!existsSync(storeDir) && existsSync(realStoreDir)) {
        cpSync(realStoreDir, storeDir, { recursive: true });
        rmSync(join(storeDir, 'lock'), { force: true });
      }
    }
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
   *
   * `changed` names the items this op introduced or rewrote. Only those are
   * schema-checked before the write: every other item in the array already
   * passed validation on the read that produced it, so re-validating the whole
   * store on each op is O(n) work for no extra guarantee.
   */
  private withWriteLock<T>(
    mutate: (items: StoreItem[]) => { items: StoreItem[]; result: T; changed?: StoreItem[] }
  ): Promise<T> {
    return Store.withLockChain(this.lockPath, () =>
      withOwnershipLock(this.lockPath, async () => {
        const items = await this.readItems();
        const { items: next, result, changed } = mutate(items);
        for (const item of changed ?? []) {
          const parsed = StoreItemSchema.safeParse(item);
          if (!parsed.success) {
            throw new Error(
              `[Store] Refusing to write an invalid item to ${this.storePath}: ${parsed.error.message}`
            );
          }
        }
        await this.writeItems(next);
        return result;
      }, {
        staleMs: Store.STALE_LOCK_MS,
        retryMs: Store.ACQUIRE_RETRY_MS,
        maxWaitMs: Store.ACQUIRE_MAX_WAIT_MS,
        label: this.agentName ?? this.storeName,
      })
    );
  }

  /**
   * Read the store file. Does not take the lock - atomic writes (temp +
   * rename) mean a reader always sees a whole prior or next file, never a torn
   * one, so reads can run lock-free.
   *
   * Served from the in-process parse cache when the file on disk is still the
   * one that was parsed. The file is identified *before* the read: pairing the
   * content with an identity taken afterwards could tag stale content as
   * current if a writer landed in between, whereas an identity taken first can
   * only ever cost an extra re-read.
   */
  private async readItems(): Promise<StoreItem[]> {
    const identity = await fileIdentity(this.storePath);
    if (!identity) {
      parsedStoreCache.delete(this.storePath);
      return [];
    }
    const cached = cacheGet(this.storePath);
    if (cached && sameFile(cached.identity, identity)) return cached.items.slice();

    let content: string;
    try {
      content = await readFile(this.storePath, 'utf-8');
    } catch (error) {
      // A transient read failure (EMFILE/EIO/etc.) must NOT be mistaken for an
      // empty store: mutate() would then write [] over a healthy file, wiping
      // it. Surface the error so the enclosing write transaction aborts.
      throw new Error(
        `[Store] Failed to read store from ${this.storePath}: ${(error as Error).message}`
      );
    }
    try {
      const data = JSON.parse(content);
      // Full-file validation runs here and only here: this is the one point
      // where content of unknown provenance enters the process. Items handed
      // back from the cache were validated on the read that filled it, and
      // items added by a write are validated individually in withWriteLock.
      const validated = StoreFileSchema.parse(data);
      // Cast is safe because Zod schema matches our type structure
      const items = validated.items as StoreItem[];
      cacheSet(this.storePath, { identity, items });
      return items.slice();
    } catch (error) {
      // Corrupt/truncated content is also not an empty store. Refuse rather
      // than overwrite whatever is on disk with [].
      logger.warn(`[Store] Store file is unreadable at ${this.storePath}: ${(error as Error).message}`);
      throw new Error(
        `[Store] Refusing to operate on a corrupt store at ${this.storePath}: ${(error as Error).message}`
      );
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
    // fsync the temp file before rename so a crash can't surface a truncated
    // target (which readItems would then refuse to operate on).
    const fh = await open(tempPath, 'w');
    try {
      await fh.writeFile(JSON.stringify(storeFile, null, 2), 'utf-8');
      await fh.sync();
    } finally {
      await fh.close();
    }
    await rename(tempPath, this.storePath);

    // We know exactly what the file now holds, so seed the cache instead of
    // making the next op re-read and re-validate it. Still inside the lock, so
    // no other process can have replaced the file before this stat.
    const identity = await fileIdentity(this.storePath);
    if (identity) cacheSet(this.storePath, { identity, items: items.slice() });
    else parsedStoreCache.delete(this.storePath);
  }

  /**
   * Defensive sweep, kept for callers that ran in the old run-scoped model
   * (preparation cleanup, run.ts, subagent). Per-op ownership locks always
   * release in finally, so there is nothing safe to remove here: deleting a
   * path without its owner token could destroy another process's replacement.
   */
  async releaseLock(): Promise<void> {
    await Store.withLockChain(this.lockPath, async () => undefined);
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
      return { items, result: item, changed: [item] };
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
      return { items, result: updated, changed: [updated] };
    });
  }

  /**
   * Create-or-update keyed on exact-match `where` filters against item data,
   * as a single locked transaction (a separate query-then-write pair would let
   * a concurrent writer create a duplicate between the two ops). When multiple
   * items match, the newest one is updated. Update semantics mirror update():
   * provided fields replace, `data` merges into the existing payload.
   */
  async upsertWhere(
    where: Record<string, string | number | boolean>,
    options: StoreCreateOptions,
    behavior: { replaceData?: boolean } = {}
  ): Promise<{ item: StoreItem; created: boolean }> {
    const now = new Date().toISOString();
    const normalizedData = normalizeStoreData(options.data);
    const entries = Object.entries(where);

    return this.withWriteLock<{ item: StoreItem; created: boolean }>((items) => {
      let index = -1;
      for (let i = 0; i < items.length; i++) {
        const candidate = items[i]!;
        if (!entries.every(([key, value]) => looseEquals(candidate.data[key], value))) continue;
        if (index === -1 || candidate.createdAt.localeCompare(items[index]!.createdAt) > 0) index = i;
      }

      if (index === -1) {
        const item: StoreItem = {
          id: ulid(),
          createdAt: now,
          updatedAt: now,
          data: normalizedData,
          ...(options.type && { type: options.type }),
          ...(options.title && { title: options.title }),
          ...(options.status && { status: options.status }),
          ...(options.parentId && { parentId: options.parentId }),
          ...(options.tags && { tags: options.tags }),
          ...(this.agentName && { createdBy: this.agentName }),
        };
        items.push(item);
        return { items, result: { item, created: true }, changed: [item] };
      }

      const existing = items[index]!;
      const updated: StoreItem = {
        ...existing,
        updatedAt: now,
        ...(options.type !== undefined && { type: options.type }),
        ...(options.title !== undefined && { title: options.title }),
        ...(options.status !== undefined && { status: options.status }),
        ...(options.parentId !== undefined && { parentId: options.parentId }),
        ...(options.tags !== undefined && { tags: options.tags }),
        data: behavior.replaceData
          ? normalizedData
          : { ...existing.data, ...normalizedData },
      };
      items[index] = updated;
      return { items, result: { item: updated, created: false }, changed: [updated] };
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
      results = results.filter(item => searchStrings(item).haystack.includes(needle));
    }
    if (options.since) {
      // Both sides are ISO-8601 UTC, so lexicographic order is chronological.
      const since = options.since;
      results = results.filter(item => item.createdAt >= since);
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
