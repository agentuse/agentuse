import fs from "fs/promises";
import path from "path";
import type { AuthInfo, OAuthTokens, CodexOAuthTokens, ApiKeyAuth, ProviderAuth, CustomProviderAuth } from "./types.js";
import { getAgentuseDataDir } from "../utils/data-dir.js";
import type { PluginCredential } from "../plugin/types.js";

export function resolveAuthFilePath(): string {
  return path.join(getAgentuseDataDir(), "auth.json");
}

export class AuthStorage {
  private static readonly AUTH_FILE = resolveAuthFilePath();
  private static readonly LOCK_TIMEOUT_MS = 30_000;
  private static readonly STALE_LOCK_MS = 5 * 60_000;
  private static readonly OAUTH_CACHE_TTL_MS = 1_000;

  /**
   * Last credentials read per provider. The provider fetch wrappers ask for an
   * access token on every HTTP request, so without this each request re-reads
   * auth.json. Writes made here refresh the entry outright; the TTL is what
   * makes a refresh or a logout performed by another process visible.
   * Keyed by file path too, so pointing AUTH_FILE elsewhere starts clean.
   */
  private static oauthCache = new Map<
    string,
    { readAt: number; value: OAuthTokens | CodexOAuthTokens | undefined }
  >();

  private static async ensureDir() {
    const dir = path.dirname(this.AUTH_FILE);
    await fs.mkdir(dir, { recursive: true });
  }

  private static async sleep(ms: number) {
    await new Promise((resolve) => setTimeout(resolve, ms));
  }

  private static async writeAll(data: Record<string, AuthInfo>): Promise<void> {
    await this.ensureDir();
    const dir = path.dirname(this.AUTH_FILE);
    const tmpFile = path.join(
      dir,
      `.auth.json.${process.pid}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`
    );

    try {
      await fs.writeFile(tmpFile, JSON.stringify(data, null, 2));
      await fs.chmod(tmpFile, 0o600);
      await fs.rename(tmpFile, this.AUTH_FILE);
    } catch (error) {
      await fs.rm(tmpFile, { force: true }).catch(() => {});
      throw error;
    }
  }

  private static lockDir(): string {
    return `${this.AUTH_FILE}.lock`;
  }

  private static oauthCacheKey(providerID: string): string {
    return `${this.AUTH_FILE}\0${providerID}`;
  }

  static async withAuthLock<T>(callback: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    const lockDir = this.lockDir();
    const startedAt = Date.now();

    while (true) {
      try {
        await fs.mkdir(lockDir);
        break;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") {
          throw error;
        }

        try {
          const stat = await fs.stat(lockDir);
          if (Date.now() - stat.mtimeMs > this.STALE_LOCK_MS) {
            await fs.rm(lockDir, { recursive: true, force: true });
            continue;
          }
        } catch {
          continue;
        }

        if (Date.now() - startedAt > this.LOCK_TIMEOUT_MS) {
          throw new Error(`Timed out waiting for auth storage lock: ${lockDir}`);
        }

        await this.sleep(50 + Math.floor(Math.random() * 50));
      }
    }

    try {
      return await callback();
    } finally {
      await fs.rm(lockDir, { recursive: true, force: true }).catch(() => {});
    }
  }

  private static async mutate<T>(callback: (data: Record<string, AuthInfo>) => Promise<T> | T): Promise<T> {
    return this.withAuthLock(async () => {
      const data = await this.all();
      const result = await callback(data);
      await this.writeAll(data);
      this.oauthCache.clear();
      return result;
    });
  }

  /**
   * Run a provider-specific OAuth update while holding the shared auth-file lock.
   * The callback receives freshly re-read credentials so concurrent workers do not
   * all try to refresh the same rotating token.
   */
  static async updateOAuth<T>(
    providerID: string,
    callback: (current: OAuthTokens | CodexOAuthTokens | undefined) => Promise<{
      value: T;
      next?: OAuthTokens | CodexOAuthTokens;
    }>
  ): Promise<T> {
    return this.withAuthLock(async () => {
      const current = await this.getOAuth(providerID);
      const { value, next } = await callback(current);

      if (next) {
        const data = await this.all();
        data[`${providerID}:oauth`] = next;

        const legacy = data[providerID];
        if (legacy && (legacy.type === "oauth" || legacy.type === "codex-oauth")) {
          delete data[providerID];
        }

        await this.writeAll(data);
        this.oauthCache.set(this.oauthCacheKey(providerID), { readAt: Date.now(), value: next });
      }

      return value;
    });
  }

  /**
   * getOAuth for the hot path: the credentials are read on every provider
   * request, and re-reading auth.json each time is pure overhead when the token
   * is nowhere near expiry. Pass `refresh` to skip the cache and re-read, which
   * is what a caller does once its cached copy looks stale, before deciding it
   * needs the lock. Anything about to *write* keeps using getOAuth inside
   * withAuthLock, where a stale read would be a correctness bug.
   */
  static async getOAuthCached(
    providerID: string,
    options?: { refresh?: boolean }
  ): Promise<OAuthTokens | CodexOAuthTokens | undefined> {
    const key = this.oauthCacheKey(providerID);

    if (!options?.refresh) {
      const hit = this.oauthCache.get(key);
      if (hit && Date.now() - hit.readAt < this.OAUTH_CACHE_TTL_MS) {
        return hit.value;
      }
    }

    const value = await this.getOAuth(providerID);
    this.oauthCache.set(key, { readAt: Date.now(), value });
    return value;
  }

  /**
   * Get raw auth info for a provider (legacy single-value format)
   * Prefer using getOAuth/getApiKey for new code
   */
  static async get(providerID: string): Promise<AuthInfo | undefined> {
    try {
      const content = await fs.readFile(this.AUTH_FILE, "utf-8");
      const data = JSON.parse(content);
      return data[providerID] as AuthInfo | undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get OAuth tokens for a provider
   * Checks both new format ({provider}:oauth) and legacy format ({provider})
   */
  static async getOAuth(providerID: string): Promise<OAuthTokens | CodexOAuthTokens | undefined> {
    try {
      const content = await fs.readFile(this.AUTH_FILE, "utf-8");
      const data = JSON.parse(content);

      // Check new format first
      const oauthKey = `${providerID}:oauth`;
      if (data[oauthKey]) {
        const auth = data[oauthKey] as AuthInfo;
        if (auth.type === "oauth" || auth.type === "codex-oauth") {
          return auth;
        }
      }

      // Fall back to legacy format
      const legacy = data[providerID] as AuthInfo | undefined;
      if (legacy && (legacy.type === "oauth" || legacy.type === "codex-oauth")) {
        return legacy;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get API key for a provider
   * Checks both new format ({provider}:api) and legacy format ({provider})
   */
  static async getApiKey(providerID: string): Promise<ApiKeyAuth | undefined> {
    try {
      const content = await fs.readFile(this.AUTH_FILE, "utf-8");
      const data = JSON.parse(content);

      // Check new format first
      const apiKey = `${providerID}:api`;
      if (data[apiKey]) {
        const auth = data[apiKey] as AuthInfo;
        if (auth.type === "api") {
          return auth;
        }
      }

      // Fall back to legacy format
      const legacy = data[providerID] as AuthInfo | undefined;
      if (legacy && legacy.type === "api") {
        return legacy;
      }

      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get all auth methods for a provider (both OAuth and API key)
   */
  static async getProviderAuth(providerID: string): Promise<ProviderAuth> {
    const result: ProviderAuth = {};

    const oauth = await this.getOAuth(providerID);
    if (oauth) {
      result.oauth = oauth;
    }

    const api = await this.getApiKey(providerID);
    if (api) {
      result.api = api;
    }

    return result;
  }

  static async all(): Promise<Record<string, AuthInfo>> {
    try {
      const content = await fs.readFile(this.AUTH_FILE, "utf-8");
      return JSON.parse(content);
    } catch {
      return {};
    }
  }

  /**
   * Set auth info (legacy format - stores under provider key)
   * Prefer using setOAuth/setApiKey for new code
   */
  static async set(providerID: string, info: AuthInfo): Promise<void> {
    await this.mutate((data) => {
      data[providerID] = info;
    });
  }

  /**
   * Set OAuth tokens for a provider
   * Stores under {provider}:oauth key (does not overwrite API key)
   */
  static async setOAuth(providerID: string, info: OAuthTokens | CodexOAuthTokens): Promise<void> {
    await this.mutate((data) => {
      // Store in new format
      data[`${providerID}:oauth`] = info;

      // Clean up legacy format if it was OAuth (migrate to new format)
      const legacy = data[providerID];
      if (legacy && (legacy.type === "oauth" || legacy.type === "codex-oauth")) {
        delete data[providerID];
      }
    });
  }

  /**
   * Set API key for a provider
   * Stores under {provider}:api key (does not overwrite OAuth)
   */
  static async setApiKey(providerID: string, info: ApiKeyAuth): Promise<void> {
    await this.mutate((data) => {
      // Store in new format
      data[`${providerID}:api`] = info;

      // Clean up legacy format if it was API key (migrate to new format)
      const legacy = data[providerID];
      if (legacy && legacy.type === "api") {
        delete data[providerID];
      }
    });
  }

  static async remove(providerID: string): Promise<void> {
    await this.mutate((data) => {
      delete data[providerID];
    });
  }

  /**
   * Remove OAuth tokens for a provider
   */
  static async removeOAuth(providerID: string): Promise<void> {
    await this.mutate((data) => {
      delete data[`${providerID}:oauth`];

      // Also remove legacy format if it was OAuth
      const legacy = data[providerID];
      if (legacy && (legacy.type === "oauth" || legacy.type === "codex-oauth")) {
        delete data[providerID];
      }
    });
  }

  /**
   * Remove API key for a provider
   */
  static async removeApiKey(providerID: string): Promise<void> {
    await this.mutate((data) => {
      delete data[`${providerID}:api`];

      // Also remove legacy format if it was API key
      const legacy = data[providerID];
      if (legacy && legacy.type === "api") {
        delete data[providerID];
      }
    });
  }

  private static pluginCredentialKey(providerID: string, methodID: string): string {
    return `${providerID}:plugin:${methodID}`;
  }

  private static normalizePluginCredential(credential: PluginCredential): PluginCredential {
    const serialized = JSON.stringify(credential);
    if (serialized === undefined) throw new Error("Plugin credential must be JSON-serializable");
    const normalized = JSON.parse(serialized) as unknown;
    if (!normalized || typeof normalized !== "object" || Array.isArray(normalized)) {
      throw new Error("Plugin credential must be a JSON object");
    }
    return normalized as PluginCredential;
  }

  /** Opaque credentials owned by a provider auth method, persisted by core. */
  static async getPluginCredential(providerID: string, methodID: string): Promise<PluginCredential | undefined> {
    try {
      const content = await fs.readFile(this.AUTH_FILE, "utf-8");
      const data = JSON.parse(content) as Record<string, unknown>;
      const value = data[this.pluginCredentialKey(providerID, methodID)];
      return value && typeof value === "object" && !Array.isArray(value)
        ? value as PluginCredential
        : undefined;
    } catch {
      return undefined;
    }
  }

  static async setPluginCredential(providerID: string, methodID: string, credential: PluginCredential): Promise<void> {
    const normalized = this.normalizePluginCredential(credential);
    await this.mutate((data) => {
      data[this.pluginCredentialKey(providerID, methodID)] = normalized as AuthInfo;
    });
  }

  static async updatePluginCredential<T>(
    providerID: string,
    methodID: string,
    callback: (credential: PluginCredential | undefined) => Promise<{ value: T; next?: PluginCredential }>,
  ): Promise<T> {
    return this.withAuthLock(async () => {
      const data = await this.all() as Record<string, unknown>;
      const key = this.pluginCredentialKey(providerID, methodID);
      const raw = data[key];
      const current = raw && typeof raw === "object" && !Array.isArray(raw) ? raw as PluginCredential : undefined;
      const { value, next } = await callback(current);
      if (next) {
        data[key] = this.normalizePluginCredential(next);
        await this.writeAll(data as Record<string, AuthInfo>);
      }
      return value;
    });
  }

  static async removePluginCredential(providerID: string, methodID: string): Promise<void> {
    await this.mutate((data) => {
      delete data[this.pluginCredentialKey(providerID, methodID)];
    });
  }

  /**
   * Set a custom provider configuration
   * Stores under custom:<name> key
   */
  static async setCustomProvider(
    name: string,
    config: Omit<CustomProviderAuth, "type">
  ): Promise<void> {
    await this.mutate((data) => {
      const entry: CustomProviderAuth = {
        type: "custom",
        baseURL: config.baseURL,
        ...(config.api && { api: config.api }),
        ...(config.key && { key: config.key }),
        ...(config.models && { models: config.models }),
        ...(config.compatibility && { compatibility: config.compatibility }),
      };
      data[`custom:${name}`] = entry;
    });
  }

  /**
   * Get a custom provider configuration by name
   */
  static async getCustomProvider(name: string): Promise<CustomProviderAuth | undefined> {
    try {
      const content = await fs.readFile(this.AUTH_FILE, "utf-8");
      const data = JSON.parse(content);
      const entry = data[`custom:${name}`];
      if (entry && entry.type === "custom") {
        return entry as CustomProviderAuth;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  /**
   * Get all custom providers
   * Returns a map of name -> CustomProviderAuth
   */
  static async getCustomProviders(): Promise<Record<string, CustomProviderAuth>> {
    const data = await this.all();
    const result: Record<string, CustomProviderAuth> = {};
    for (const [key, value] of Object.entries(data)) {
      if (key.startsWith("custom:") && value.type === "custom") {
        const name = key.slice("custom:".length);
        result[name] = value as CustomProviderAuth;
      }
    }
    return result;
  }

  /**
   * Remove a custom provider configuration
   */
  static async removeCustomProvider(name: string): Promise<boolean> {
    return this.mutate((data) => {
      const key = `custom:${name}`;
      if (!(key in data)) {
        return false;
      }
      delete data[key];
      return true;
    });
  }

  static getFilePath(): string {
    return this.AUTH_FILE;
  }
}
