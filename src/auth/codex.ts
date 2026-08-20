import { AuthStorage } from "./storage.js";
import type { CodexOAuthTokens, OAuthTokens } from "./types.js";

const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
const ISSUER = "https://auth.openai.com";
const REDIRECT_URI = "http://localhost:1455/auth/callback";
const REFRESH_BUFFER_MS = 5 * 60 * 1000;

interface PkceCodes {
  verifier: string;
  challenge: string;
}

async function generatePKCE(): Promise<PkceCodes> {
  const verifier = generateRandomString(43);
  const encoder = new TextEncoder();
  const data = encoder.encode(verifier);
  const hash = await crypto.subtle.digest("SHA-256", data);
  const challenge = base64UrlEncode(hash);
  return { verifier, challenge };
}

function generateRandomString(length: number): string {
  const chars = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~";
  const bytes = crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes)
    .map((b) => chars[b % chars.length])
    .join("");
}

function base64UrlEncode(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  const binary = String.fromCharCode(...bytes);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export interface IdTokenClaims {
  chatgpt_account_id?: string;
  organizations?: Array<{ id: string }>;
  email?: string;
  "https://api.openai.com/auth"?: {
    chatgpt_account_id?: string;
  };
}

export function parseJwtClaims(token: string): IdTokenClaims | undefined {
  const parts = token.split(".");
  if (parts.length !== 3) return undefined;
  try {
    return JSON.parse(Buffer.from(parts[1], "base64url").toString());
  } catch {
    return undefined;
  }
}

export function extractAccountIdFromClaims(claims: IdTokenClaims): string | undefined {
  return (
    claims.chatgpt_account_id ||
    claims["https://api.openai.com/auth"]?.chatgpt_account_id ||
    claims.organizations?.[0]?.id
  );
}

interface TokenResponse {
  id_token: string;
  access_token: string;
  refresh_token: string;
  expires_in?: number;
}

function extractAccountId(tokens: TokenResponse): string | undefined {
  if (tokens.id_token) {
    const claims = parseJwtClaims(tokens.id_token);
    const accountId = claims && extractAccountIdFromClaims(claims);
    if (accountId) return accountId;
  }
  if (tokens.access_token) {
    const claims = parseJwtClaims(tokens.access_token);
    return claims ? extractAccountIdFromClaims(claims) : undefined;
  }
  return undefined;
}

/** Stored token good for long enough that no refresh is due yet. */
function usable(info: OAuthTokens | CodexOAuthTokens | undefined): info is CodexOAuthTokens {
  return (
    info?.type === "codex-oauth" && !!info.access && info.expires > Date.now() + REFRESH_BUFFER_MS
  );
}

async function refreshAccessToken(refreshToken: string): Promise<TokenResponse> {
  const response = await fetch(`${ISSUER}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "refresh_token",
      refresh_token: refreshToken,
      client_id: CLIENT_ID,
    }).toString(),
  });
  if (!response.ok) {
    throw new Error(`Token refresh failed: ${response.status}`);
  }
  return response.json();
}

export namespace CodexAuth {
  export async function authorize(): Promise<{
    url: string;
    pkce: PkceCodes;
  }> {
    const pkce = await generatePKCE();

    const params = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: REDIRECT_URI,
      scope: "openid profile email offline_access",
      code_challenge: pkce.challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state: pkce.verifier,
      originator: "agentuse",
    });

    return {
      url: `${ISSUER}/oauth/authorize?${params.toString()}`,
      pkce,
    };
  }

  export async function exchange(code: string, pkce: PkceCodes): Promise<{
    refresh: string;
    access: string;
    expires: number;
    accountId: string | undefined;
  }> {
    const response = await fetch(`${ISSUER}/oauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        grant_type: "authorization_code",
        code,
        redirect_uri: REDIRECT_URI,
        client_id: CLIENT_ID,
        code_verifier: pkce.verifier,
      }).toString(),
    });

    if (!response.ok) {
      throw new ExchangeFailed();
    }

    const tokens: TokenResponse = await response.json();
    const accountId = extractAccountId(tokens);

    return {
      refresh: tokens.refresh_token,
      access: tokens.access_token,
      expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
      accountId,
    };
  }

  export async function access(): Promise<{ token: string; accountId: string | undefined } | undefined> {
    try {
      // Double-checked: the custom fetch calls this on every provider request,
      // and the lock is a mkdir/rm on a directory shared by every worker, so
      // taking it per request stalled concurrent callers by >100ms each. A
      // token nowhere near expiry needs no lock; the same check runs again
      // inside the lock, so a refresh still happens exactly once.
      let cached = await AuthStorage.getOAuthCached("openai");
      if (!usable(cached)) {
        // Our copy looks stale, but another process may have refreshed it
        // already. Re-read before concluding that we have to take the lock.
        cached = await AuthStorage.getOAuthCached("openai", { refresh: true });
      }
      if (usable(cached)) return { token: cached.access, accountId: cached.accountId };

      return await AuthStorage.updateOAuth("openai", async (info) => {
        if (!info || info.type !== "codex-oauth") return { value: undefined };

        // Check if token is still valid (with 5 minute buffer)
        if (info.access && info.expires > Date.now() + REFRESH_BUFFER_MS) {
          return { value: { token: info.access, accountId: info.accountId } };
        }

        // Refresh is locked across processes because OAuth refresh tokens can rotate.
        const tokens = await refreshAccessToken(info.refresh);
        const accountId = extractAccountId(tokens) || info.accountId;
        const next = {
          type: "codex-oauth" as const,
          // Some providers only return a new refresh token when it rotates; keep
          // the existing one otherwise, else we'd persist undefined and the next
          // refresh 400s → permanent silent logout.
          refresh: tokens.refresh_token ?? info.refresh,
          access: tokens.access_token,
          expires: Date.now() + (tokens.expires_in ?? 3600) * 1000,
          accountId,
        };
        return { value: { token: next.access, accountId }, next };
      });
    } catch {
      return undefined;
    }
  }

  export class ExchangeFailed extends Error {
    constructor() {
      super("Token exchange failed");
    }
  }
}
