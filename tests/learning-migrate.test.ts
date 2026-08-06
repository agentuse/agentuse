import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { PassThrough } from 'stream';
import { createLearningsCommand } from '../src/cli/learnings';
import {
  deleteMigrationSource,
  findAgentFiles,
  findOrphanedLearningFiles,
  legacyLearningFilePath,
  planLearningMigration,
} from '../src/learning/migrate';
import { resolveLearningFilePath } from '../src/learning/store';

/**
 * `agentuse learnings migrate` — the only route from the pre-0.17 sibling
 * learnings file to the keyed one in the state directory.
 *
 * The migration is deliberately two halves: it always COPIES, and only deletes
 * the original once the user has said so. Most of what is asserted below is that
 * second half staying shut — a surprise deletion out of someone's repository is
 * the one outcome this command must never produce on its own.
 *
 * The destination contains a sha256 of the project root, so these tests always
 * resolve it through {@link resolveLearningFilePath} rather than spelling it
 * out; what is being asserted is which bytes end up where, not the digest.
 *
 * `$XDG_DATA_HOME` points at a temp directory so the state directory is
 * per-test, and the project is a second temp directory carrying a
 * `package.json` marker so `findProjectRoot` anchors exactly there instead of
 * walking up out of `/tmp`.
 */

/** Chalk emits escapes when a test runner happens to look like a TTY; the
 *  assertions are about words, not colour. */
function plain(text: string): string {
  return text.replace(/\[[0-9;]*m/g, '');
}

describe('agentuse learnings migrate', () => {
  let projectDir: string;
  let stateDir: string;
  let originalCwd: string;
  let originalXdg: string | undefined;
  let originalIsTTY: boolean | undefined;
  const spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
    // Whether stdin is a terminal decides whether the command asks about
    // deleting. Pinned to false so the suite behaves the same run from a
    // terminal as from CI — otherwise these tests hang on a prompt locally and
    // pass on the build machine.
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', { value: false, configurable: true });

    projectDir = await realpath(await mkdtemp(join(tmpdir(), 'learning-migrate-project-')));
    stateDir = await realpath(await mkdtemp(join(tmpdir(), 'learning-migrate-state-')));
    originalCwd = process.cwd();
    originalXdg = process.env.XDG_DATA_HOME;
    process.env.XDG_DATA_HOME = stateDir;

    // The project marker. Without it the upward walk leaves the temp directory
    // and every agent would resolve against some ancestor of /tmp.
    await writeFile(join(projectDir, 'package.json'), '{"name":"migrate-fixture"}\n');
    process.chdir(projectDir);
    // Zero, not `undefined`: Bun ignores an assignment of `undefined` here, so
    // a refusal in one test would still be set when the next one asserts.
    process.exitCode = 0;
  });

  afterEach(async () => {
    for (const spy of spies.splice(0)) spy.mockRestore();
    Object.defineProperty(process.stdin, 'isTTY', { value: originalIsTTY, configurable: true });
    process.chdir(originalCwd);
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    // The command reports refusals through the exit code; leaving it set would
    // fail the whole test file.
    process.exitCode = 0;
    await rm(projectDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  });

  /** An agent file, plus the corrections file that used to sit beside it.
   *  Content is deliberately not valid frontmatter: migrate never parses an
   *  agent file, which is what lets it run on a repo whose agent files no
   *  longer parse. */
  async function writeAgent(
    relativePath: string,
    corrections?: string,
  ): Promise<{ agent: string; legacy: string; destination: string }> {
    const agent = join(projectDir, relativePath);
    await mkdir(dirname(agent), { recursive: true });
    await writeFile(agent, '# agent\n');

    // `x.agentuse` paired with `x.agentuse.learnings.md` before 0.17.
    const legacy = `${agent}.learnings.md`;
    if (corrections !== undefined) await writeFile(legacy, corrections);

    return { agent, legacy, destination: resolveLearningFilePath(agent, projectDir) };
  }

  async function runMigrate(args: string[]): Promise<string> {
    const output: string[] = [];
    const record = (value: unknown = '') => { output.push(String(value)); };
    spies.push(spyOn(console, 'log').mockImplementation(record));
    spies.push(spyOn(console, 'error').mockImplementation(record));

    const command = createLearningsCommand();
    await command.parseAsync(['migrate', ...args], { from: 'user' });

    for (const spy of spies.splice(0)) spy.mockRestore();
    return plain(output.join('\n'));
  }

  it('names the pre-0.17 sibling that migration reads from', async () => {
    // Pinned because nothing else in the tree resolves this shape any more: get
    // it wrong and migrate silently reports "nothing to move" forever.
    expect(legacyLearningFilePath(join(projectDir, 'agents', 'blog.agentuse')))
      .toBe(join(projectDir, 'agents', 'blog.agentuse.learnings.md'));
    // The rarer `.md` agent, whose sibling dropped the extension.
    expect(legacyLearningFilePath(join(projectDir, 'agents', 'blog.md')))
      .toBe(join(projectDir, 'agents', 'blog.learnings.md'));
  });

  it('copies into the state directory and never deletes unasked', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', '# Learnings for blog\n');

    const output = await runMigrate(['agents/blog.agentuse']);

    expect(await readFile(destination, 'utf-8')).toBe('# Learnings for blog\n');
    // The heart of it. Nobody answered a prompt, so the user's file is still
    // exactly where they left it — no surprise deletion, no dirty working tree.
    expect(await readFile(legacy, 'utf-8')).toBe('# Learnings for blog\n');
    expect(output).toContain('1 copied');
    // And it says so, with the way to finish the job later. Silence here would
    // leave a file nothing reads and nothing mentions.
    expect(output).toContain('still in place and no longer read');
    expect(output).toContain('--delete-source');
    expect(process.exitCode).toBeFalsy();
  });

  it('keeps the original without asking under --keep-source', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', 'keep me\n');

    const output = await runMigrate(['agents/blog.agentuse', '--keep-source']);

    expect(await readFile(destination, 'utf-8')).toBe('keep me\n');
    expect(await readFile(legacy, 'utf-8')).toBe('keep me\n');
    expect(output).toContain('copied');
    expect(process.exitCode).toBeFalsy();
  });

  it('deletes the original under --delete-source, the way a script asks for it', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', 'move me\n');

    const output = await runMigrate(['agents/blog.agentuse', '--delete-source']);

    // The copy landed first, which is the only reason deleting is safe.
    expect(await readFile(destination, 'utf-8')).toBe('move me\n');
    expect(existsSync(legacy)).toBe(false);
    expect(output).toContain('1 copied');
    expect(output).toContain('1 deleted');
    expect(process.exitCode).toBeFalsy();
  });

  it('is safe to run twice, and the second run still offers to clean up', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', 'twice\n');

    // First run copies and, with nobody to answer, keeps the source.
    await runMigrate(['agents/blog.agentuse']);
    expect(await readFile(legacy, 'utf-8')).toBe('twice\n');

    const second = await runMigrate(['agents/blog.agentuse']);

    // The file it wrote itself must not come back as an unresolvable conflict:
    // that would make "run migrate again" a dead end and exit non-zero for a
    // repository in a perfectly correct state.
    expect(second).toContain('already copied');
    expect(second).not.toContain('refused');
    expect(process.exitCode).toBeFalsy();
    // And the offer to finish the job is still open.
    expect(second).toContain('still in place and no longer read');

    const third = await runMigrate(['agents/blog.agentuse', '--delete-source']);
    expect(third).toContain('1 deleted');
    expect(existsSync(legacy)).toBe(false);
    expect(await readFile(destination, 'utf-8')).toBe('twice\n');
  });

  it('still refuses when the destination holds genuinely different learnings', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', 'from the repo\n');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'a different set\n');

    const output = await runMigrate(['agents/blog.agentuse']);

    // Same-bytes is a resumed migration; different bytes is two histories for
    // one agent, and nothing here is entitled to pick a winner.
    expect(output).toContain('refused');
    expect(output).not.toContain('already copied');
    expect(await readFile(legacy, 'utf-8')).toBe('from the repo\n');
    expect(await readFile(destination, 'utf-8')).toBe('a different set\n');
    expect(process.exitCode).toBe(1);
  });

  it('refuses two flags that say opposite things rather than picking one', async () => {
    const { legacy } = await writeAgent('agents/blog.agentuse', 'ambiguous\n');

    const output = await runMigrate(['agents/blog.agentuse', '--keep-source', '--delete-source']);

    // Guessing which one the user meant risks guessing "delete".
    expect(output).toContain('Pick one');
    expect(await readFile(legacy, 'utf-8')).toBe('ambiguous\n');
    expect(process.exitCode).toBe(1);
  });

  /**
   * Run with a terminal attached and `answer` already typed into it.
   *
   * A real stream through the real `readline` rather than a stubbed prompt: the
   * question being asked at all is the feature, so a test that fakes the asking
   * would pass on a build that never asks. `PassThrough` buffers while paused,
   * so writing the answer before the command reaches the prompt is safe.
   */
  async function runMigrateAnswering(answer: string, args: string[]): Promise<string> {
    const fakeStdin = new PassThrough();
    Object.defineProperty(fakeStdin, 'isTTY', { value: true, configurable: true });
    const realStdin = process.stdin;
    Object.defineProperty(process, 'stdin', { value: fakeStdin, configurable: true });
    fakeStdin.write(`${answer}\n`);
    try {
      return await runMigrate(args);
    } finally {
      Object.defineProperty(process, 'stdin', { value: realStdin, configurable: true });
    }
  }

  it('takes no for an answer at the prompt, and still says where the file is', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', 'declined\n');

    const output = await runMigrateAnswering('n', ['agents/blog.agentuse']);

    expect(await readFile(destination, 'utf-8')).toBe('declined\n');
    expect(await readFile(legacy, 'utf-8')).toBe('declined\n');
    // A declined prompt that then goes quiet is how a stranded file gets
    // forgotten, so "no" still owes the user the path.
    expect(output).toContain('still in place and no longer read');
    expect(process.exitCode).toBeFalsy();
  });

  it('deletes at the prompt only on an explicit yes', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', 'accepted\n');

    const output = await runMigrateAnswering('y', ['agents/blog.agentuse']);

    expect(await readFile(destination, 'utf-8')).toBe('accepted\n');
    expect(existsSync(legacy)).toBe(false);
    expect(output).toContain('1 deleted');
    expect(process.exitCode).toBeFalsy();
  });

  it('treats a bare Enter as no, because the default must never be deletion', async () => {
    const { legacy } = await writeAgent('agents/blog.agentuse', 'reflex\n');

    // Someone clearing prompts on autopilot should end up with their file.
    const output = await runMigrateAnswering('', ['agents/blog.agentuse']);

    expect(await readFile(legacy, 'utf-8')).toBe('reflex\n');
    expect(output).not.toContain('deleted');
  });

  it('will not delete a source whose copy is not on disk', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', 'unique\n');

    // The guard is the last thing between a bookkeeping slip and lost learnings,
    // so it re-checks the destination instead of trusting the caller.
    let failure: unknown;
    await deleteMigrationSource({
      agentFilePath: 'agents/blog.agentuse', from: legacy, to: destination, status: 'ready',
    }).catch((error: unknown) => { failure = error; });

    expect((failure as Error | undefined)?.message).toContain('nothing was copied');
    expect(await readFile(legacy, 'utf-8')).toBe('unique\n');
  });

  it('writes nothing at all under --dry-run, and still names the collisions it would refuse', async () => {
    const ready = await writeAgent('agents/blog.agentuse', 'ready\n');
    const clash = await writeAgent('agents/news.agentuse', 'source side\n');
    await mkdir(dirname(clash.destination), { recursive: true });
    await writeFile(clash.destination, 'destination side\n');

    const output = await runMigrate(['--all', '--dry-run']);

    // Nothing written: no destination created, no source removed, no byte of an
    // existing destination touched. The whole learnings directory is listed
    // rather than probing one path, so a stray write anywhere in it is caught.
    expect(await readdir(dirname(ready.destination))).toEqual([basename(clash.destination)]);
    expect(existsSync(ready.destination)).toBe(false);
    expect(await readFile(ready.legacy, 'utf-8')).toBe('ready\n');
    expect(await readFile(clash.legacy, 'utf-8')).toBe('source side\n');
    expect(await readFile(clash.destination, 'utf-8')).toBe('destination side\n');

    expect(output).toContain('would copy');
    expect(output).toContain('1 to copy');
    // A collision is a real problem whether or not this was a rehearsal, so the
    // dry run has to say so rather than reporting a clean plan.
    expect(output).toContain('refused');
    expect(output).toContain('agents/news.agentuse.learnings.md');
    expect(output).toContain('1 refused');
    expect(process.exitCode).toBe(1);
  });

  it('refuses a non-empty destination instead of merging or overwriting it', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', 'from the repo\n');
    await mkdir(dirname(destination), { recursive: true });
    await writeFile(destination, 'already migrated\n');

    const output = await runMigrate(['agents/blog.agentuse']);

    // Two sets of corrections for one agent have no authoritative order, so
    // both survive untouched and the user decides.
    expect(await readFile(destination, 'utf-8')).toBe('already migrated\n');
    expect(await readFile(legacy, 'utf-8')).toBe('from the repo\n');
    expect(output).toContain('refused');
    expect(output).toContain('the destination already holds different learnings');
    expect(output).not.toContain('1 copied');
    expect(process.exitCode).toBe(1);
  });

  it('migrates every agent in the project under --all, keeping same-named agents apart', async () => {
    const blog = await writeAgent('agents/blog/write.agentuse', 'blog corrections\n');
    const news = await writeAgent('agents/news/write.agentuse', 'news corrections\n');
    const bare = await writeAgent('agents/quiet.agentuse');
    const vendored = await writeAgent('node_modules/pkg/agents/vendor.agentuse', 'vendored\n');

    const output = await runMigrate(['--all']);

    // Two agents share a basename; the key is the project-relative path, so
    // they must not land on the same file.
    expect(blog.destination).not.toBe(news.destination);
    expect(await readFile(blog.destination, 'utf-8')).toBe('blog corrections\n');
    expect(await readFile(news.destination, 'utf-8')).toBe('news corrections\n');
    // Both originals survive: --all is still a copy, and fifty files is when a
    // surprise deletion would hurt most.
    expect(await readFile(blog.legacy, 'utf-8')).toBe('blog corrections\n');
    expect(await readFile(news.legacy, 'utf-8')).toBe('news corrections\n');

    // An agent that never captured anything is counted, not moved.
    expect(existsSync(bare.destination)).toBe(false);
    expect(output).toContain('2 copied');
    expect(output).toContain('1 with nothing to move');

    // The walk uses the same exclusions as the agent listing, so a vendored
    // agent file is not the user's to migrate.
    expect(await readFile(vendored.legacy, 'utf-8')).toBe('vendored\n');
    expect(await findAgentFiles(projectDir)).toEqual([blog.agent, news.agent, bare.agent].sort());
  });

  it('lists a corrections file with no agent file as orphaned, and leaves it alone', async () => {
    const kept = await writeAgent('agents/blog.agentuse', 'still here\n');
    // What a `git mv` of the agent file leaves behind: nothing resolves to this
    // sibling any more, so the load-time notice can never fire for it either.
    const orphan = join(projectDir, 'agents', 'renamed-away.agentuse.learnings.md');
    await writeFile(orphan, 'stranded\n');

    const output = await runMigrate(['--all']);

    expect(await readFile(orphan, 'utf-8')).toBe('stranded\n');
    expect(output).toContain('Orphaned, not migrated');
    expect(output).toContain('agents/renamed-away.agentuse.learnings.md');
    expect(output).toContain('1 orphaned');

    // The one real agent still migrated; the orphan neither blocks it nor is
    // confused for it.
    expect(await readFile(kept.destination, 'utf-8')).toBe('still here\n');
    expect(await findOrphanedLearningFiles(projectDir)).toEqual([orphan]);
    // Reporting an orphan is not a failure — there is nothing to fix but the
    // user's memory of what they renamed.
    expect(process.exitCode).toBeFalsy();
  });

  it('walks the whole project under --all even when run from a subdirectory', async () => {
    const top = await writeAgent('top.agentuse', 'top\n');
    const nested = await writeAgent('agents/deep/nested.agentuse', 'nested\n');

    process.chdir(join(projectDir, 'agents', 'deep'));
    const output = await runMigrate(['--all']);

    // `--all` means the project, not the directory you happen to be standing
    // in — otherwise a migration run from `agents/` quietly skips half of them.
    expect(await readFile(top.destination, 'utf-8')).toBe('top\n');
    expect(await readFile(nested.destination, 'utf-8')).toBe('nested\n');
    expect(output).toContain('2 copied');
  });

  it('reports orphans only for --all, where a project-wide scan makes sense', async () => {
    await writeAgent('agents/blog.agentuse', 'still here\n');
    await writeFile(join(projectDir, 'agents', 'renamed-away.agentuse.learnings.md'), 'stranded\n');

    const output = await runMigrate(['agents/blog.agentuse']);

    expect(output).not.toContain('Orphaned');
    expect(output).toContain('1 copied');
  });

  it('classifies each agent before touching anything', async () => {
    const ready = await writeAgent('agents/ready.agentuse', 'move me\n');
    const clash = await writeAgent('agents/clash.agentuse', 'source\n');
    const empty = await writeAgent('agents/empty.agentuse', '   \n');
    const none = await writeAgent('agents/none.agentuse');
    await mkdir(dirname(clash.destination), { recursive: true });
    await writeFile(clash.destination, 'destination\n');

    const plan = await planLearningMigration(
      [ready.agent, clash.agent, empty.agent, none.agent],
      projectDir,
    );

    expect(plan.map((entry) => entry.status)).toEqual([
      'ready',
      'collision',
      // A whitespace-only sibling holds no corrections, so there is nothing to
      // refuse a migration over.
      'nothing-to-move',
      'nothing-to-move',
    ]);
    expect(plan[0]!.from).toBe(ready.legacy);
    expect(plan[0]!.to).toBe(ready.destination);
    // Planning is pure: the sources are all still where they were.
    expect(existsSync(ready.legacy)).toBe(true);
    expect(existsSync(ready.destination)).toBe(false);
  });

  it('resolves the same destination from any working directory', async () => {
    const { agent, destination } = await writeAgent('agents/blog.agentuse', 'anywhere\n');
    const nested = join(projectDir, 'agents', 'blog');
    await mkdir(nested, { recursive: true });

    // The plan is anchored on the agent file's own project, not the cwd, so
    // migrating from a subdirectory writes the file the run will read.
    process.chdir(nested);
    const [entry] = await planLearningMigration([agent], nested);

    expect(entry!.to).toBe(destination);
  });
});
