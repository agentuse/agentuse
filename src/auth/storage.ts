import fs from "fs/promises";
import path from "path";
import type { AuthInfo, OAuthTokens, CodexOAuthTokens, ApiKeyAuth, ProviderAuth, CustomProviderAuth } from "./types.js";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { getAgentuseDataDir } from "../utils/data-dir.js";
import { withOwnershipLock } from "../utils/ownership-lock.js";
import { logger } from "../utils/logger.js";
import type { PluginCredential } from "../plugin/types.js";

export function resolveAuthFilePath(): string {
  return path.join(getAgentuseDataDir(), "auth.json");
}

export class AuthStorage {
  private static readonly AUTH_FILE = resolveAuthFilePath();
  private static readonly LOCK_TIMEOUT_MS = 40_000;
  /**
   * Deadline for a callback running under the lock (a token refresh). The
   * ownership lock heartbeats while its holder is alive, so a hung refresh
   * would otherwise block every other worker forever. Kept below
   * LOCK_TIMEOUT_MS so waiters outlast one stuck holder.
   */
  private static readonly REFRESH_TIMEOUT_MS = 30_000;
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

  private static async writeAll(data: Record<string, AuthInfo>): Promise<void> {
    await this.ensureDir();
    await atomicWriteFile(this.AUTH_FILE, JSON.stringify(data, null, 2), { mode: 0o600 });
  }

  private static oauthCacheKey(providerID: string): string {
    return `${this.AUTH_FILE}\0${providerID}`;
  }

  /**
   * Strict read for anything that writes back. Only a missing file counts as
   * empty: an unreadable file, bad JSON, or a root that is not an object
   * throws, so a write never replaces credentials it failed to read.
   */
  private static async readAuthFile(): Promise<Record<string, AuthInfo>> {
    const file = this.AUTH_FILE;
    const unusable = (reason: string) => new Error(
      `Auth file ${file} ${reason}. It was left unchanged. Fix or move it aside, then run \`agentuse auth login\` again.`
    );
    let content: string;
    try {
      content = await fs.readFile(file, "utf-8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw unusable(`could not be read (${(error as Error).message})`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (error) {
      throw unusable(`is not valid JSON (${(error as Error).message})`);
    }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      throw unusable("does not contain a JSON object");
    }
    return parsed as Record<string, AuthInfo>;
  }

  private static lastReadWarning: string | undefined;

  /**
   * Read for status and lookups: a file that cannot be read reports as no
   * credentials (so status still renders), with one warning per distinct error.
   */
  private static async readAuthFileLenient(): Promise<Record<string, AuthInfo>> {
    try {
      return await this.readAuthFile();
    } catch (error) {
      const message = (error as Error).message;
      if (message !== this.lastReadWarning) {
        this.lastReadWarning = message;
        logger.warn(message);
      }
      return {};
    }
  }

  static async withAuthLock<T>(callback: () => Promise<T>): Promise<T> {
    await this.ensureDir();
    return withOwnershipLock(`${this.AUTH_FILE}.lock`, callback, {
      maxWaitMs: this.LOCK_TIMEOUT_MS,
      label: "auth",
    });
  }

  /**
   * The one read-modify-write path for auth.json: lock, strict read, apply
   * `callback` to the data in place, and write only if it changed. The callback
   * gets a deadline signal to pass to any network refresh it runs.
   */
  private static async transact<T>(
    callback: (data: Record<string, AuthInfo>, signal: AbortSignal) => Promise<T> | T
  ): Promise<T> {
    return this.withAuthLock(async () => {
      const data = await this.readAuthFile();
      const before = JSON.stringify(data);
      const result = await callback(data, AbortSignal.timeout(this.REFRESH_TIMEOUT_MS));
      if (JSON.stringify(data) !== before) {
        await this.writeAll(data);
        this.oauthCache.clear();
      }
      return result;
    });
  }

  private static oauthFrom(
    data: Record<string, AuthInfo>,
    providerID: string
  ): OAuthTokens | CodexOAuthTokens | undefined {
    const auth = data[`${providerID}:oauth`];
    if (auth && (auth.type === "oauth" || auth.type === "codex-oauth")) return auth;
    const legacy = data[providerID];
    if (legacy && (legacy.type === "oauth" || legacy.type === "codex-oauth")) return legacy;
    return undefined;
  }

  private static apiKeyFrom(data: Record<string, AuthInfo>, providerID: string): ApiKeyAuth | undefined {
    const auth = data[`${providerID}:api`];
    if (auth && auth.type === "api") return auth;
    const legacy = data[providerID];
    if (legacy && legacy.type === "api") return legacy;
    return undefined;
  }

  private static pluginCredentialFrom(data: Record<string, unknown>, key: string): PluginCredential | undefined {
    const value = data[key];
    return value && typeof value === "object" && !Array.isArray(value) ? value as PluginCredential : undefined;
  }

  /**
   * Run a provider-specific OAuth update while holding the shared auth-file lock.
   * The callback receives freshly re-read credentials so concurrent workers do not
   * all try to refresh the same rotating token, plus a deadline signal that any
   * refresh request must honour so a hung endpoint cannot hold the lock.
   */
  static async updateOAuth<T>(
    providerID: string,
    callback: (current: OAuthTokens | CodexOAuthTokens | undefined, signal: AbortSignal) => Promise<{
      value: T;
      next?: OAuthTokens | CodexOAuthTokens;
    }>
  ): Promise<T> {
    let written: OAuthTokens | CodexOAuthTokens | undefined;
    const value = await this.transact(async (data, signal) => {
      const { value, next } = await callback(this.oauthFrom(data, providerID), signal);
      if (next) {
        data[`${providerID}:oauth`] = next;
        const legacy = data[providerID];
        if (legacy && (legacy.type === "oauth" || legacy.type === "codex-oauth")) {
          delete data[providerID];
        }
        written = next;
      }
      return value;
    });
    if (written) this.oauthCache.set(this.oauthCacheKey(providerID), { readAt: Date.now(), value: written });
    return value;
  }

  /**
   * getOAuth for the hot path: the credentials are read on every provider
   * request, and re-reading auth.json each time is pure overhead when the token
   * is nowhere near expiry. Pass `refresh` to skip the cache and re-read, which
   * is what a caller does once its cached copy looks stale, before deciding it
   * needs the lock. Anything about to *write* reads inside the lock through
   * transact, where a stale read would be a correctness bug.
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
    return (await this.readAuthFileLenient())[providerID];
  }

  /**
   * Get OAuth tokens for a provider
   * Checks both new format ({provider}:oauth) and legacy format ({provider})
   */
  static async getOAuth(providerID: string): Promise<OAuthTokens | CodexOAuthTokens | undefined> {
    return this.oauthFrom(await this.readAuthFileLenient(), providerID);
  }

  /**
   * Get API key for a provider
   * Checks both new format ({provider}:api) and legacy format ({provider})
   */
  static async getApiKey(providerID: string): Promise<ApiKeyAuth | undefined> {
    return this.apiKeyFrom(await this.readAuthFileLenient(), providerID);
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
    return this.readAuthFileLenient();
  }

  /**
   * Set auth info (legacy format - stores under provider key)
   * Prefer using setOAuth/setApiKey for new code
   */
  static async set(providerID: string, info: AuthInfo): Promise<void> {
    await this.transact((data) => {
      data[providerID] = info;
    });
  }

  /**
   * Set OAuth tokens for a provider
   * Stores under {provider}:oauth key (does not overwrite API key)
   */
  static async setOAuth(providerID: string, info: OAuthTokens | CodexOAuthTokens): Promise<void> {
    await this.transact((data) => {
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
    await this.transact((data) => {
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
    await this.transact((data) => {
      delete data[providerID];
    });
  }

  /**
   * Remove OAuth tokens for a provider
   */
  static async removeOAuth(providerID: string): Promise<void> {
    await this.transact((data) => {
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
    await this.transact((data) => {
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
    return this.pluginCredentialFrom(await this.readAuthFileLenient(), this.pluginCredentialKey(providerID, methodID));
  }

  /**
   * Atomically move a legacy provider OAuth credential into a plugin-owned
   * method slot. An existing plugin credential always wins.
   */
  static async migrateOAuthToPluginCredential(
    providerID: string,
    methodID: string,
    sourceProviderID: string = providerID,
  ): Promise<PluginCredential | undefined> {
    return this.transact((authData) => {
      const data = authData as Record<string, unknown>;
      const destinationKey = this.pluginCredentialKey(providerID, methodID);
      const sourceKey = `${sourceProviderID}:oauth`;
      const dropLegacyOAuth = () => {
        const legacy = data[sourceProviderID];
        if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
          const legacyType = (legacy as { type?: unknown }).type;
          if (legacyType === "oauth" || legacyType === "codex-oauth") delete data[sourceProviderID];
        }
      };

      const destination = this.pluginCredentialFrom(data, destinationKey);
      if (destination) {
        delete data[sourceKey];
        dropLegacyOAuth();
        return destination;
      }

      const current = data[sourceKey] ?? data[sourceProviderID];
      if (!current || typeof current !== "object" || Array.isArray(current)) return undefined;
      const type = (current as { type?: unknown }).type;
      if (type !== "oauth" && type !== "codex-oauth") return undefined;

      const normalized = this.normalizePluginCredential(current as PluginCredential);
      data[destinationKey] = normalized;
      delete data[sourceKey];
      dropLegacyOAuth();
      return normalized;
    });
  }

  static async setPluginCredential(providerID: string, methodID: string, credential: PluginCredential): Promise<void> {
    const normalized = this.normalizePluginCredential(credential);
    await this.transact((data) => {
      data[this.pluginCredentialKey(providerID, methodID)] = normalized as AuthInfo;
    });
  }

  static async updatePluginCredential<T>(
    providerID: string,
    methodID: string,
    callback: (credential: PluginCredential | undefined, signal: AbortSignal) => Promise<{ value: T; next?: PluginCredential }>,
  ): Promise<T> {
    return this.transact(async (data, signal) => {
      const key = this.pluginCredentialKey(providerID, methodID);
      const { value, next } = await callback(this.pluginCredentialFrom(data, key), signal);
      if (next) data[key] = this.normalizePluginCredential(next) as AuthInfo;
      return value;
    });
  }

  static async removePluginCredential(providerID: string, methodID: string): Promise<void> {
    await this.transact((data) => {
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
    await this.transact((data) => {
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
    const entry = (await this.readAuthFileLenient())[`custom:${name}`];
    return entry && entry.type === "custom" ? entry : undefined;
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
    return this.transact((data) => {
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
