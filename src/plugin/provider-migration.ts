import { AuthStorage } from '../auth/storage.js';
import { installPlugin } from './provider-installer.js';
import { PROVIDER_PLUGIN_REGISTRY } from './provider-registry.js';
import { readInstalledPluginRecords } from './provider-runtime.js';

export type ProviderPluginInstaller = typeof installPlugin;

/**
 * Upgrade credentials created by a removed core OAuth flow. The reviewed
 * compatibility plugin is installed when needed, then credential ownership is
 * moved to the plugin's declared auth method before the upgrade completes.
 * New users still choose and consent to community plugins through provider setup.
 */
export async function installLegacyProviderPlugins(
  install: ProviderPluginInstaller = installPlugin,
): Promise<string[]> {
  const records = await readInstalledPluginRecords();
  const installedNames = new Set(records.map((record) => record.name));
  const installed: string[] = [];

  for (const entry of PROVIDER_PLUGIN_REGISTRY) {
    if (!await AuthStorage.getOAuth(entry.provider)) continue;

    if (!installedNames.has(entry.packageName)) {
      await install(entry.source);
      installedNames.add(entry.packageName);
      installed.push(entry.id);
    }
    await AuthStorage.migrateOAuthToPluginCredential(entry.provider, entry.authMethodId);
  }

  return installed;
}
