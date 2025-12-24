import { Command } from 'commander';
import chalk from 'chalk';
import { MODELS, type Provider, type ModelInfo } from '../generated/models';

export function createModelsCommand(): Command {
  const modelsCommand = new Command('models')
    .description('List recommended AI models')
    .argument('[provider]', 'Filter by provider (anthropic, openai, openrouter)')
    .option('-v, --verbose', 'Show detailed model information')
    .action(async (provider: string | undefined, options: { verbose?: boolean }) => {
      const providers: Provider[] = provider
        ? [provider as Provider]
        : ['anthropic', 'openai', 'openrouter'];

      // Validate provider
      if (provider && !['anthropic', 'openai', 'openrouter'].includes(provider)) {
        console.error(chalk.red(`Unknown provider: ${provider}`));
        console.log(chalk.gray('Available providers: anthropic, openai, openrouter'));
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

      // Show legend
      console.log(chalk.gray('Legend: [R] Reasoning, [V] Vision, [T] Tool Use\n'));

      // Show usage hint
      console.log(chalk.gray('Usage: agentuse run agent.agentuse -m <model>'));
      console.log(chalk.gray('Example: agentuse run agent.agentuse -m anthropic:claude-sonnet-4-5\n'));
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
  console.log(chalk.gray(`    Context: ${model.limit.context.toLocaleString()} tokens`));
  console.log(chalk.gray(`    Output: ${model.limit.output.toLocaleString()} tokens`));

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
