import { generatePKCE } from "@openauthjs/openauth/pkce";
import { AuthStorage } from "./storage.js";

export namespace AnthropicAuth {
  const CLIENT_ID = "9d1c250a-e61b-44d9-88ed-5944d1962f5e";
  const REFRESH_BUFFER_MS = 5 * 60 * 1000;
  const REFRESH_RETRY_DELAY_MS = 750;

  export async function authorize(mode: "max" | "console") {
    const pkce = await generatePKCE();

    const url = new URL(
      `https://${mode === "console" ? "console.anthropic.com" : "claude.ai"}/oauth/authorize`
    );
    
    url.searchParams.set("code", "true");
    url.searchParams.set("client_id", CLIENT_ID);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("redirect_uri", "https://console.anthropic.com/oauth/code/callback");
    url.searchParams.set("scope", "org:create_api_key user:profile user:inference");
    url.searchParams.set("code_challenge", pkce.challenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", pkce.verifier);
    
    return {
      url: url.toString(),
      verifier: pkce.verifier,
    };
  }

  export async function exchange(code: string, verifier: string) {
    const splits = code.split("#");
    const result = await fetch("https://console.anthropic.com/v1/oauth/token", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        code: splits[0],
        state: splits[1],
        grant_type: "authorization_code",
        client_id: CLIENT_ID,
        redirect_uri: "https://console.anthropic.com/oauth/code/callback",
        code_verifier: verifier,
      }),
    });
    if (!result.ok) throw new ExchangeFailed();
    const json = await result.json();
    return {
      refresh: json.refresh_token as string,
      access: json.access_token as string,
      expires: Date.now() + json.expires_in * 1000,
    };
  }

  export async function access() {
    // Priority 1: Check CLAUDE_CODE_OAUTH_TOKEN (long-lived token from `claude setup-token`)
    // This token is valid for 1 year and doesn't require refresh
    const claudeCodeOAuthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (claudeCodeOAuthToken) {
      return claudeCodeOAuthToken;
    }

    // Priority 2: Fall back to file-based storage. Refresh is locked across
    // processes because OAuth refresh tokens can rotate.
    let result: AccessResult;
    try {
      result = await AuthStorage.updateOAuth<AccessResult>("anthropic", async (info) => {
        if (!info || info.type !== "oauth") return { value: { kind: "absent" } };
        if (info.access && info.expires > Date.now() + REFRESH_BUFFER_MS) {
          return { value: { kind: "ok", access: info.access } };
        }

        const refreshed = await refreshToken(info.refresh);
        if (!refreshed.ok) return { value: { kind: "refresh-failed", reason: refreshed.reason } };

        const next = {
          type: "oauth" as const,
          refresh: refreshed.refresh,
          access: refreshed.access,
          expires: refreshed.expires,
        };
        return { value: { kind: "ok", access: next.access }, next };
      });
    } catch (error) {
      // Lock timeout or an unreadable store: the credentials are most likely
      // still there, we just could not use them this time.
      throw new RefreshFailed(error instanceof Error ? error.message : String(error));
    }

    // A stored login that cannot be refreshed is not the same thing as no
    // login. Reporting it as "not authenticated" sends the operator to
    // `auth login` for what is usually a blip, and hides a real one.
    if (result.kind === "refresh-failed") throw new RefreshFailed(result.reason);
    return result.kind === "ok" ? result.access : undefined;
  }

  type AccessResult =
    | { kind: "ok"; access: string }
    | { kind: "absent" }
    | { kind: "refresh-failed"; reason: string };

  type RefreshResult =
    | { ok: true; refresh: string; access: string; expires: number }
    | { ok: false; reason: string };

  /**
   * Exchange the refresh token for a fresh access token.
   *
   * One retry, because the alternative is losing a whole run to a blip: the
   * token endpoint 5xx/429s, or the network drops, on a refresh that would
   * succeed a second later. Any other 4xx is a real logout and fails at once.
   */
  async function refreshToken(refresh: string): Promise<RefreshResult> {
    let reason = "unknown error";

    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise((resolve) => setTimeout(resolve, REFRESH_RETRY_DELAY_MS));

      let response: Response;
      try {
        response = await fetch("https://console.anthropic.com/v1/oauth/token", {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            grant_type: "refresh_token",
            refresh_token: refresh,
            client_id: CLIENT_ID,
          }),
        });
      } catch (error) {
        reason = `network error: ${error instanceof Error ? error.message : String(error)}`;
        continue;
      }

      if (response.ok) {
        const json = await response.json();
        return {
          ok: true,
          // Fall back to the existing refresh token when the response omits a new
          // one, otherwise we'd persist undefined -> next refresh 400s -> silent logout.
          refresh: (json.refresh_token as string) ?? refresh,
          access: json.access_token as string,
          expires: Date.now() + json.expires_in * 1000,
        };
      }

      reason = `HTTP ${response.status}`;
      if (response.status !== 429 && response.status < 500) break;
    }

    return { ok: false, reason };
  }

  /** Stored credentials exist but could not be exchanged for an access token. */
  export class RefreshFailed extends Error {
    constructor(reason: string) {
      super(`Anthropic OAuth token refresh failed (${reason})`);
      this.name = "AnthropicRefreshFailed";
    }
  }

  export class ExchangeFailed extends Error {
    constructor() {
      super("Exchange failed");
    }
  }
}
