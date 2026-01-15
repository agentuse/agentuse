import { z } from "zod";

export const OAuthTokens = z.object({
  type: z.literal("oauth"),
  refresh: z.string(),
  access: z.string(),
  expires: z.number(),
});

export const CodexOAuthTokens = z.object({
  type: z.literal("codex-oauth"),
  refresh: z.string(),
  access: z.string(),
  expires: z.number(),
  accountId: z.string().optional(),
});

export const ApiKeyAuth = z.object({
  type: z.literal("api"),
  key: z.string(),
});

export const WellKnownAuth = z.object({
  type: z.literal("wellknown"),
  key: z.string(),
  token: z.string(),
});

export const AuthInfo = z.discriminatedUnion("type", [
  OAuthTokens,
  CodexOAuthTokens,
  ApiKeyAuth,
  WellKnownAuth,
]);

export type AuthInfo = z.infer<typeof AuthInfo>;
export type OAuthTokens = z.infer<typeof OAuthTokens>;
export type CodexOAuthTokens = z.infer<typeof CodexOAuthTokens>;
export type ApiKeyAuth = z.infer<typeof ApiKeyAuth>;
export type WellKnownAuth = z.infer<typeof WellKnownAuth>;

// Combined provider auth supporting both OAuth and API key
export interface ProviderAuth {
  oauth?: OAuthTokens | CodexOAuthTokens;
  api?: ApiKeyAuth;
}