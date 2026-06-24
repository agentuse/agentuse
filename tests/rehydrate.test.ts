import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager, rehydrateMessages } from '../src/session';

describe('rehydrateMessages', () => {
  it('rebuilds persisted text and tool parts as model messages', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-rehydrate-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();
      const sessionID = await sessionManager.createSession({
        agent: {
          id: 'agents/review',
          name: 'review',
          isSubAgent: false
        },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: {
          root: projectRoot,
          cwd: projectRoot
        }
      });
      const agentId = 'agents/review';
      const messageID = await sessionManager.createMessage(sessionID, agentId, {
        user: {
          prompt: {
            task: 'Write the draft',
            user: 'Make it concise'
          }
        },
        assistant: {
          system: ['system one', 'system two'],
          modelID: 'test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 }
          }
        }
      });

      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'text',
        text: 'Draft ready.',
        time: { start: 1, end: 1 }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'text',
        role: 'user',
        synthetic: true,
        text: 'Please add Hello World to the title.',
        time: { start: 2, end: 2 }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'tool',
        callID: 'call-1',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Review?' },
          output: { action: 'approve' },
          time: { start: 3, end: 4 }
        }
      } as any);

      const messages = await rehydrateMessages(sessionManager, sessionID, agentId);

      expect(messages[0]).toEqual({ role: 'system', content: 'system one' });
      expect(messages[1]).toEqual({ role: 'system', content: 'system two' });
      expect(messages[2]).toEqual({ role: 'user', content: 'Write the draft\n\nMake it concise' });
      expect(messages[3]).toEqual({ role: 'assistant', content: 'Draft ready.' });
      expect(messages[4]).toEqual({ role: 'user', content: 'Please add Hello World to the title.' });
      expect((messages[5] as any).content[0]).toMatchObject({
        type: 'tool-call',
        toolCallId: 'call-1',
        toolName: 'await_human',
        input: { prompt: 'Review?' }
      });
      expect((messages[6] as any).content[0]).toMatchObject({
        type: 'tool-result',
        toolCallId: 'call-1',
        output: {
          type: 'json',
          value: { action: 'approve' }
        }
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('prefers compacted context snapshot and appends newer parts only', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-rehydrate-snapshot-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();
      const sessionID = await sessionManager.createSession({
        agent: {
          id: 'agents/review',
          name: 'review',
          isSubAgent: false
        },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: {
          root: projectRoot,
          cwd: projectRoot
        }
      });
      const agentId = 'agents/review';
      const messageID = await sessionManager.createMessage(sessionID, agentId, {
        user: {
          prompt: {
            task: 'Long task'
          }
        },
        assistant: {
          system: ['system'],
          modelID: 'test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 }
          }
        }
      });

      const snapshotTime = Date.now();
      await sessionManager.writeContextSnapshot(sessionID, agentId, {
        version: 1,
        updatedAt: snapshotTime,
        messageID,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'Long task' },
          { role: 'system', content: '[Context Summary]\nOlder history\n[End Summary]' },
        ],
        usage: {
          activeTokens: 123,
          contextLimit: 1000,
          usagePercentage: 12.3,
          compacted: true,
          compactions: 1,
          updatedAt: snapshotTime,
        }
      });

      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'text',
        text: 'Old raw text that snapshot replaced.',
        time: { start: snapshotTime - 10, end: snapshotTime - 5 }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'text',
        role: 'user',
        synthetic: true,
        text: 'New follow-up after compaction.',
        time: { start: snapshotTime + 10, end: snapshotTime + 10 }
      } as any);

      const messages = await rehydrateMessages(sessionManager, sessionID, agentId);

      expect(messages).toHaveLength(4);
      expect(messages[2]).toEqual({ role: 'system', content: '[Context Summary]\nOlder history\n[End Summary]' });
      expect(messages[3]).toEqual({ role: 'user', content: 'New follow-up after compaction.' });
      expect(JSON.stringify(messages)).not.toContain('Old raw text');
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('heals a snapshot with a duplicate, bare-string tool-result (prepareStep/stream race)', async () => {
    // Reproduces the corruption that crashed resume with "Invalid prompt: The
    // messages do not match the ModelMessage[] schema": a context snapshot where
    // the same store_update tool-call has two tool-results — one proper
    // ({type:'json',value}) from prepareStep and one bare string from the racing
    // in-stream addMessage. The bare string is invalid per the AI SDK v5 schema.
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-rehydrate-dupe-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();
      const sessionID = await sessionManager.createSession({
        agent: { id: 'agents/review', name: 'review', isSubAgent: false },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: { root: projectRoot, cwd: projectRoot }
      });
      const agentId = 'agents/review';
      const messageID = await sessionManager.createMessage(sessionID, agentId, {
        user: { prompt: { task: 'Draft a post' } },
        assistant: {
          system: ['system'],
          modelID: 'test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
        }
      });

      await sessionManager.writeContextSnapshot(sessionID, agentId, {
        version: 1,
        updatedAt: 1_000,
        messageID,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'Draft a post' },
          { role: 'assistant', content: [{ type: 'tool-call', toolCallId: 'call-x', toolName: 'store_update', input: { id: 'a' } }] },
          // Proper, schema-valid result (from prepareStep's setMessages)
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-x', toolName: 'store_update', output: { type: 'json', value: { success: true } } }] },
          // Duplicate, schema-INVALID result (bare string from the racing add)
          { role: 'tool', content: [{ type: 'tool-result', toolCallId: 'call-x', toolName: 'store_update', output: '{"success":true}' }] },
        ] as any,
        usage: {
          activeTokens: 10,
          contextLimit: 1000,
          usagePercentage: 1,
          compacted: false,
          compactions: 0,
          updatedAt: 1_000,
        }
      });

      const messages = await rehydrateMessages(sessionManager, sessionID, agentId);

      // The duplicate tool-result message is dropped, leaving one valid result.
      const toolResults = messages.filter(
        (m: any) => m.role === 'tool' && Array.isArray(m.content) &&
          m.content.some((p: any) => p.type === 'tool-result' && p.toolCallId === 'call-x')
      );
      expect(toolResults).toHaveLength(1);
      expect((toolResults[0] as any).content[0].output).toEqual({ type: 'json', value: { success: true } });

      // Every surviving tool-result output is the wrapped ToolResultOutput form.
      for (const m of messages as any[]) {
        if (m.role !== 'tool' || !Array.isArray(m.content)) continue;
        for (const p of m.content) {
          if (p.type !== 'tool-result') continue;
          expect(typeof p.output).toBe('object');
          expect(typeof p.output.type).toBe('string');
        }
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('appends approval parts created after an un-compacted suspension snapshot', async () => {
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-rehydrate-suspension-snapshot-'));
    process.env.XDG_DATA_HOME = projectRoot;

    try {
      await initStorage(projectRoot);
      const sessionManager = new SessionManager();
      const sessionID = await sessionManager.createSession({
        agent: {
          id: 'agents/review',
          name: 'review',
          isSubAgent: false
        },
        model: 'demo:test',
        version: 'test',
        config: {},
        project: {
          root: projectRoot,
          cwd: projectRoot
        }
      });
      const agentId = 'agents/review';
      const messageID = await sessionManager.createMessage(sessionID, agentId, {
        user: {
          prompt: {
            task: 'Long approval task'
          }
        },
        assistant: {
          system: ['system'],
          modelID: 'test',
          providerID: 'demo',
          mode: 'build',
          path: { cwd: projectRoot, root: projectRoot },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 }
          }
        }
      });

      await sessionManager.writeContextSnapshot(sessionID, agentId, {
        version: 1,
        updatedAt: 1_000,
        messageID,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'Long approval task' },
        ],
        usage: {
          activeTokens: 76_000,
          contextLimit: 922_000,
          usagePercentage: 8.243,
          compacted: false,
          compactions: 0,
          updatedAt: 1_000,
        }
      });

      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'text',
        text: 'Ready for review.',
        time: { start: 1_001, end: 1_001 }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'tool',
        callID: 'call-approval',
        tool: 'await_human',
        state: {
          status: 'pending',
          input: { prompt: 'Approve?' },
          suspendedAt: 1_002,
          resumePayload: {
            kind: 'await_human',
            resumeToken: 'token-1'
          }
        }
      } as any);

      const messages = await rehydrateMessages(sessionManager, sessionID, agentId);

      expect(messages).toHaveLength(4);
      expect(messages[2]).toEqual({ role: 'assistant', content: 'Ready for review.' });
      expect((messages[3] as any).content[0]).toMatchObject({
        type: 'tool-call',
        toolCallId: 'call-approval',
        toolName: 'await_human',
        input: { prompt: 'Approve?' }
      });
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });
});
