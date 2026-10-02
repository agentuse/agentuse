import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { parseAgent } from '../src/parser';
import { createSubAgentTools } from '../src/subagent';
import { prepareAgentExecution } from '../src/runner/preparation';

// A configured child is a declared dependency. When one cannot be loaded the
// parent must not run without it while its prompt still names that worker.

const priorDataHome = process.env.XDG_DATA_HOME;
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-subagent-load-'));
  process.env.XDG_DATA_HOME = join(root, 'data');
  await writeFile(join(root, 'worker.agentuse'), '---\nmodel: demo:test\ndescription: Works\n---\nWork.');
});

afterEach(async () => {
  if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = priorDataHome;
  await rm(root, { recursive: true, force: true });
});

describe('sub-agent load failures', () => {
  it('rejects the whole load when one configured child is missing', async () => {
    await expect(createSubAgentTools(
      [{ path: './missing.agentuse', name: 'researcher' }, { path: './worker.agentuse' }],
      root,
    )).rejects.toThrow('File not found');
  });

  it('rejects the whole load when one configured child is invalid', async () => {
    await writeFile(join(root, 'broken.agentuse'), '---\nmodel: demo:test\nmaxSteps: lots\n---\nBroken.');
    await expect(createSubAgentTools([{ path: './worker.agentuse' }, { path: './broken.agentuse' }], root))
      .rejects.toThrow();
  });

  it('fails the run and its session instead of starting a manager without the worker', async () => {
    const managerPath = join(root, 'manager.agentuse');
    await writeFile(managerPath, '---\nmodel: demo:test\ntype: manager\nskills:\n  auto: false\nsubagents:\n  - path: ./missing.agentuse\n    name: researcher\n---\nManage.');
    await initStorage(root);
    const manager = new SessionManager();

    await expect(prepareAgentExecution({
      agent: await parseAgent(managerPath),
      mcpClients: [],
      agentFilePath: managerPath,
      sessionManager: manager,
      projectContext: { projectRoot: root, stateRoot: root, cwd: root },
    })).rejects.toThrow('File not found');
    expect((await manager.listSessionSummaries()).map(s => s.status)).toEqual(['error']);
  });
});
