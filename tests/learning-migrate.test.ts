import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { existsSync } from 'fs';
import { mkdir, mkdtemp, readdir, readFile, realpath, rm, writeFile } from 'fs/promises';
import { basename, dirname, join } from 'path';
import { tmpdir } from 'os';
import { createLearningsCommand } from '../src/cli/learnings';
import {
  findAgentFiles,
  findOrphanedLearningFiles,
  legacyLearningFilePath,
  planLearningMigration,
} from '../src/learning/migrate';
import { resolveLearningFilePath } from '../src/learning/store';

/**
 * `agentuse learnings migrate` — the only route from the pre-0.17 sibling
 * corrections file to the keyed one in the state directory.
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
  const spies: ReturnType<typeof spyOn>[] = [];

  beforeEach(async () => {
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

  it('moves the corrections file into the state directory by default', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', '# Learnings for blog\n');

    const output = await runMigrate(['agents/blog.agentuse']);

    expect(await readFile(destination, 'utf-8')).toBe('# Learnings for blog\n');
    // A move, not a copy: the source is dead weight and leaving it behind keeps
    // the file churning in the user's repository.
    expect(existsSync(legacy)).toBe(false);
    expect(output).toContain('moved');
    expect(output).toContain('1 moved');
    expect(process.exitCode).toBeFalsy();
  });

  it('copies rather than moves with --keep-source', async () => {
    const { legacy, destination } = await writeAgent('agents/blog.agentuse', 'keep me\n');

    const output = await runMigrate(['agents/blog.agentuse', '--keep-source']);

    expect(await readFile(destination, 'utf-8')).toBe('keep me\n');
    expect(await readFile(legacy, 'utf-8')).toBe('keep me\n');
    expect(output).toContain('copied');
    expect(process.exitCode).toBeFalsy();
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

    expect(output).toContain('would move');
    expect(output).toContain('1 to move');
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
    expect(output).toContain('the destination already holds corrections');
    expect(output).not.toContain('1 moved');
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
    expect(existsSync(blog.legacy)).toBe(false);
    expect(existsSync(news.legacy)).toBe(false);

    // An agent that never captured anything is counted, not moved.
    expect(existsSync(bare.destination)).toBe(false);
    expect(output).toContain('2 moved');
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
    expect(output).toContain('2 moved');
  });

  it('reports orphans only for --all, where a project-wide scan makes sense', async () => {
    await writeAgent('agents/blog.agentuse', 'still here\n');
    await writeFile(join(projectDir, 'agents', 'renamed-away.agentuse.learnings.md'), 'stranded\n');

    const output = await runMigrate(['agents/blog.agentuse']);

    expect(output).not.toContain('Orphaned');
    expect(output).toContain('1 moved');
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
