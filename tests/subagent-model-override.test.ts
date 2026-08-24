import { describe, expect, it, spyOn } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseAgentContent, type ParsedAgent } from '../src/parser';
import { prepareAgentExecution } from '../src/runner/preparation';
import * as subagents from '../src/subagent';
import { applyRunModelOverride, type RunModelOverride } from '../src/utils/model-alias';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

const fixtures = path.resolve(__dirname, '__fixtures__/approval');
const parentPath = path.resolve(fixtures, 'parent.agentuse');

function parentAgent(): ParsedAgent {
  return {
    name: 'parent',
    instructions: 'Delegate.',
    config: {
      model: 'anthropic:parent-model',
      subagents: [{ path: './sub-plain.agentuse', name: 'child' }],
    },
  };
}

function runOverride(): RunModelOverride {
  return {
    requested: '@run-policy',
    resolved: {
      model: 'anthropic:override-primary',
      alias: '@run-policy',
      source: 'user-alias',
      candidates: ['anthropic:override-primary', 'openai:override-fallback'],
      cooldownMs: 30_000,
    },
  };
}

describe('subagent model override provenance', () => {
  it("does not replace a child's declared model with its parent's configured model", async () => {
    const real = subagents.createSubAgentTools;
    const spy = spyOn(subagents, 'createSubAgentTools').mockImplementation(real);
    try {
      await prepareAgentExecution({
        agent: parentAgent(),
        mcpClients: [],
        agentFilePath: parentPath,
      });

      expect(spy).toHaveBeenCalled();
      expect(spy.mock.calls[0]?.[2]).toBeUndefined();
    } finally {
      spy.mockRestore();
    }
  });

  it('passes an explicit run override to direct children as an immutable policy snapshot', async () => {
    const override = runOverride();
    const real = subagents.createSubAgentTools;
    const spy = spyOn(subagents, 'createSubAgentTools').mockImplementation(real);
    try {
      await prepareAgentExecution({
        agent: parentAgent(),
        mcpClients: [],
        subagentModelOverride: override,
        agentFilePath: parentPath,
      });

      expect(spy.mock.calls[0]?.[2]).toBe(override);
    } finally {
      spy.mockRestore();
    }
  });

  it('keeps the full override policy when a parent falls back before creating a nested child', () => {
    const override = runOverride();
    const child = parseAgentContent('---\nmodel: child:configured\n---\nChild.', 'child');
    const grandchild = parseAgentContent('---\nmodel: grandchild:configured\n---\nGrandchild.', 'grandchild');

    applyRunModelOverride(child.config, override);
    child.config.model = 'openai:override-fallback'; // simulate parent fallback
    applyRunModelOverride(grandchild.config, override);

    expect(grandchild.config).toMatchObject({
      model: 'anthropic:override-primary',
      modelAlias: '@run-policy',
      modelSource: 'user-alias',
      modelCandidates: ['anthropic:override-primary', 'openai:override-fallback'],
      modelFallbackCooldownMs: 30_000,
    });
  });

  it('restores the explicit override policy when rebuilding tools for a resumed session', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'agentuse-subagent-model-'));
    const override = runOverride();
    process.env.XDG_DATA_HOME = dataRoot;
    try {
      await initStorage(fixtures);
      const sessionManager = new SessionManager();
      const agent = parentAgent();
      const agentId = 'parent';
      const sessionID = await sessionManager.createSession({
        agent: { id: agentId, name: agent.name, filePath: parentPath, isSubAgent: false },
        model: agent.config.model,
        version: 'test',
        config: { modelOverride: override },
        project: { root: fixtures, cwd: fixtures },
      });
      await sessionManager.createMessage(sessionID, agentId, {
        user: { prompt: { task: agent.instructions } },
        assistant: {
          system: ['system'],
          modelID: agent.config.model,
          providerID: 'anthropic',
          mode: 'build',
          path: { cwd: fixtures, root: fixtures },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
        },
      });
      await sessionManager.writeToolsSnapshot(sessionID, agentId, { tools: [] });

      const real = subagents.createSubAgentTools;
      const spy = spyOn(subagents, 'createSubAgentTools').mockImplementation(real);
      try {
        await prepareAgentExecution({
          agent,
          mcpClients: [],
          agentFilePath: parentPath,
          sessionManager,
          projectContext: { projectRoot: fixtures, stateRoot: fixtures, cwd: fixtures },
          existingSessionId: sessionID,
        });
        expect(spy.mock.calls[0]?.[2]).toEqual(override);
        expect(agent.config).toMatchObject({
          model: 'anthropic:override-primary',
          modelCandidates: ['anthropic:override-primary', 'openai:override-fallback'],
          modelFallbackCooldownMs: 30_000,
        });
      } finally {
        spy.mockRestore();
      }
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      fs.rmSync(dataRoot, { recursive: true, force: true });
    }
  });
});
