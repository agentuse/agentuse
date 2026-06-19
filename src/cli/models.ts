import { Command } from 'commander';
import chalk from 'chalk';
import { MODELS, type Provider, type ModelInfo } from '../generated/models';
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
    .action(async (provider: string | undefined, options: { verbose?: boolean }) => {
      const builtinProviders: Provider[] = ['anthropic', 'openai', 'openrouter'];
      const specialProviders = [OPENCODE_GO_PROVIDER_ID];
      const customProviders = await AuthStorage.getCustomProviders();
      const customNames = Object.keys(customProviders);
      const isCustomFilter = provider && customNames.includes(provider);
      const isOpenCodeGoFilter = provider === OPENCODE_GO_PROVIDER_ID;

      // If filtering by custom provider, don't show builtin models
      const providers: Provider[] = isCustomFilter || isOpenCodeGoFilter
        ? []
        : (!provider ? builtinProviders : [provider as Provider]);

      // Validate provider
      if (provider && !builtinProviders.includes(provider as Provider) && !specialProviders.includes(provider) && !isCustomFilter) {
        console.error(chalk.red(`Unknown provider: ${provider}`));
        const allProviders = [...builtinProviders, ...specialProviders, ...customNames];
        console.log(chalk.gray(`Available providers: ${allProviders.join(', ')}`));
        process.exit(1);
      }

      console.log(chalk.bold('\nRecommended Models\n'));
      console.log(chalk.gray('Note: Other models from these providers may also work.\n'));

      for (const p of providers) {
        const models = MODELS[p];
        if (!models || Object.keys(models).length === 0) continue;

        console.log(chalk.cyan.bold(`${p.charAt(0).toUpperCase() + p.slice(1)}`));

        for (const [modelId, model] of Object.entries(models)) {
          const fullId = `${p}:${modelId}`;

          if (options.verbose) {
            printVerboseModel(fullId, model);
          } else {
            printCompactModel(fullId, model);
          }
        }

        console.log();
      }

      if (!provider || isOpenCodeGoFilter) {
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
