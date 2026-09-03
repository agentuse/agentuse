import { Command } from 'commander';
import {
  installPlugin,
  readAllPluginRecords,
  readProjectPluginRecords,
  removePlugin,
  updatePlugins,
  type PluginInstallOptions,
} from '../plugin/provider-installer';
import { getInstalledPluginHost, readInstalledPluginRecords, resetProviderPluginCache } from '../plugin/provider-runtime';
import { getProviderStatus } from '../auth/provider-status';
import { logger } from '../utils/logger';

/** Print one actionable line instead of a Node stack trace. */
function run<T extends unknown[]>(action: (...args: T) => Promise<void>): (...args: T) => Promise<void> {
  return async (...args) => {
    try {
      await action(...args);
    } catch (error) {
      logger.error(error instanceof Error ? error.message : String(error));
      process.exit(1);
    }
  };
}

/**
 * After install or update, say right away when a contributed provider still
 * needs something on this machine (a bridged CLI, for example) instead of
 * letting the first agent run discover it.
 */
async function reportProviderReadiness(pluginNames: string[]): Promise<void> {
  resetProviderPluginCache();
  const host = await getInstalledPluginHost();
  const owned = new Set(host.listProviderContributions()
    .filter((contribution) => pluginNames.includes(contribution.owner.name))
    .map((contribution) => contribution.providerId));
  if (owned.size === 0) return;
  const { providers } = await getProviderStatus();
  for (const provider of providers.filter((item) => owned.has(item.id))) {
    if (provider.readiness && !provider.readiness.ok) process.stdout.write(`⚠️  ${provider.name} - ${provider.actionRequired}\n`);
    else if (provider.readiness?.ok) process.stdout.write(`✅ ${provider.name} ready${provider.readiness.detail ? ` (${provider.readiness.detail})` : ''}\n`);
  }
}

function scopeOptions(command: Command): Command {
  return command.option('-l, --local', 'Use project-local .agentuse package settings');
}

function options(value: { local?: boolean }): PluginInstallOptions {
  return { local: Boolean(value.local) };
}

export function createInstallCommand(name = 'install'): Command {
  return scopeOptions(new Command(name)
    .description('Install an AgentUse plugin from GitHub or a local Git checkout')
    .argument('<source>', 'Git source, optionally followed by @tag, @branch, or @commit'))
    .action(run(async (source: string, value: { local?: boolean }) => {
      const plugin = await installPlugin(source, options(value));
      process.stdout.write(`Installed ${plugin.name}@${plugin.version} (${plugin.scope})\n`);
      await reportProviderReadiness([plugin.name]);
    }));
}

export function createUpdateCommand(name = 'update'): Command {
  return scopeOptions(new Command(name)
    .description('Update one AgentUse plugin, or every installed plugin')
    .argument('[name]', 'Installed plugin name'))
    .action(run(async (packageName: string | undefined, value: { local?: boolean }) => {
      const plugins = await updatePlugins(packageName, options(value));
      if (plugins.length === 0) process.stdout.write('No plugins installed\n');
      for (const plugin of plugins) process.stdout.write(`Updated ${plugin.name}@${plugin.version}\n`);
      await reportProviderReadiness(plugins.map((plugin) => plugin.name));
    }));
}

export function createRemoveCommand(name = 'remove'): Command {
  return scopeOptions(new Command(name)
    .description('Remove an installed AgentUse plugin')
    .argument('<name>', 'Installed plugin name'))
    .action(run(async (packageName: string, value: { local?: boolean }) => {
      const plugin = await removePlugin(packageName, options(value));
      process.stdout.write(`Removed ${plugin.name}\n`);
    }));
}

export function createListCommand(name = 'list'): Command {
  return scopeOptions(new Command(name)
    .description('List installed AgentUse plugins')
    .option('--json', 'Output JSON')
    .option('--all-scopes', 'Show global and project packages'))
    .action(run(async (value: { json?: boolean; local?: boolean; allScopes?: boolean }) => {
      const plugins = value.allScopes
        ? await readAllPluginRecords(options(value))
        : value.local ? await readProjectPluginRecords(options(value)) : await readInstalledPluginRecords();
      if (value.json) {
        process.stdout.write(`${JSON.stringify({ plugins }, null, 2)}\n`);
        return;
      }
      if (plugins.length === 0) {
        process.stdout.write('No plugins installed\n');
        return;
      }
      for (const plugin of plugins) {
        process.stdout.write(`${plugin.name}@${plugin.version}  ${plugin.scope}${plugin.linked ? ' linked' : ''}  ${plugin.source}${plugin.ref ? `@${plugin.ref}` : ''}${plugin.commit ? `  ${plugin.commit.slice(0, 8)}` : ''}\n`);
      }
    }));
}

/** Canonical namespace for installable AgentUse plugins. */
export function createPluginsCommand(): Command {
  const command = new Command('plugins').alias('plugin').description('Install and manage AgentUse plugins');
  command.addCommand(createInstallCommand());
  command.addCommand(createUpdateCommand());
  command.addCommand(createRemoveCommand().alias('uninstall'));
  command.addCommand(createListCommand().alias('ls'));
  return command;
}

export function addPluginCommands(program: Command): void {
  program.addCommand(createPluginsCommand());
  program.addCommand(createInstallCommand(), { hidden: true });
  program.addCommand(createRemoveCommand().alias('uninstall'), { hidden: true });
  program.addCommand(createListCommand(), { hidden: true });
  program.addCommand(createUpdateCommand(), { hidden: true });
}
