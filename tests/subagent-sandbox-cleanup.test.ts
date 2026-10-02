import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import * as models from '../src/models';
import * as sandbox from '../src/sandbox';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session/manager';
import { createSubAgentTool } from '../src/subagent';

// A delegated child creates its own sandbox. Every delegated call must stop it
// when the child finishes, or containers pile up for the life of the worker.

const priorEnv = { dataHome: process.env.XDG_DATA_HOME, codeMode: process.env.AGENTUSE_CODE_MODE };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-subagent-sandbox-'));
  process.env.XDG_DATA_HOME = join(root, 'data');
  process.env.AGENTUSE_CODE_MODE = '0';
  await initStorage(root);
});

afterEach(async () => {
  if (priorEnv.dataHome === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = priorEnv.dataHome;
  if (priorEnv.codeMode === undefined) delete process.env.AGENTUSE_CODE_MODE;
  else process.env.AGENTUSE_CODE_MODE = priorEnv.codeMode;
  await rm(root, { recursive: true, force: true });
});

describe('delegated child sandbox', () => {
  it('is stopped once when the child finishes', async () => {
    const childPath = join(root, 'agents', 'builder.agentuse');
    await mkdir(join(root, 'agents'), { recursive: true });
    await writeFile(childPath, '---\nmodel: demo:test\nintent: false\nsandbox: true\nskills:\n  auto: false\n---\nBuild it.');
    const projectContext = { projectRoot: root, stateRoot: root, cwd: root };

    let created = 0;
    let killed = 0;
    const allocation = spyOn(sandbox, 'createSandbox').mockImplementation(async () => {
      created++;
      return { container: { id: 'child-sandbox-double' }, kill: async () => { killed++; } } as never;
    });
    const sandboxTools = spyOn(sandbox, 'createSandboxTools').mockReturnValue({});
    const model = new MockLanguageModelV3({ doStream: async () => ({ stream: convertArrayToReadableStream([
      { type: 'stream-start', warnings: [] },
      { type: 'tool-call', toolCallId: 'outcome', toolName: 'report_outcome',
        input: JSON.stringify({ status: 'complete', headline: 'Built.', artifacts: [] }) },
      { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
        usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
    ] as never) }) });
    const modelFactory = spyOn(models, 'createModel').mockResolvedValue(model as never);
    try {
      const manager = new SessionManager();
      const parentId = await manager.createSession({
        agent: { id: 'manager', name: 'Manager', isSubAgent: false },
        model: 'demo:test', version: 'test', config: {}, project: { root, cwd: root },
      });
      const tool = await createSubAgentTool(childPath, 3, undefined, undefined, 0, [], manager, parentId, 'manager', projectContext);
      await tool.execute?.({}, {} as never);

      expect(created).toBe(1);
      expect(killed).toBe(1);
    } finally {
      allocation.mockRestore();
      sandboxTools.mockRestore();
      modelFactory.mockRestore();
    }
  });
});
