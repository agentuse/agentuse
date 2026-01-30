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
} from './types';

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

    const storeDir = dirname(this.lockPath);

    // Ensure directory exists
    if (!existsSync(storeDir)) {
      await mkdir(storeDir, { recursive: true });
    }

    // Check for existing lock
    if (existsSync(this.lockPath)) {
      try {
        const lockContent = await readFile(this.lockPath, 'utf-8');
        const lockData = JSON.parse(lockContent);
        const { pid, agent, timestamp } = lockData;

        if (isProcessRunning(pid)) {
          // Lock is held by a running process
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
        }

        // Stale lock from dead process - we can steal it
        logger.warn(`[Store] Removing stale lock from PID ${pid}`);
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
  }

  /**
   * Release the lock on the store
   */
  async releaseLock(): Promise<void> {
    if (!this.locked) return;

    try {
      if (existsSync(this.lockPath)) {
        await unlink(this.lockPath);
      }
    } catch {
      // Ignore errors when releasing lock
    }
    this.locked = false;
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
      data: options.data,
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
        data: { ...existing.data, ...options.data }
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
   * List items with optional filtering
   */
  async list(options: StoreListOptions = {}): Promise<StoreItem[]> {
    await this.ensureLoaded();

    let results = [...this.items];

    // Apply filters
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

    // Sort by createdAt descending (newest first)
    results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));

    // Apply pagination
    if (options.offset) {
      results = results.slice(options.offset);
    }
    if (options.limit) {
      results = results.slice(0, options.limit);
    }

    return results;
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
 * @param agentName The agent name (used when storeConfig is true)
 */
export function createStore(
  projectRoot: string,
  storeConfig: true | string,
  agentName: string
): Store {
  const storeName = storeConfig === true ? agentName : storeConfig;
  return new Store(projectRoot, storeName, agentName);
}
