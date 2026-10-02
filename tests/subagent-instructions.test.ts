import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockLanguageModelV3, convertArrayToReadableStream } from 'ai/test';
import * as models from '../src/models';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session/manager';
import { parseAgent } from '../src/parser';
import { createSubAgentTool } from '../src/subagent';
import { prepareAgentExecution } from '../src/runner/preparation';

// A delegated child must get the same instruction assembly as the same agent
// run directly: preloaded skills, resolved ${agentDir}, and so on.

const priorEnv = { dataHome: process.env.XDG_DATA_HOME, codeMode: process.env.AGENTUSE_CODE_MODE };
let root: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-subagent-instructions-'));
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

describe('delegated child instructions', () => {
  it('match a direct run of the same agent, including preloaded skills', async () => {
    const skillDir = join(root, '.agentuse', 'skills', 'house-style');
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, 'SKILL.md'), '---\nname: house-style\ndescription: House style\n---\n\n# House Style Rules');
    const childPath = join(root, 'agents', 'writer.agentuse');
    await mkdir(join(root, 'agents'), { recursive: true });
    await writeFile(childPath, '---\nmodel: demo:test\nintent: false\nskills: [house-style]\n---\nRead ${agentDir}/brief.md and write.');
    const projectContext = { projectRoot: root, stateRoot: root, cwd: root };

    const direct = await prepareAgentExecution({ agent: await parseAgent(childPath), mcpClients: [], agentFilePath: childPath, projectContext });
    await direct.cleanup();
    expect(direct.userMessage).toContain('# House Style Rules');
    expect(direct.userMessage).toContain(`Read ${join(root, 'agents')}/brief.md`);

    const prompts: string[] = [];
    const model = new MockLanguageModelV3({ doStream: async (options) => {
      prompts.push(JSON.stringify(options.prompt));
      return { stream: convertArrayToReadableStream([
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: 'outcome', toolName: 'report_outcome',
          input: JSON.stringify({ status: 'complete', headline: 'Written.', artifacts: [] }) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool-calls' },
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 1, text: 1, reasoning: 0 } } },
      ] as never) };
    } });
    const modelFactory = spyOn(models, 'createModel').mockResolvedValue(model as never);
    try {
      const manager = new SessionManager();
      const parentId = await manager.createSession({
        agent: { id: 'manager', name: 'Manager', isSubAgent: false },
        model: 'demo:test', version: 'test', config: {}, project: { root, cwd: root },
      });
      const tool = await createSubAgentTool(childPath, 3, undefined, undefined, 0, [], manager, parentId, 'manager', projectContext);
      await tool.execute?.({}, {} as never);

      const [child] = await manager.listChildSessions(parentId);
      const message = await manager.getPrimaryMessage(child!.session.id, child!.session.agent.id);
      expect(message?.user.prompt.task).toBe(direct.userMessage);
      expect(prompts[0]).toContain('# House Style Rules');
    } finally {
      modelFactory.mockRestore();
    }
  });
});
