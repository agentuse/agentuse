import fs from "fs/promises";
import path from "path";
import type {
  OAuthAuthorizationServerInformation,
  OAuthClientInformation,
  OAuthTokens,
} from "@ai-sdk/mcp";
import { atomicWriteFile } from "../utils/atomic-write.js";
import { getAgentuseDataDir } from "../utils/data-dir.js";
import { withOwnershipLock } from "../utils/ownership-lock.js";

/** A login the user started but has not finished in the browser yet. */
export interface PendingMCPLogin {
  redirectUrl: string;
  codeVerifier: string;
  authorizationServer?: OAuthAuthorizationServerInformation;
  /** The client this login was started with, so a concurrent login that
   *  registers another client cannot swap it out before the callback. */
  clientInformation?: OAuthClientInformation;
  createdAt: number;
}

/** The finished login every agent using this server URL shares. */
export interface MCPLogin {
  clientInformation: OAuthClientInformation;
  tokens: OAuthTokens;
  savedAt: number;
}

export interface MCPServerAuthRecord {
  /** Dynamic registrations, one per redirect URI (CLI loopback vs serve origin). */
  clients?: Record<string, OAuthClientInformation>;
  login?: MCPLogin;
  /** Keyed by OAuth `state`, so the callback can only finish a login we started. */
  pending?: Record<string, PendingMCPLogin>;
}

type MCPAuthFile = Record<string, MCPServerAuthRecord>;

/** An abandoned browser login stops being redeemable after this long. */
const PENDING_LOGIN_TTL_MS = 15 * 60 * 1000;
const LOCK_TIMEOUT_MS = 10_000;

export function resolveMCPAuthFilePath(): string {
  return path.join(getAgentuseDataDir(), "mcp-auth.json");
}

/** Logins are shared by server URL, so normalize it the same way everywhere. */
export function mcpServerKey(url: string): string {
  return new URL(url).href;
}

async function readFile(file: string): Promise<MCPAuthFile> {
  let content: string;
  try {
    content = await fs.readFile(file, "utf-8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw new Error(`MCP auth file ${file} could not be read (${(error as Error).message})`);
  }
  const parsed: unknown = JSON.parse(content);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`MCP auth file ${file} does not contain a JSON object. Fix or move it aside, then log in again.`);
  }
  return parsed as MCPAuthFile;
}

export const MCPAuthStorage = {
  async get(url: string): Promise<MCPServerAuthRecord> {
    const data = await readFile(resolveMCPAuthFilePath());
    return data[mcpServerKey(url)] ?? {};
  },

  /** Lock, read, change one server's record in place, write if it changed. */
  async update<T>(url: string, change: (record: MCPServerAuthRecord) => T): Promise<T> {
    const file = resolveMCPAuthFilePath();
    await fs.mkdir(path.dirname(file), { recursive: true });
    return withOwnershipLock(`${file}.lock`, async () => {
      const data = await readFile(file);
      const key = mcpServerKey(url);
      const record = data[key] ?? {};
      const before = JSON.stringify(record);
      const result = change(record);
      if (record.pending) {
        const cutoff = Date.now() - PENDING_LOGIN_TTL_MS;
        for (const [state, pending] of Object.entries(record.pending)) {
          if (pending.createdAt < cutoff) delete record.pending[state];
        }
        if (Object.keys(record.pending).length === 0) delete record.pending;
      }
      if (JSON.stringify(record) !== before) {
        if (Object.keys(record).length === 0) delete data[key];
        else data[key] = record;
        await atomicWriteFile(file, JSON.stringify(data, null, 2), { mode: 0o600 });
      }
      return result;
    }, { maxWaitMs: LOCK_TIMEOUT_MS, label: "mcp-auth" });
  },

  /** Forget the login and the client registrations, so the next login
   *  registers afresh instead of reusing a client the server may have dropped. */
  async logout(url: string): Promise<boolean> {
    return this.update(url, (record) => {
      const had = record.login !== undefined;
      delete record.login;
      delete record.clients;
      return had;
    });
  },
};
