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
});
