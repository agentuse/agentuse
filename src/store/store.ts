/**
 * Store class for persistent agent data storage
 */

import { readFile, writeFile, mkdir } from 'fs/promises';
import { existsSync } from 'fs';
import { join, dirname } from 'path';
import { ulid } from 'ulid';
import { StoreFileSchema } from './schema';
import type {
  StoreItem,
  StoreFile,
  StoreCreateOptions,
  StoreUpdateOptions,
  StoreListOptions,
} from './types';

/**
 * Store class that manages persistent data for agents
 */
export class Store {
  private storePath: string;
  private items: StoreItem[] = [];
  private loaded = false;
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
    this.storePath = join(projectRoot, '.agentuse', 'store', storeName, 'items.json');
    this.storeName = storeName;
    this.agentName = agentName;
  }

  /**
   * Ensure the store is loaded from disk
   */
  private async ensureLoaded(): Promise<void> {
    if (this.loaded) return;

    if (existsSync(this.storePath)) {
      try {
        const content = await readFile(this.storePath, 'utf-8');
        const data = JSON.parse(content);
        const validated = StoreFileSchema.parse(data);
        // Cast is safe because Zod schema matches our type structure
        this.items = validated.items as StoreItem[];
      } catch (error) {
        // If file is corrupted, start fresh but log warning
        console.warn(`[Store] Failed to load store from ${this.storePath}: ${(error as Error).message}`);
        this.items = [];
      }
    }

    this.loaded = true;
  }

  /**
   * Save the store to disk
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

    await writeFile(this.storePath, JSON.stringify(storeFile, null, 2), 'utf-8');
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
