import fs from "fs/promises";
import path from "path";
import os from "os";
import type { AuthInfo, OAuthTokens, CodexOAuthTokens, ApiKeyAuth, ProviderAuth } from "./types.js";

export class AuthStorage {
  private static readonly AUTH_FILE = path.join(
    os.homedir(),
    ".local",
    "share",
    "agentuse",
    "auth.json"
  );

  private static async ensureDir() {
    const dir = path.dirname(this.AUTH_FILE);
    await fs.mkdir(dir, { recursive: true });
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
    await this.ensureDir();
    const data = await this.all();
    data[providerID] = info;
    await fs.writeFile(this.AUTH_FILE, JSON.stringify(data, null, 2));
    // Set file permissions to user read/write only
    await fs.chmod(this.AUTH_FILE, 0o600);
  }

  /**
   * Set OAuth tokens for a provider
   * Stores under {provider}:oauth key (does not overwrite API key)
   */
  static async setOAuth(providerID: string, info: OAuthTokens | CodexOAuthTokens): Promise<void> {
    await this.ensureDir();
    const data = await this.all();

    // Store in new format
    data[`${providerID}:oauth`] = info;

    // Clean up legacy format if it was OAuth (migrate to new format)
    const legacy = data[providerID];
    if (legacy && (legacy.type === "oauth" || legacy.type === "codex-oauth")) {
      delete data[providerID];
    }

    await fs.writeFile(this.AUTH_FILE, JSON.stringify(data, null, 2));
    await fs.chmod(this.AUTH_FILE, 0o600);
  }

  /**
   * Set API key for a provider
   * Stores under {provider}:api key (does not overwrite OAuth)
   */
  static async setApiKey(providerID: string, info: ApiKeyAuth): Promise<void> {
    await this.ensureDir();
    const data = await this.all();

    // Store in new format
    data[`${providerID}:api`] = info;

    // Clean up legacy format if it was API key (migrate to new format)
    const legacy = data[providerID];
    if (legacy && legacy.type === "api") {
      delete data[providerID];
    }

    await fs.writeFile(this.AUTH_FILE, JSON.stringify(data, null, 2));
    await fs.chmod(this.AUTH_FILE, 0o600);
  }

  static async remove(providerID: string): Promise<void> {
    const data = await this.all();
    delete data[providerID];
    await this.ensureDir();
    await fs.writeFile(this.AUTH_FILE, JSON.stringify(data, null, 2));
  }

  /**
   * Remove OAuth tokens for a provider
   */
  static async removeOAuth(providerID: string): Promise<void> {
    const data = await this.all();
    delete data[`${providerID}:oauth`];

    // Also remove legacy format if it was OAuth
    const legacy = data[providerID];
    if (legacy && (legacy.type === "oauth" || legacy.type === "codex-oauth")) {
      delete data[providerID];
    }

    await this.ensureDir();
    await fs.writeFile(this.AUTH_FILE, JSON.stringify(data, null, 2));
  }

  /**
   * Remove API key for a provider
   */
  static async removeApiKey(providerID: string): Promise<void> {
    const data = await this.all();
    delete data[`${providerID}:api`];

    // Also remove legacy format if it was API key
    const legacy = data[providerID];
    if (legacy && legacy.type === "api") {
      delete data[providerID];
    }

    await this.ensureDir();
    await fs.writeFile(this.AUTH_FILE, JSON.stringify(data, null, 2));
  }

  static getFilePath(): string {
    return this.AUTH_FILE;
  }
}