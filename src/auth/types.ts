import { z } from "zod";

export const OAuthTokens = z.object({
  type: z.literal("oauth"),
  refresh: z.string(),
  access: z.string(),
  expires: z.number(),
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
  ApiKeyAuth,
  WellKnownAuth,
]);

export type AuthInfo = z.infer<typeof AuthInfo>;
export type OAuthTokens = z.infer<typeof OAuthTokens>;
export type ApiKeyAuth = z.infer<typeof ApiKeyAuth>;
export type WellKnownAuth = z.infer<typeof WellKnownAuth>;