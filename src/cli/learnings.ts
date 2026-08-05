import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'path';
import { existsSync } from 'fs';
import { parseAgent } from '../parser.js';
import { resolveProjectContext } from '../utils/project.js';
import {
  LearningStore,
  activeLearnings,
  consolidateLearnings,
  describeConsolidation,
  effectiveCap,
  isGraduationEligible,
  partitionLearnings,
  undoConsolidation,
  type ConsolidationResult,
  type Learning,
} from '../learning/index.js';

/**
 * `agentuse learnings` — inspect and tidy an agent's stored corrections.
 *
 * The tidy-up is offered here and in the serve web UI, both calling the same
 * core function, because the two audiences never overlap: the operator lives in
 * the terminal and owns the agent file, the reviewer lives in the web UI and
 * never sees it. Either one should be able to fix this without learning the
 * other's surface.
 */

async function loadAgent(agentFileArg: string) {
  const agentFilePath = resolve(process.cwd(), agentFileArg);
  if (!existsSync(agentFilePath)) {
    console.error(chalk.red(`Agent file not found: ${agentFilePath}`));
    process.exitCode = 1;
    return null;
  }
  const agent = await parseAgent(agentFilePath);
  return { agent, agentFilePath };
}

function statusLabel(learning: Learning, injectedIds: Set<string>): string {
  if (learning.state === 'graduated') return chalk.cyan('in agent file');
  if (learning.state === 'retired') return chalk.gray('retired');
  return injectedIds.has(learning.id) ? chalk.green('applied') : chalk.yellow('dormant');
}

/** Evidence, shown so a user can see WHY a rule is or is not close to becoming
 *  permanent instead of having to trust the tidy-up's judgement. */
function evidence(learning: Learning): string {
  const bits = [`src:${learning.source}`, `applied:${learning.appliedCount}`];
  if (learning.approvedRuns > 0) bits.push(`approved:${learning.approvedRuns}`);
  if (learning.reasserted > 0) bits.push(chalk.magenta(`repeated:${learning.reasserted}`));
  if (isGraduationEligible(learning) && (learning.state ?? 'active') === 'active') bits.push('ready to make permanent');
  return bits.join(' · ');
}

function printDiff(diff: string): void {
  for (const line of diff.split('\n')) {
    if (line.startsWith('+++') || line.startsWith('---')) console.log(chalk.bold(`  ${line}`));
    else if (line.startsWith('@@')) console.log(chalk.cyan(`  ${line}`));
    else if (line.startsWith('+')) console.log(chalk.green(`  ${line}`));
    else if (line.startsWith('-')) console.log(chalk.red(`  ${line}`));
    else console.log(chalk.gray(`  ${line}`));
  }
}

/**
 * Both diffs, always. Half a tidy-up lands in the corrections file and half in
 * the agent file; showing only one hides the half the user cares about most.
 */
function printResult(result: ConsolidationResult, dryRun: boolean): void {
  if (!result.ran) {
    console.log(chalk.green('Nothing to tidy up — every stored correction reaches this agent.'));
    return;
  }
  if (result.note && result.changes.length === 0) {
    console.log(chalk.yellow(result.note));
    return;
  }

  console.log(chalk.bold(dryRun ? '\nProposed' : '\nDone'));
  console.log(`  ${describeConsolidation(result)}`);
  if (result.model) console.log(chalk.gray(`  planned by ${result.model}`));
  // A partial failure rides alongside real changes: say so, or the run reads as
  // having covered everything when part of the file was never looked at.
  if (result.note) console.log(chalk.yellow(`  ${result.note}`));

  for (const change of result.changes) {
    const verb = change.kind === 'graduate' ? 'permanent' : change.kind;
    console.log(`  ${chalk.bold(verb)}: ${change.titles.join(' + ')}`);
    if (change.why) console.log(chalk.gray(`    ${change.why}`));
  }

  if (result.graduationSkipped) {
    console.log(chalk.yellow(`  Rules were not made permanent: ${result.graduationSkipped}`));
  }

  if (result.diffs.learnings) {
    console.log(chalk.bold('\nCorrections file'));
    printDiff(result.diffs.learnings);
  }
  if (result.diffs.agentFile) {
    console.log(chalk.bold('\nAgent file'));
    printDiff(result.diffs.agentFile);
  }

  // A single pass plans in batches and is deliberately conservative, so a very
  // large file lands closer to the cap without reaching it. Say so: "125 → 50"
  // reads as finished unless we point out that 50 is still 40 over.
  if (result.activeAfter > result.cap) {
    console.log(chalk.yellow(`\n  Still ${result.activeAfter - result.cap} over the cap. Run tidy again to keep going.`));
  }

  if (!dryRun && result.undoId) {
    console.log(chalk.gray('\nUndo: agentuse learnings undo <agent-file>'));
  }
}

export function createLearningsCommand(): Command {
  const command = new Command('learnings')
    .description("Inspect and tidy an agent's stored corrections")
    .argument('<agent-file>', 'Path to the .agentuse file')
    .option('-j, --json', 'Output as JSON')
    .action(async (agentFileArg: string, options: { json?: boolean }) => {
      const loaded = await loadAgent(agentFileArg);
      if (!loaded) return;
      const { agent, agentFilePath } = loaded;

      const store = LearningStore.fromAgentFile(agentFilePath, agent.config.learning?.file);
      const stored = await store.load();
      const cap = effectiveCap(agent.config.learning);
      const { injected, dormant } = partitionLearnings(stored, cap);
      const injectedIds = new Set(injected.map((l) => l.id));

      if (options.json) {
        console.log(JSON.stringify({
          file: store.filePath,
          cap,
          active: activeLearnings(stored).length,
          injected: injected.length,
          dormant: dormant.length,
          learnings: stored.map((l) => ({
            ...l,
            state: l.state ?? 'active',
            injected: injectedIds.has(l.id),
          })),
        }, null, 2));
        return;
      }

      if (stored.length === 0) {
        console.log(chalk.gray(`No corrections stored yet (${store.filePath})`));
        return;
      }

      const groups: { label: string; items: Learning[] }[] = [
        { label: `Applied (${injected.length} of ${cap})`, items: injected },
        { label: `Never reach this agent (${dormant.length})`, items: dormant },
        { label: 'In the agent file', items: stored.filter((l) => l.state === 'graduated') },
        { label: 'Retired', items: stored.filter((l) => l.state === 'retired') },
      ];

      console.log(chalk.gray(store.filePath));
      for (const group of groups) {
        if (group.items.length === 0) continue;
        console.log(chalk.bold(`\n${group.label}`));
        for (const l of group.items) {
          console.log(`  ${statusLabel(l, injectedIds)}  [${l.category}] ${l.title}`);
          console.log(chalk.gray(`    ${evidence(l)}  ·  ${l.extractedAt.slice(0, 10)}  ·  id:${l.id}`));
        }
      }

      if (dormant.length > 0) {
        console.log(chalk.yellow(`\n${dormant.length} correction${dormant.length === 1 ? '' : 's'} never reach this agent: only the top ${cap} apply per run.`));
        console.log(chalk.gray(`Fix: agentuse learnings tidy ${agentFileArg}`));
      }
    });

  command
    .command('tidy')
    .description('Merge, sharpen, retire and make permanent, until every correction counts')
    .argument('<agent-file>', 'Path to the .agentuse file')
    .option('--dry-run', 'Show the plan and both diffs without writing anything')
    .option('--model <model>', "Plan with this model instead of the agent's own")
    .action(async (agentFileArg: string, options: { dryRun?: boolean; model?: string }) => {
      const loaded = await loadAgent(agentFileArg);
      if (!loaded) return;
      const { agent, agentFilePath } = loaded;
      const projectContext = resolveProjectContext(process.cwd(), { agentFilePath });

      const result = await consolidateLearnings({
        agentFilePath,
        agentInstructions: agent.instructions,
        agentModel: agent.config.model,
        config: agent.config.learning,
        stateRoot: projectContext.stateRoot,
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.model ? { model: options.model } : {}),
      });
      printResult(result, Boolean(options.dryRun));
    });

  command
    .command('undo')
    .description('Restore both files to their state before the last tidy-up')
    .argument('<agent-file>', 'Path to the .agentuse file')
    .action(async (agentFileArg: string) => {
      const loaded = await loadAgent(agentFileArg);
      if (!loaded) return;
      const { agentFilePath } = loaded;
      const projectContext = resolveProjectContext(process.cwd(), { agentFilePath });

      const restored = await undoConsolidation(projectContext.stateRoot, agentFilePath);
      if (!restored) {
        console.log(chalk.yellow('Nothing to undo — no tidy-up has been applied to this agent.'));
        return;
      }
      console.log(chalk.green('Restored:'));
      for (const path of restored.restored) console.log(chalk.gray(`  ${path}`));
    });

  return command;
}
