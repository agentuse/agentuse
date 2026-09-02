import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session/manager';
import { createSubAgentTool } from '../src/subagent';

describe('sub-agent startup observability', () => {
  it('creates and errors the child session when MCP startup fails', async () => {
    const priorDataHome = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-subagent-startup-'));
    process.env.XDG_DATA_HOME = join(projectRoot, 'data');

    try {
      const agentPath = join(projectRoot, 'failing-child.agentuse');
      await writeFile(agentPath, `---
model: openai:gpt-5
mcpServers:
  unavailable:
    command: /definitely/not/a/real/mcp-server
    connectTimeout: 1
---

Attempt the delegated task.
`);

      await initStorage(projectRoot);
      const parentManager = new SessionManager();
      const parentId = await parentManager.createSession({
        agent: { id: 'agents/manager', name: 'Manager', isSubAgent: false },
        model: 'openai:gpt-5',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot },
      });

      const tool = await createSubAgentTool(
        agentPath,
        10,
        projectRoot,
        undefined,
        0,
        [],
        parentManager,
        parentId,
        'agents/manager',
        { projectRoot, stateRoot: projectRoot, cwd: projectRoot },
      );
      const result = await tool.execute?.({ task: 'Run the failing child' }, {} as never) as { output?: string };

      expect(result.output).toContain('All MCP servers failed to connect');
      const children = await parentManager.listChildSessions(parentId);
      expect(children).toHaveLength(1);
      expect(children[0]?.session).toMatchObject({
        parentSessionID: parentId,
        status: 'error',
        error: { code: 'EXECUTION_ERROR', message: 'All MCP servers failed to connect' },
      });
    } finally {
      if (priorDataHome === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = priorDataHome;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
