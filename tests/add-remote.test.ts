import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import * as realChildProcess from 'child_process';
import { cpSync, mkdirSync, writeFileSync } from 'fs';
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';

// Stand-in for `git clone`: copies the fixture repo into the clone target, so
// remote sources are exercised without the network.
let fixtureRepo = '';
mock.module('child_process', () => ({
  ...realChildProcess,
  execFileSync: (command: string, args: string[], options?: realChildProcess.ExecFileSyncOptions) => {
    if (command !== 'git') return realChildProcess.execFileSync(command, args, options);
    const target = args[args.length - 1];
    cpSync(fixtureRepo, target, { recursive: true });
    mkdirSync(join(target, '.git'), { recursive: true });
    writeFileSync(join(target, '.git', 'HEAD'), 'ref: refs/heads/main\n');
    return '';
  },
}));

const { add } = await import('../src/cli/add');

describe('agentuse add from a remote repo', () => {
  let projectDir: string;

  beforeEach(async () => {
    projectDir = await mkdtemp(join(tmpdir(), 'add-remote-project-'));
    fixtureRepo = await mkdtemp(join(tmpdir(), 'add-remote-repo-'));
  });

  afterEach(async () => {
    await rm(projectDir, { recursive: true, force: true });
    await rm(fixtureRepo, { recursive: true, force: true });
  });

  it('installs a repo-root SKILL.md under the repo name without touching other skills', async () => {
    await writeFile(join(fixtureRepo, 'SKILL.md'), '---\nname: rootskill\ndescription: Root skill\n---\n# Root');
    const skillsRoot = join(projectDir, '.agentuse', 'skills');
    for (const name of ['existing-a', 'existing-b']) {
      await mkdir(join(skillsRoot, name), { recursive: true });
      await writeFile(join(skillsRoot, name, 'SKILL.md'), `---\nname: ${name}\n---`);
    }

    const result = await add('someone/rootskill', projectDir, { force: true });

    expect(result.skills).toEqual([{ name: 'rootskill', action: 'added' }]);
    expect((await readdir(skillsRoot)).sort()).toEqual(['existing-a', 'existing-b', 'rootskill']);
    expect(existsSync(join(skillsRoot, 'rootskill', 'SKILL.md'))).toBe(true);
    expect(existsSync(join(skillsRoot, 'rootskill', '.git'))).toBe(false);
  });
});
