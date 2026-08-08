import { Command } from 'commander';
import chalk from 'chalk';
import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { dirname, relative, resolve } from 'path';
import { existsSync } from 'fs';
import { mkdir } from 'fs/promises';
import { parseAgent } from '../parser.js';
import { resolveProjectContext } from '../utils/project.js';
import {
  LearningStore,
  activeLearnings,
  applyLearningMigration,
  consolidateLearnings,
  deleteMigrationSource,
  describeConsolidation,
  effectiveCap,
  findAgentFiles,
  findOrphanedLearningFiles,
  isGraduationEligible,
  partitionLearnings,
  planLearningMigration,
  undoConsolidation,
  writeTidyRecord,
  clearTidyRecord,
  type ConsolidationResult,
  type ConsolidationChange,
  type Learning,
  type MigrationEntry,
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
  // The agent file's own project root, not the cwd's: it decides both where the
  // corrections file lives and where the tidy-up snapshots go, and `agentuse
  // learnings` must name the same file the run writes to from any directory.
  const { stateRoot } = resolveProjectContext(process.cwd(), { agentFilePath });
  return { agent, agentFilePath, stateRoot };
}

/** Repo-relative where that is shorter, absolute where it is not (the state
 *  directory is never under the cwd, so it always prints in full). */
function displayPath(filePath: string): string {
  const rel = relative(process.cwd(), filePath);
  return rel.startsWith('..') ? filePath : rel;
}

/** One line per file, `<verb>  from → to`, so a migration of fifty agents stays
 *  scannable and greppable. */
function printMigration(verb: string, entry: MigrationEntry): void {
  console.log(`  ${verb}  ${displayPath(entry.from)} ${chalk.gray('→')} ${entry.to}`);
}

/**
 * Ask a yes/no question, defaulting to no.
 *
 * Defaulting to no matters more than usual here: the only question this asks is
 * whether to delete the user's files, and a stray Enter should never be the
 * thing that removes them.
 */
async function confirmDestructive(question: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return await new Promise<boolean>((resolveAnswer) => {
      rl.on('SIGINT', () => resolveAnswer(false));
      // Ctrl-D, or a terminal that goes away mid-question. Without this the
      // promise never settles: the command would exit silently at the prompt,
      // skipping even the line that says where the kept file is.
      rl.on('close', () => resolveAnswer(false));
      rl.question(question, (answer) => resolveAnswer(/^y(es)?$/i.test(answer.trim())));
    });
  } finally {
    rl.close();
  }
}

/**
 * The second half of the migration: remove the originals, once their copies are
 * on disk and the user has said so.
 *
 * Keeping is the default everywhere the user has not answered — `--keep-source`,
 * a bare Enter, a Ctrl-C, or a pipe with nobody at the other end. The leftover
 * file is inert (nothing reads it any more), so the worst case for keeping is an
 * untidy repository; the worst case for deleting unasked is someone's learnings
 * gone from a working tree they were mid-commit on.
 */
async function offerToDeleteSources(
  copied: MigrationEntry[],
  options: { keepSource?: boolean; deleteSource?: boolean },
): Promise<void> {
  if (copied.length === 0) return;

  const one = copied.length === 1;
  const noun = one ? 'the old file' : `all ${copied.length} old files`;
  const keepNote = () => {
    console.log(chalk.gray(`\nThe old ${one ? 'file is' : 'files are'} still in place and no longer read:`));
    for (const entry of copied) console.log(chalk.gray(`  ${displayPath(entry.from)}`));
    console.log(chalk.gray(`  Delete ${one ? 'it' : 'them'} whenever you like, or re-run with --delete-source.`));
  };

  if (options.keepSource) return keepNote();

  if (!options.deleteSource) {
    // No terminal means no one to answer. A prompt here would either hang a
    // CI job or read one byte of unrelated piped input as consent.
    if (!process.stdin.isTTY) return keepNote();

    console.log(chalk.bold(`\nCopied. ${copied.length === 1 ? 'The original' : 'The originals'} can go now:`));
    for (const entry of copied) console.log(chalk.gray(`  ${displayPath(entry.from)}`));
    const yes = await confirmDestructive(chalk.yellow(`Delete ${noun}? [y/N] `));
    if (!yes) return keepNote();
  }

  let deleted = 0;
  for (const entry of copied) {
    try {
      await deleteMigrationSource(entry);
      deleted++;
    } catch (error) {
      console.log(chalk.red(`  could not delete ${displayPath(entry.from)}`));
      console.log(chalk.red(`    ${error instanceof Error ? error.message : String(error)}`));
      process.exitCode = 1;
    }
  }
  if (deleted > 0) {
    console.log(chalk.gray(`\n${deleted} deleted. Commit it: git commit -am "chore: move learnings to the agentuse state dir"`));
  }
}

/**
 * Open the corrections file in the user's editor.
 *
 * The parent directory is created first: an agent that has never captured
 * anything has no file and possibly no project directory yet, and an editor
 * opened on a path inside a missing directory cannot save what the user types.
 *
 * No default editor. Guessing `vi` would drop someone into a modal editor they
 * did not ask for; naming the path instead leaves them able to open it however
 * they like.
 */
async function openInEditor(filePath: string): Promise<void> {
  const editor = process.env.EDITOR || process.env.VISUAL;
  if (!editor) {
    console.error(chalk.red('Set $EDITOR to use --edit. The learnings file is:'));
    console.log(filePath);
    process.exitCode = 1;
    return;
  }

  await mkdir(dirname(filePath), { recursive: true });

  // $EDITOR carries arguments often enough ("code -w", "emacsclient -nw") that
  // splitting on whitespace is the convention. Spawned without a shell, so the
  // file path is never re-parsed by one.
  const [command, ...args] = editor.split(/\s+/).filter(Boolean);
  await new Promise<void>((done, fail) => {
    const child = spawn(command!, [...args, filePath], { stdio: 'inherit' });
    child.on('error', fail);
    child.on('exit', (code) => {
      // The editor's own failure is the command's failure — a non-zero exit here
      // usually means it never opened the file.
      if (code) process.exitCode = code;
      done();
    });
  });
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
    console.log(chalk.green('Nothing to tidy up — every stored learning reaches this agent.'));
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

  // Say which file a change lands in. "merge" and "merge-permanent" are the
  // same shape of edit against very different things: one reorganises a staging
  // buffer nobody reads directly, the other edits the user's own agent file.
  const verbs: Record<ConsolidationChange['kind'], string> = {
    merge: 'merge',
    rewrite: 'rewrite',
    retire: 'retire',
    graduate: 'permanent',
    'merge-permanent': 'agent file, combined',
    'rewrite-permanent': 'agent file, tightened',
    'drop-permanent': 'agent file, removed',
  };
  for (const change of result.changes) {
    console.log(`  ${chalk.bold(verbs[change.kind])}: ${change.titles.join(' + ')}`);
    if (change.why) console.log(chalk.gray(`    ${change.why}`));
  }

  if (result.graduationSkipped) {
    console.log(chalk.yellow(`  Rules were not made permanent: ${result.graduationSkipped}`));
  }

  if (result.diffs.learnings) {
    console.log(chalk.bold('\nLearnings file'));
    printDiff(result.diffs.learnings);
  }
  if (result.diffs.agentFile) {
    console.log(chalk.bold('\nAgent file'));
    printDiff(result.diffs.agentFile);
  }

  // "125 → 50" reads as finished unless we point out that 50 is still 40 over —
  // and then immediately account for the 50, because a press now runs until it
  // stops paying, so what is left is usually left on merit.
  if (result.remaining) {
    const over = result.remaining.active - result.remaining.cap;
    console.log(chalk.yellow(
      result.remaining.moreToDo
        ? `\n  Still ${over} over the cap, and there is more it can do. Run tidy again to keep going.`
        : `\n  Still ${over} over the cap, and that is as far as tidying up can take it. The rest are still there for a reason:`,
    ));
    for (const reason of result.remaining.reasons) {
      console.log(chalk.gray(`    ${reason.count} ${reason.because}`));
    }
    if (result.remaining.graduationWait) console.log(chalk.gray(`\n  ${result.remaining.graduationWait}`));
  }

  if (!dryRun && result.undoId) {
    console.log(chalk.gray('\nUndo: agentuse learnings undo <agent-file>'));
  }
}

export function createLearningsCommand(): Command {
  const command = new Command('learnings')
    .description("Inspect and tidy an agent's stored learnings")
    .argument('<agent-file>', 'Path to the .agentuse file')
    .option('-j, --json', 'Output as JSON')
    .option('--path', 'Print the path of the learnings file and exit')
    .option('--edit', 'Open the learnings file in $EDITOR')
    .action(async (agentFileArg: string, options: { json?: boolean; path?: boolean; edit?: boolean }) => {
      const loaded = await loadAgent(agentFileArg);
      if (!loaded) return;
      const { agent, agentFilePath, stateRoot } = loaded;

      const store = LearningStore.fromAgentFile(agentFilePath, stateRoot, agent.name);

      // Both of these answer "where is it now that it is no longer next to my
      // agent file", so they come before the file is read: they must work for an
      // agent that has never captured a correction.
      if (options.path) {
        console.log(store.filePath);
        return;
      }
      if (options.edit) {
        await openInEditor(store.filePath);
        return;
      }

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
        console.log(chalk.gray(`No learnings stored yet (${store.filePath})`));
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
        console.log(chalk.yellow(`\n${dormant.length} learning${dormant.length === 1 ? '' : 's'} never reach this agent: only the top ${cap} apply per run.`));
        console.log(chalk.gray(`Fix: agentuse learnings tidy ${agentFileArg}`));
      }
    });

  command
    .command('tidy')
    .description('Merge, sharpen, retire and make permanent, until every learning counts')
    .argument('<agent-file>', 'Path to the .agentuse file')
    .option('--dry-run', 'Show the plan and both diffs without writing anything')
    .option('--model <model>', "Plan with this model instead of the agent's own")
    .action(async (agentFileArg: string, options: { dryRun?: boolean; model?: string }) => {
      const loaded = await loadAgent(agentFileArg);
      if (!loaded) return;
      const { agent, agentFilePath, stateRoot } = loaded;

      // A pass over a large file is minutes of model work. Say what it is doing
      // while it does it, or the command looks hung.
      const startedAt = Date.now();
      const result = await consolidateLearnings({
        agentFilePath,
        agentInstructions: agent.instructions,
        agentModel: agent.config.model,
        config: agent.config.learning,
        stateRoot,
        onProgress: (progress) => {
          // One line per phase, not per unit: the writes finish out of order
          // (they run concurrently), so counting them up in a terminal would
          // scroll a column of near-identical lines.
          // The pass number leads: a second round repeats the same two lines,
          // and without it the command looks like it is going in circles.
          const pass = progress.round > 1 ? `pass ${progress.round}: ` : '';
          if (progress.phase === 'deciding' && progress.step === 0) {
            console.log(chalk.gray(`  ${pass}reading ${progress.projectedActive} learnings to see what repeats…`));
          } else if (progress.phase === 'writing' && progress.step === 0 && progress.total > 0) {
            console.log(chalk.gray(`  ${pass}rewriting ${progress.total} rule${progress.total === 1 ? '' : 's'}…`));
          } else if (progress.phase === 'applying' && !options.dryRun) {
            console.log(chalk.gray('  writing both files…'));
          }
        },
        ...(options.dryRun ? { dryRun: true } : {}),
        ...(options.model ? { model: options.model } : {}),
      });
      printResult(result, Boolean(options.dryRun));

      // Remember the pass for the web UI, so a tidy-up run from the terminal is
      // still reviewable and undoable from the browser. Same record either way:
      // one agent has one last tidy-up, whoever ran it.
      if (!options.dryRun && result.undoId) {
        await writeTidyRecord(stateRoot, agentFilePath, {
          jobId: `cli-${result.undoId}`,
          agentFilePath,
          startedAt,
          finishedAt: Date.now(),
          result,
        }).catch(() => {});
      }
    });

  command
    .command('undo')
    .description('Restore both files to their state before the last tidy-up')
    .argument('<agent-file>', 'Path to the .agentuse file')
    .action(async (agentFileArg: string) => {
      // Undo is the recovery path for a failed rewrite, so it must not require
      // the file it is about to restore to parse successfully.
      const agentFilePath = resolve(process.cwd(), agentFileArg);
      if (!existsSync(agentFilePath)) {
        console.error(chalk.red(`Agent file not found: ${agentFilePath}`));
        process.exitCode = 1;
        return;
      }
      const { stateRoot } = resolveProjectContext(process.cwd(), { agentFilePath });

      const restored = await undoConsolidation(stateRoot, agentFilePath);
      if (!restored) {
        console.log(chalk.yellow('Nothing to undo — no tidy-up has been applied to this agent.'));
        return;
      }
      await clearTidyRecord(stateRoot, agentFilePath);
      console.log(chalk.green('Restored:'));
      for (const path of restored.restored) console.log(chalk.gray(`  ${path}`));
    });

  command
    .command('migrate')
    .description('Copy learnings files into the AgentUse state directory, then offer to delete the originals')
    .argument('[agent-file]', 'Path to the .agentuse file (omit and pass --all for every agent)')
    .option('--all', 'Every agent file in the project')
    .option('--dry-run', 'Report what would move without writing anything')
    .option('--keep-source', 'Keep the old files without asking')
    .option('--delete-source', 'Delete the old files without asking')
    .action(async (
      agentFileArg: string | undefined,
      options: { all?: boolean; dryRun?: boolean; keepSource?: boolean; deleteSource?: boolean },
    ) => {
      if (Boolean(agentFileArg) === Boolean(options.all)) {
        console.error(chalk.red('Name one agent file, or pass --all — not both, not neither.'));
        process.exitCode = 1;
        return;
      }
      if (options.keepSource && options.deleteSource) {
        console.error(chalk.red('--keep-source and --delete-source say opposite things. Pick one.'));
        process.exitCode = 1;
        return;
      }

      const cwd = process.cwd();
      const { projectRoot } = resolveProjectContext(cwd);

      let agentFiles: string[] = [];
      if (agentFileArg) {
        const agentFilePath = resolve(cwd, agentFileArg);
        if (!existsSync(agentFilePath)) {
          console.error(chalk.red(`Agent file not found: ${agentFilePath}`));
          process.exitCode = 1;
          return;
        }
        agentFiles = [agentFilePath];
      } else {
        agentFiles = await findAgentFiles(projectRoot);
        // Say which root was searched. "0 moved" from the wrong directory is
        // indistinguishable from "already migrated" otherwise.
        if (agentFiles.length === 0) {
          console.log(chalk.gray(`No agent files under ${projectRoot}`));
        }
      }

      const entries = await planLearningMigration(agentFiles, cwd);
      const movable = entries.filter((e) => e.status === 'ready');
      // Copied by an earlier run whose source was kept. Running this command
      // twice has to be safe, so these are reported and then join the delete
      // offer rather than being refused as conflicts with themselves.
      const alreadyCopied = entries.filter((e) => e.status === 'already-copied');
      const refused = entries.filter((e) => e.status === 'collision');
      const untouched = entries.length - movable.length - alreadyCopied.length - refused.length;

      const dryRun = Boolean(options.dryRun);
      const failures: { entry: MigrationEntry; detail: string }[] = [];
      const copied: MigrationEntry[] = [];

      for (const entry of movable) {
        if (dryRun) {
          printMigration(chalk.cyan('would copy'), entry);
          continue;
        }
        try {
          await applyLearningMigration(entry);
          copied.push(entry);
          printMigration(chalk.green('copied'), entry);
        } catch (error) {
          const detail = error instanceof Error ? error.message : String(error);
          failures.push({ entry, detail });
          printMigration(chalk.red('failed'), entry);
          console.log(chalk.red(`    ${detail}`));
        }
      }

      for (const entry of alreadyCopied) {
        printMigration(chalk.gray('already copied'), entry);
        if (!dryRun) copied.push(entry);
      }

      // Refused, never merged: two sets of corrections for one agent have no
      // authoritative order, and picking one silently would lose the other.
      for (const entry of refused) {
        printMigration(chalk.yellow('refused'), entry);
        console.log(chalk.yellow('    the destination already holds different learnings — inspect both, then delete one'));
      }

      // A corrections file whose agent file is gone. Listed, never touched: the
      // load-time warning cannot fire for it either, so this is the only place
      // it is ever mentioned. Project-wide by nature, so only for --all.
      const orphans = agentFileArg ? [] : await findOrphanedLearningFiles(projectRoot);
      if (orphans.length > 0) {
        console.log(chalk.bold('\nOrphaned, not migrated — no agent file of that name:'));
        for (const orphan of orphans) console.log(chalk.gray(`  ${displayPath(orphan)}`));
        console.log(chalk.gray('  Rename them back beside their agent to migrate, or delete them.'));
      }

      const summary = [
        dryRun ? `${movable.length} to copy` : `${copied.length - alreadyCopied.length} copied`,
        ...(alreadyCopied.length > 0 ? [`${alreadyCopied.length} already copied`] : []),
        ...(refused.length > 0 ? [`${refused.length} refused`] : []),
        ...(failures.length > 0 ? [`${failures.length} failed`] : []),
        ...(untouched > 0 ? [`${untouched} with nothing to move`] : []),
        ...(orphans.length > 0 ? [`${orphans.length} orphaned`] : []),
      ].join(', ');
      console.log(`\n${summary}.`);

      // The copies are safe on disk; only now is deleting the originals on the
      // table. Asked last and asked once, because the answer is the same for
      // every file and nobody wants fifty prompts.
      await offerToDeleteSources(copied, options);

      // Nothing to migrate is a fine outcome. A refusal or a failed write is not:
      // in both cases learnings are still sitting where nothing will read them.
      if (refused.length > 0 || failures.length > 0) process.exitCode = 1;
    });

  return command;
}
