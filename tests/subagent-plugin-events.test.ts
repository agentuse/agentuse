import { describe, expect, it, spyOn } from 'bun:test';
import fs from 'fs/promises';
import os from 'os';
import path from 'path';
import { PluginManager } from '../src/plugin';
import { resetProviderPluginCache } from '../src/plugin/provider-runtime';
import * as runner from '../src/runner';
import { createSubAgentTool } from '../src/subagent';

describe('delegated agent plugin enforcement', () => {
  it('propagates tool policy and emits delegated lifecycle events', async () => {
    const root = await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-subagent-plugin-'));
    const installed = path.join(root, 'installed');
    const loose = path.join(root, 'loose');
    const agentPath = path.join(root, 'child.agentuse');
    const oldHome = process.env.AGENTUSE_PLUGIN_HOME;
    await Promise.all([fs.mkdir(installed), fs.mkdir(loose)]);
    await fs.writeFile(agentPath, `---\nname: child\nmodel: demo:test\n---\n\nDo the delegated work.\n`);
    process.env.AGENTUSE_PLUGIN_HOME = installed;
    resetProviderPluginCache();

    const lifecycle: string[] = [];
    let policyResult: unknown;
    const core = spyOn(runner, 'executeAgentCore').mockImplementation((async function* (
      _agent: unknown,
      _tools: unknown,
      options: any,
    ) {
      policyResult = await options.pluginEvents?.toolCall?.({
        toolCallId: 'danger-1',
        toolName: 'dangerous_write',
        input: { target: 'outside-policy' },
      });
      yield { type: 'text', text: 'raw delegated output' };
      yield {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
      };
    }) as any);

    try {
      const manager = new PluginManager();
      await manager.loadPlugins([loose], root);
      await manager.host.activate({ name: 'policy', source: 'test', scope: 'local' }, (agentuse) => {
        agentuse.on('agent:start', (event) => { lifecycle.push(`start:${event.agent.name}`); });
        agentuse.on('tool:call', () => {
          lifecycle.push('tool:call');
          return { block: true, reason: 'project policy' };
        });
        agentuse.on('agent:complete', (event) => {
          lifecycle.push(`complete:${event.isSubAgent}`);
          return { text: `transformed: ${event.result.text}` };
        });
      });

      const tool = await createSubAgentTool(
        agentPath,
        undefined,
        root,
        undefined,
        0,
        [],
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        manager,
      );
      const result = await (tool.execute as any)({}, { toolCallId: 'subagent-1', messages: [] });

      expect(policyResult).toEqual({ block: true, reason: 'project policy' });
      expect(lifecycle).toEqual(['start:child', 'tool:call', 'complete:true']);
      expect(result.output).toBe('transformed: raw delegated output');
    } finally {
      core.mockRestore();
      if (oldHome === undefined) delete process.env.AGENTUSE_PLUGIN_HOME;
      else process.env.AGENTUSE_PLUGIN_HOME = oldHome;
      resetProviderPluginCache();
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
