import { Command } from 'commander';
import chalk from 'chalk';
import { MODELS, SUGGESTED_MODEL_IDS, type Provider, type ModelInfo } from '../generated/models';
import { AuthStorage } from '../auth/storage';
import {
  OPENCODE_GO_DISPLAY_NAME,
  OPENCODE_GO_MODELS,
  OPENCODE_GO_PROVIDER_ID,
} from '../providers/opencode-go';

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

      // Show legend
      console.log(chalk.gray('Legend: [R] Reasoning, [V] Vision, [T] Tool Use\n'));

      // Show usage hint
      console.log(chalk.gray('Usage: agentuse run agent.agentuse -m <model>'));
      console.log(chalk.gray(`Example: agentuse run agent.agentuse -m ${OPENCODE_GO_PROVIDER_ID}:kimi-k2.7-code\n`));
    });

  return modelsCommand;
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
