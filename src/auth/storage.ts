import fs from "fs/promises";
import path from "path";
import os from "os";
import type { AuthInfo, OAuthTokens, CodexOAuthTokens, ApiKeyAuth, ProviderAuth, CustomProviderAuth } from "./types.js";

export class AuthStorage {
  private static readonly AUTH_FILE = path.join(
    os.homedir(),
    ".local",
    "share",
    "agentuse",
    "auth.json"
  );
  private static readonly LOCK_TIMEOUT_MS = 30_000;
  private static readonly STALE_LOCK_MS = 5 * 60_000;

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
      }

      return value;
    });
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

  /**
   * Set a custom provider configuration
   * Stores under custom:<name> key
   */
  static async setCustomProvider(name: string, config: { baseURL: string; key?: string }): Promise<void> {
    await this.mutate((data) => {
      const entry: CustomProviderAuth = {
        type: "custom",
        baseURL: config.baseURL,
        ...(config.key && { key: config.key }),
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
