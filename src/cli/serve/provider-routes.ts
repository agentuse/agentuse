/**
 * The provider-setup POST endpoints, as a path -> handler table.
 * Every one parses a JSON body and answers 400 on failure, so the route module
 * drives them all through one branch. Moved verbatim out of serve.ts.
 */
import { cancelProviderOAuth, checkCustomProvider, completeProviderOAuth, completeProviderPluginOAuth, inspectUnreviewedProviderPlugin, installProviderPluginFromRegistry, installUnreviewedProviderPlugin, refreshCustomProviderModels, removeCustomProvider, removeInstalledProviderPlugin, removeProviderCredential, saveCustomProvider, saveProviderApiKey, startProviderOAuth, startProviderPluginOAuth, startUnreviewedProviderPluginOAuth, updateInstalledProviderPlugin } from "../../auth/provider-setup";
import type { ProviderPluginOAuthStart } from "../../auth/provider-setup";

/** Flatten a plugin OAuth start so the dashboard reads one shape. */
export function oauthStartResult(started: ProviderPluginOAuthStart): Record<string, unknown> {
  return started.connected ? { connected: true, ...started.snapshot } : started;
}

/** Provider setup POST endpoints: every one parses a JSON body and answers 400 on failure. */
export const PROVIDER_POST_ROUTES: Record<string, { code: string; handle(body: Record<string, unknown>): Promise<object> }> = {
  "/providers/api-key": { code: "PROVIDER_SETUP_INVALID", handle: (body) => saveProviderApiKey(body.provider, body.key) },
  "/providers/plugins/install": { code: "PROVIDER_PLUGIN_INSTALL_FAILED", handle: (body) => installProviderPluginFromRegistry(body.plugin) },
  "/providers/plugins/install-unreviewed": { code: "PROVIDER_PLUGIN_INSTALL_FAILED", handle: (body) => installUnreviewedProviderPlugin(body.source, body.commit) },
  "/providers/plugins/inspect": { code: "PROVIDER_PLUGIN_INSPECTION_FAILED", handle: async (body) => ({ plugin: await inspectUnreviewedProviderPlugin(body.source) }) },
  "/providers/plugins/oauth/start": { code: "PROVIDER_PLUGIN_OAUTH_START_FAILED", handle: async (body) => oauthStartResult(await startProviderPluginOAuth(body.plugin, body.reconnect === true)) },
  "/providers/plugins/oauth/start-unreviewed": { code: "PROVIDER_PLUGIN_OAUTH_START_FAILED", handle: async (body) => oauthStartResult(await startUnreviewedProviderPluginOAuth(body.source, body.commit)) },
  "/providers/plugins/oauth/complete": { code: "PROVIDER_PLUGIN_OAUTH_COMPLETE_FAILED", handle: (body) => completeProviderPluginOAuth(body.flowId, body.code) },
  "/providers/plugins/update": { code: "PROVIDER_PLUGIN_UPDATE_FAILED", handle: (body) => updateInstalledProviderPlugin(body.name) },
  "/providers/plugins/remove": { code: "PROVIDER_PLUGIN_REMOVE_FAILED", handle: (body) => removeInstalledProviderPlugin(body.name) },
  "/providers/oauth/start": { code: "PROVIDER_OAUTH_START_FAILED", handle: (body) => startProviderOAuth(body.provider) },
  "/providers/oauth/cancel": { code: "PROVIDER_OAUTH_CANCEL_FAILED", handle: async (body) => cancelProviderOAuth(body.flowId) },
  "/providers/oauth/complete": { code: "PROVIDER_OAUTH_COMPLETE_FAILED", handle: (body) => completeProviderOAuth(body.flowId, body.code) },
  "/providers/remove": { code: "PROVIDER_REMOVE_FAILED", handle: (body) => removeProviderCredential(body.provider, body.kind, body.pluginName, body.authMethodId) },
  "/providers/custom": { code: "CUSTOM_PROVIDER_INVALID", handle: (body) => saveCustomProvider({ name: body.name, baseURL: body.baseURL, key: body.key, api: body.api, models: body.models }) },
  "/providers/custom/check": { code: "CUSTOM_PROVIDER_CHECK_FAILED", handle: (body) => checkCustomProvider({ name: body.name, baseURL: body.baseURL, key: body.key, api: body.api, models: body.models }) },
  "/providers/custom/refresh": { code: "CUSTOM_PROVIDER_REFRESH_FAILED", handle: (body) => refreshCustomProviderModels(body.name) },
  "/providers/custom/remove": { code: "CUSTOM_PROVIDER_REMOVE_FAILED", handle: (body) => removeCustomProvider(body.name) },
};
