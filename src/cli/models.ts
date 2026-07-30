import { Command } from 'commander';
import chalk from 'chalk';
import { readdirSync, readFileSync, statSync, writeFileSync } from 'fs';
import { join, relative, resolve } from 'path';
import { MODELS, SUGGESTED_MODEL_IDS, type Provider, type ModelInfo } from '../generated/models';
import { AuthStorage } from '../auth/storage';
import {
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_PROVIDER_ID,
} from '../providers/opencode-go';
import {
  MODEL_ALIAS_SIGIL,
  MODEL_DEFAULT_ENV,
  getConfiguredModelDefault,
  getVersionAliasesForProvider,
  resolveModelString,
} from '../utils/model-alias';
import { loadModelSettings } from '../utils/global-config';
import {
  currentModelsFromRegistry,
  findCurrentModel,
  isLiveVersionAlias,
  rewriteAgentFileModels,
  toVersionAlias,
  type ModelReferenceChange,
} from '../utils/model-bump';

export function createModelsCommand(): Command {
  const modelsCommand = new Command('models')
    .description('List recommended AI models')
    .argument('[provider]', 'Filter by provider (anthropic, openai, openrouter, opencode-go, or custom)')
    .option('-v, --verbose', 'Show detailed model information')
    .option('-a, --all', 'Show every model in the registry, not just the recommended lineup')
    .action(async (provider: string | undefined, options: { verbose?: boolean; all?: boolean }) => {
      const registryProviders = Object.keys(MODELS) as Provider[];
      const customProviders = await AuthStorage.getCustomProviders();
      const customNames = Object.keys(customProviders);
      const isCustomFilter = Boolean(provider && customNames.includes(provider));
      const isOpenCodeGoFilter = provider === OPENCODE_GO_PROVIDER_ID;

      // Validate provider
      if (provider && !registryProviders.includes(provider as Provider) && !isCustomFilter) {
        console.error(chalk.red(`Unknown provider: ${provider}`));
        console.log(chalk.gray(`Available providers: ${[...registryProviders, ...customNames].join(', ')}`));
        process.exit(1);
      }

      // Registry buckets rendered generically. Default view = curated flagships
      // for the primary providers; --all = every registry provider. opencode-go
      // has a dedicated section (below) in the curated view, so it is dropped
      // from the generic loop unless --all renders its full bucket there.
      let providers: Provider[];
      if (provider) {
        providers = isCustomFilter ? [] : [provider as Provider];
      } else if (options.all) {
        providers = registryProviders;
      } else {
        providers = ['anthropic', 'openai', 'openrouter'];
      }
      if (!options.all) providers = providers.filter((p) => p !== OPENCODE_GO_PROVIDER_ID);

      console.log(chalk.bold(options.all ? '\nAll Models\n' : '\nRecommended Models\n'));
      console.log(chalk.gray(options.all
        ? 'Every model known to the registry (used for validation and context limits).\n'
        : 'Note: Other models from these providers may also work. Use --all to list them.\n'));

      for (const p of providers) {
        const entries = entriesForProvider(p, options.all ?? false);
        if (entries.length === 0) continue;

        console.log(chalk.cyan.bold(`${p.charAt(0).toUpperCase() + p.slice(1)}`));

        for (const [modelId, model] of entries) {
          const fullId = `${p}:${modelId}`;

          if (options.verbose) {
            printVerboseModel(fullId, model);
          } else {
            printCompactModel(fullId, model);
          }
        }

        console.log();
      }

      if ((!provider || isOpenCodeGoFilter) && !options.all) {
        console.log(chalk.cyan.bold(OPENCODE_GO_DISPLAY_NAME));

        for (const model of OPENCODE_GO_MODELS) {
          const fullId = `${OPENCODE_GO_PROVIDER_ID}:${model.id}`;
          const modelInfo: ModelInfo = {
            id: model.id,
            name: model.name,
            reasoning: true,
            toolCall: true,
            modalities: { input: ['text'], output: ['text'] },
            limit: { context: 0, output: 0 },
            cost: { input: 0, output: 0 },
          };

          if (options.verbose) {
            printVerboseModel(fullId, modelInfo);
          } else {
            printCompactModel(fullId, modelInfo);
          }
        }

        console.log(chalk.gray(`  Live list: https://opencode.ai/zen/go/v1/models`));
        console.log();
      }

      // Show custom providers
      const displayCustom = isCustomFilter
        ? Object.entries(customProviders).filter(([name]) => name === provider)
        : Object.entries(customProviders);

      if (displayCustom.length > 0 && (!provider || isCustomFilter)) {
        for (const [name, config] of displayCustom) {
          console.log(chalk.cyan.bold(`${name}`) + chalk.gray(` (${config.baseURL})`));
          console.log(chalk.gray(`  Use: agentuse run agent.agentuse -m ${name}:<model-name>`));
          console.log();
        }
      }

      printAliasSections(provider ? [provider] : ['anthropic', 'openai', 'openrouter']);

      // Show legend
      console.log(chalk.gray('Legend: [R] Reasoning, [V] Vision, [T] Tool Use\n'));

      // Show usage hint
      console.log(chalk.gray('Usage: agentuse run agent.agentuse -m <model>'));
      console.log(chalk.gray(`Example: agentuse run agent.agentuse -m ${OPENCODE_GO_PROVIDER_ID}:kimi-k2.7-code\n`));
    });

  modelsCommand.addCommand(createBumpCommand());
  modelsCommand.addCommand(createUnpinCommand());

  return modelsCommand;
}

/**
 * Print the alias tables: the built-in version aliases for the providers on
 * screen, the user's own `@name` aliases, and the configured default model.
 */
function printAliasSections(providers: string[]): void {
  const rows: Array<[string, string]> = [];
  for (const provider of providers) {
    for (const [alias, modelId] of Object.entries(getVersionAliasesForProvider(provider))) {
      rows.push([`${provider}:${alias}`, `${provider}:${modelId}`]);
    }
  }

  if (rows.length > 0) {
    console.log(chalk.cyan.bold('Version aliases'));
    console.log(chalk.gray('  Drop the version and you always get the newest model in that line.'));
    const width = Math.max(...rows.map(([alias]) => alias.length));
    for (const [alias, target] of rows) {
      console.log(`  ${chalk.white(alias.padEnd(width))} ${chalk.gray('→')} ${chalk.gray(target)}`);
    }
    console.log();
  }

  const settings = loadModelSettings();
  const userAliases = Object.entries(settings.aliases);
  if (userAliases.length > 0) {
    console.log(chalk.cyan.bold('Your aliases'));
    const width = Math.max(...userAliases.map(([name]) => name.length + MODEL_ALIAS_SIGIL.length));
    for (const [name, target] of userAliases) {
      const resolved = safeResolve(target);
      const suffix = resolved && resolved !== target ? chalk.gray(` → ${resolved}`) : '';
      console.log(
        `  ${chalk.white(`${MODEL_ALIAS_SIGIL}${name}`.padEnd(width))} ${chalk.gray('→')} ${chalk.gray(target)}${suffix}`
      );
    }
    console.log();
  }

  const configuredDefault = getConfiguredModelDefault();
  if (configuredDefault) {
    const resolved = safeResolve(configuredDefault);
    const shown = resolved && resolved !== configuredDefault
      ? `${configuredDefault} → ${resolved}`
      : configuredDefault;
    const from = process.env[MODEL_DEFAULT_ENV]?.trim() ? MODEL_DEFAULT_ENV : 'models.default';
    console.log(chalk.cyan.bold('Default model') + chalk.gray(' (used when an agent file omits `model`)'));
    console.log(`  ${chalk.white(shown)} ${chalk.gray(`(from ${from})`)}\n`);
  }
}

/** Resolve for display, tolerating a broken alias so listing never crashes. */
function safeResolve(modelString: string): string | undefined {
  try {
    return resolveModelString(modelString).model;
  } catch {
    return undefined;
  }
}

interface RewriteOptions {
  dryRun?: boolean;
}

function createBumpCommand(): Command {
  return new Command('bump')
    .description('Update superseded model pins in agent files to the current model of the same line')
    .argument('[path]', 'Agent file or directory to scan (default: current directory)')
    .option('-n, --dry-run', 'Show what would change without writing')
    .action((path: string | undefined, options: RewriteOptions) => {
      const currentModels = currentModelsFromRegistry();
      const providers = Object.keys(currentModels);
      runRewrite({
        path,
        providers,
        dryRun: options.dryRun ?? false,
        label: 'bump',
        rewrite: (provider, modelId) => {
          if (currentModels[provider]?.includes(modelId)) return null;
          // An alias already tracks the line; pinning it here would undo that.
          if (isLiveVersionAlias(provider, modelId)) return null;
          const current = findCurrentModel(provider, modelId, currentModels);
          return current && current !== modelId ? `${provider}:${current}` : null;
        },
      });
    });
}

function createUnpinCommand(): Command {
  return new Command('unpin')
    .description('Replace pinned model versions in agent files with version aliases, so they track the newest release')
    .argument('[path]', 'Agent file or directory to scan (default: current directory)')
    .option('-n, --dry-run', 'Show what would change without writing')
    .action((path: string | undefined, options: RewriteOptions) => {
      runRewrite({
        path,
        providers: Object.keys(currentModelsFromRegistry()),
        dryRun: options.dryRun ?? false,
        label: 'unpin',
        rewrite: toVersionAlias,
      });
    });
}

function runRewrite(params: {
  path: string | undefined;
  providers: string[];
  dryRun: boolean;
  label: 'bump' | 'unpin';
  rewrite: (provider: string, modelId: string) => string | null;
}): void {
  const target = resolve(params.path ?? process.cwd());
  let files: string[];
  try {
    files = collectAgentFiles(target);
  } catch (error) {
    console.error(chalk.red(`Cannot read ${target}: ${(error as Error).message}`));
    process.exit(1);
  }

  if (files.length === 0) {
    console.log(chalk.yellow(`No .agentuse files found under ${target}`));
    return;
  }

  let changedFiles = 0;
  let changedRefs = 0;

  for (const file of files) {
    const original = readFileSync(file, 'utf-8');
    const { content, changes } = rewriteAgentFileModels(original, params.providers, params.rewrite);
    if (changes.length === 0) continue;

    changedFiles++;
    changedRefs += changes.length;
    console.log(chalk.bold(displayPath(file)));
    for (const change of changes) {
      console.log(`  ${chalk.red(change.from)} ${chalk.gray('→')} ${chalk.green(change.to)}${aliasNote(params.label, change)}`);
    }
    if (!params.dryRun) writeFileSync(file, content);
  }

  console.log();
  if (changedFiles === 0) {
    console.log(chalk.green(`Nothing to ${params.label}: checked ${files.length} agent file(s).`));
    return;
  }
  console.log(
    params.dryRun
      ? chalk.yellow(`Dry run: ${changedRefs} reference(s) in ${changedFiles} file(s) would change. Re-run without --dry-run to apply.`)
      : chalk.green(`Updated ${changedRefs} reference(s) in ${changedFiles} file(s).`)
  );
  if (params.label === 'unpin' && !params.dryRun) {
    console.log(chalk.gray('These files now follow the newest model in each line. `agentuse models` shows what each alias resolves to.'));
  }
}

/** For unpin, show which concrete model the new alias points at right now. */
function aliasNote(label: 'bump' | 'unpin', change: ModelReferenceChange): string {
  if (label !== 'unpin') return '';
  const resolved = safeResolve(change.to);
  return resolved && resolved !== change.to ? chalk.gray(` (currently ${resolved})`) : '';
}

/** Shortest readable form: relative when it stays inside cwd, else absolute. */
function displayPath(file: string): string {
  const rel = relative(process.cwd(), file);
  return !rel || rel.startsWith('..') ? file : rel;
}

/** Agent files under a path, skipping dependency and VCS directories. */
function collectAgentFiles(target: string): string[] {
  const stat = statSync(target);
  if (stat.isFile()) return target.endsWith('.agentuse') ? [target] : [];

  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.') || entry.name === 'node_modules') continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.isFile() && entry.name.endsWith('.agentuse')) found.push(full);
    }
  };
  walk(target);
  return found.sort();
}

/**
 * Models to list for a provider. By default the curated recommended lineup
 * (SUGGESTED_MODEL_IDS, in suggested order); with `all`, every model the full
 * registry knows for that provider.
 */
function entriesForProvider(p: Provider, all: boolean): Array<[string, ModelInfo]> {
  const models = MODELS[p] ?? {};
  if (all) return Object.entries(models);
  const prefix = `${p}:`;
  const curated = SUGGESTED_MODEL_IDS
    .filter((id) => id.startsWith(prefix))
    .map((id) => id.slice(prefix.length))
    .filter((modelId) => models[modelId])
    .map((modelId) => [modelId, models[modelId]] as [string, ModelInfo]);
  // A provider with no curated lineup (e.g. bedrock) but an explicit request
  // still shows its full bucket rather than an empty section.
  return curated.length > 0 ? curated : Object.entries(models);
}

function printCompactModel(fullId: string, model: ModelInfo): void {
  const capabilities: string[] = [];
  if (model.reasoning) capabilities.push('R');
  if (model.modalities.input.includes('image')) capabilities.push('V');
  if (model.toolCall) capabilities.push('T');

  const capStr = capabilities.length > 0 ? chalk.gray(` [${capabilities.join(',')}]`) : '';

  console.log(`  ${chalk.white(fullId)}${capStr}`);
}

function printVerboseModel(fullId: string, model: ModelInfo): void {
  console.log(`  ${chalk.white(fullId)}`);
  console.log(chalk.gray(`    Name: ${model.name}`));
  const [provider, ...idParts] = fullId.split(':');
  const alias = provider ? toVersionAlias(provider, idParts.join(':')) : null;
  if (alias) {
    console.log(chalk.gray(`    Alias: ${alias} (always the newest in this line)`));
  }
  const inputContext = model.limit.input ?? model.limit.context;
  if (inputContext > 0) {
    console.log(chalk.gray(`    Input context: ${inputContext.toLocaleString()} tokens`));
  }
  if (model.limit.input !== undefined && model.limit.context > 0 && model.limit.context !== model.limit.input) {
    console.log(chalk.gray(`    Total window: ${model.limit.context.toLocaleString()} tokens`));
  }
  if (model.limit.output > 0) {
    console.log(chalk.gray(`    Output: ${model.limit.output.toLocaleString()} tokens`));
  }

  const caps: string[] = [];
  if (model.reasoning) caps.push('Reasoning');
  if (model.modalities.input.includes('image')) caps.push('Vision');
  if (model.modalities.input.includes('video')) caps.push('Video');
  if (model.toolCall) caps.push('Tool Use');

  if (caps.length > 0) {
    console.log(chalk.gray(`    Capabilities: ${caps.join(', ')}`));
  }

  console.log();
}
