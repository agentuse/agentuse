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

  it('does not duplicate a suspended gate the snapshot already captured, and prefers the resolved result', async () => {
    // Reproduces the HTTP 400 that crashed resume with "tool_use ids were found
    // without tool_result blocks immediately after" (session 01KWZ614...).
    //
    // On suspend, the AI SDK records the thrown SuspendSignal as a synthetic
    // tool-result ("Agent execution suspended"), so the suspension snapshot
    // already contains the await_human tool-call AND that stale result. But the
    // snapshot's `updatedAt` marks the model step's START, which is EARLIER than
    // the gate part's `suspendedAt`. So the resolved gate part satisfies
    // getPartOrder > updatedAt and gets re-appended — duplicating the tool-call
    // (the snapshot copy is then dangling on the provider) and, because the
    // stale suspend result sorts first, normalizeRehydratedMessages would keep
    // "Agent execution suspended" over the real approval decision.
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-rehydrate-gate-dupe-'));
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
        user: { prompt: { task: 'Long approval task' } },
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

      // Snapshot updatedAt (step start) is BEFORE the gate's suspendedAt.
      await sessionManager.writeContextSnapshot(sessionID, agentId, {
        version: 1,
        updatedAt: 1_000,
        messageID,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'Long approval task' },
          { role: 'assistant', content: [
            { type: 'text', text: 'Now the approval gate.' },
            { type: 'tool-call', toolCallId: 'call-approval', toolName: 'await_human', input: { prompt: 'Approve?' } },
          ] },
          { role: 'tool', content: [
            { type: 'tool-result', toolCallId: 'call-approval', toolName: 'await_human', output: { type: 'error-text', value: 'Agent execution suspended' } },
          ] },
        ] as any,
        usage: {
          activeTokens: 76_000,
          contextLimit: 922_000,
          usagePercentage: 8.243,
          compacted: false,
          compactions: 0,
          updatedAt: 1_000,
        }
      });

      // The gate resolved (approved). Its time.start is the former suspendedAt
      // (1_002 > snapshot.updatedAt), matching applyResumeToolResult.
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'tool',
        callID: 'call-approval',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Approve?' },
          output: { status: 'approve', reviewer: { username: 'web' } },
          metadata: { resumePayload: { kind: 'await_human', resumeToken: 'token-1' } },
          time: { start: 1_002, end: 5_000 }
        }
      } as any);

      const messages = await rehydrateMessages(sessionManager, sessionID, agentId);

      // Exactly one tool-call for the gate (no dangling duplicate).
      const gateCalls = (messages as any[]).flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'tool-call' && p.toolCallId === 'call-approval') : []
      );
      expect(gateCalls).toHaveLength(1);

      // Exactly one tool-result, and it is the REAL approval decision, not the
      // stale "Agent execution suspended" placeholder.
      const gateResults = (messages as any[]).flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'tool-result' && p.toolCallId === 'call-approval') : []
      );
      expect(gateResults).toHaveLength(1);
      expect(gateResults[0].output).toEqual({ type: 'json', value: { status: 'approve', reviewer: { username: 'web' } } });
      expect(JSON.stringify(messages)).not.toContain('Agent execution suspended');

      // Every tool-call is immediately followed by a message carrying its result
      // (the invariant the provider enforces).
      for (let i = 0; i < messages.length; i++) {
        const m = messages[i] as any;
        if (!Array.isArray(m.content)) continue;
        for (const p of m.content) {
          if (p.type !== 'tool-call') continue;
          const next = messages[i + 1] as any;
          const hasResult = next && Array.isArray(next.content) &&
            next.content.some((r: any) => r.type === 'tool-result' && r.toolCallId === p.toolCallId);
          expect(hasResult).toBe(true);
        }
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('preserves a signed thinking turn verbatim across a gate resume (reasoning-safe path)', async () => {
    // Reproduces the HTTP 400 that crashed resume with "messages.1.content.N:
    // `thinking` or `redacted_thinking` blocks in the latest assistant message
    // cannot be modified" (session 01KY5HNX...). With extended thinking on, the
    // gate turn is a single SIGNED assistant message holding reasoning blocks +
    // the await_human tool-call + sibling tool-calls the model fired alongside it
    // (journaled per #165). The old strip/re-append rewrote that turn's content
    // array, invalidating the provider signature. The reasoning-safe path must
    // replay the turn byte-for-byte and only append tool-results after it.
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-rehydrate-thinking-gate-'));
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
        user: { prompt: { task: 'Reply with approval' } },
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

      // The signed thinking turn: reasoning blocks (with a provider signature)
      // followed by the gate call and two sibling calls fired in the same turn.
      const signedAssistant = {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Deciding whether this is the right account.', providerOptions: { anthropic: { signature: 'sig-abc-123' } } },
          { type: 'text', text: 'I prepared the final draft for review.' },
          { type: 'tool-call', toolCallId: 'call-gate', toolName: 'await_human', input: { prompt: 'Approve?' } },
          { type: 'tool-call', toolCallId: 'call-bash', toolName: 'bash', input: { command: 'x.com/agentuse' } },
          { type: 'tool-call', toolCallId: 'call-store', toolName: 'store_get', input: { id: 'z' } },
        ],
      };
      // Snapshot as written at suspend: the signed turn + the SDK's synthetic
      // "suspended" tool-result for the gate.
      await sessionManager.writeContextSnapshot(sessionID, agentId, {
        version: 1,
        updatedAt: 1_000,
        messageID,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'Reply with approval' },
          signedAssistant,
          { role: 'tool', content: [
            { type: 'tool-result', toolCallId: 'call-gate', toolName: 'await_human', output: { type: 'error-text', value: 'Agent execution suspended' } },
          ] },
        ] as any,
        usage: {
          activeTokens: 76_000,
          contextLimit: 922_000,
          usagePercentage: 8.243,
          compacted: false,
          compactions: 0,
          updatedAt: 1_000,
        }
      });

      // Resolved parts (fresh, time.start > snapshot.updatedAt): gate approved,
      // both siblings denied/journaled.
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'text',
        role: 'assistant',
        text: 'I prepared the final draft for review.',
        time: { start: 1_001, end: 1_001 }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'text',
        role: 'assistant',
        text: 'review',
        time: { start: 1_002, end: 1_002 }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'tool',
        callID: 'call-gate',
        tool: 'await_human',
        state: { status: 'completed', input: { prompt: 'Approve?' }, output: { status: 'approve', reviewer: { username: 'web' } }, time: { start: 1_002, end: 5_000 } }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'tool',
        callID: 'call-bash',
        tool: 'bash',
        state: { status: 'completed', input: { command: 'x.com/agentuse' }, output: { denied: true, reason: 'gate open' }, time: { start: 1_003, end: 1_003 } }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'tool',
        callID: 'call-store',
        tool: 'store_get',
        state: { status: 'completed', input: { id: 'z' }, output: { denied: true, reason: 'gate open' }, time: { start: 1_004, end: 1_004 } }
      } as any);

      const messages = await rehydrateMessages(sessionManager, sessionID, agentId);

      // The signed assistant turn must be replayed BYTE-FOR-BYTE: same reasoning
      // block (signature intact) and all three tool-calls in the same message,
      // same order. This is what the provider signature covers.
      const signedInReplay = (messages as any[]).find((m) =>
        m.role === 'assistant' && Array.isArray(m.content) && m.content.some((p: any) => p.type === 'reasoning')
      );
      expect(signedInReplay).toBeDefined();
      expect(signedInReplay.content).toEqual(signedAssistant.content);
      const replayedText = (messages as any[]).flatMap((m) => {
        if (m.role !== 'assistant') return [];
        if (typeof m.content === 'string') return [m.content];
        return Array.isArray(m.content)
          ? m.content.filter((p: any) => p.type === 'text').map((p: any) => p.text)
          : [];
      });
      expect(replayedText.filter((text) => text === 'I prepared the final draft for review.')).toHaveLength(1);
      // Dedupe whole signed text parts only. A later, distinct text part that
      // happens to be a substring must not disappear from replay.
      expect(replayedText.filter((text) => text === 'review')).toHaveLength(1);

      // Exactly one tool-call per id across the whole transcript (no duplicate
      // that the old re-append produced).
      for (const id of ['call-gate', 'call-bash', 'call-store']) {
        const calls = (messages as any[]).flatMap((m) =>
          Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'tool-call' && p.toolCallId === id) : []
        );
        expect(calls).toHaveLength(1);
      }

      // The gate carries the REAL approval decision, not the stale placeholder.
      const gateResults = (messages as any[]).flatMap((m) =>
        Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'tool-result' && p.toolCallId === 'call-gate') : []
      );
      expect(gateResults).toHaveLength(1);
      expect(gateResults[0].output).toEqual({ type: 'json', value: { status: 'approve', reviewer: { username: 'web' } } });
      expect(JSON.stringify(messages)).not.toContain('Agent execution suspended');

      // Every tool-call in the signed turn has a matching result (no dangling
      // sibling tool_use, which the provider also rejects).
      for (const id of ['call-gate', 'call-bash', 'call-store']) {
        const results = (messages as any[]).flatMap((m) =>
          m.role === 'tool' && Array.isArray(m.content) ? m.content.filter((p: any) => p.type === 'tool-result' && p.toolCallId === id) : []
        );
        expect(results).toHaveLength(1);
      }
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('re-pairs a fresh tool-result whose tool-call never made it into the signed turn', async () => {
    // Guards the HTTP 400 that crashed a verify-gate redo resume:
    // "messages.10.content.0: unexpected `tool_use_id` found in `tool_result`
    // blocks: toolu_... Each `tool_result` block must have a corresponding
    // `tool_use` block" (session 01KY5MA4YP...). During a verify-judge redo the
    // model fired store_update siblings alongside the re-gate; they were
    // denied/journaled and their tool-RESULTS were persisted as fresh parts, but
    // their tool_use blocks never made it into the signed turn. Result-only
    // append re-emitted a result with no matching call -> orphan -> provider
    // 400. Originally healed by dropping the orphan; now the full call+result
    // pair is re-appended instead (same no-orphan invariant, and the model
    // keeps the denial memory it needs to re-issue after approval).
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-rehydrate-orphan-result-'));
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
        user: { prompt: { task: 'Reply with approval' } },
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

      // Signed thinking turn holding ONLY the gate call. The store_update sibling
      // the model fired was aborted/journaled and its tool_use never landed here.
      const signedAssistant = {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Re-gating with the revised draft.', providerOptions: { anthropic: { signature: 'sig-xyz-789' } } },
          { type: 'tool-call', toolCallId: 'call-gate', toolName: 'await_human', input: { prompt: 'Approve revised?' } },
        ],
      };
      await sessionManager.writeContextSnapshot(sessionID, agentId, {
        version: 1,
        updatedAt: 1_000,
        messageID,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'Reply with approval' },
          signedAssistant,
          { role: 'tool', content: [
            { type: 'tool-result', toolCallId: 'call-gate', toolName: 'await_human', output: { type: 'error-text', value: 'Agent execution suspended' } },
          ] },
        ] as any,
        usage: {
          activeTokens: 76_000,
          contextLimit: 922_000,
          usagePercentage: 8.243,
          compacted: false,
          compactions: 0,
          updatedAt: 1_000,
        }
      });

      // Fresh parts: the gate approved, plus a denied store_update sibling whose
      // tool-call is NOT in the signed turn (the orphan source).
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'tool',
        callID: 'call-gate',
        tool: 'await_human',
        state: { status: 'completed', input: { prompt: 'Approve revised?' }, output: { status: 'approve', reviewer: { username: 'web' } }, time: { start: 1_002, end: 5_000 } }
      } as any);
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'tool',
        callID: 'call-orphan-store',
        tool: 'store_update',
        state: { status: 'completed', input: { id: 'x' }, output: { denied: true, reason: 'gate open' }, time: { start: 1_003, end: 1_003 } }
      } as any);

      const messages = await rehydrateMessages(sessionManager, sessionID, agentId);

      // No tool-result may reference a toolCallId that has no tool-call anywhere.
      const callIds = new Set(
        (messages as any[]).flatMap((m) =>
          m.role === 'assistant' && Array.isArray(m.content)
            ? m.content.filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId)
            : []
        )
      );
      const resultIds = (messages as any[]).flatMap((m) =>
        m.role === 'tool' && Array.isArray(m.content)
          ? m.content.filter((p: any) => p.type === 'tool-result').map((p: any) => p.toolCallId)
          : []
      );
      for (const id of resultIds) {
        expect(callIds.has(id)).toBe(true);
      }
      // The real gate decision survives, and the sibling is re-paired with its
      // call (not an orphan, not silently forgotten).
      expect(resultIds).toContain('call-gate');
      expect(resultIds).toContain('call-orphan-store');
      expect(callIds.has('call-orphan-store')).toBe(true);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });

  it('re-appends the full call+result pair when the gate call never reached the snapshot', async () => {
    // Reproduces the swallowed reviewer comment (session 01KY7SNGDAF7): the
    // suspended step's output is only folded into the active context when the
    // prepareStep race wins. When it lost, the snapshot ends BEFORE the gate
    // turn — no await_human tool-call anywhere — while an earlier assistant
    // turn still carries signed reasoning, so rehydrate takes the
    // reasoning-safe path. Result-only append then produced an orphaned
    // tool-result that normalizeRehydratedMessages dropped: the model resumed
    // with no trace of the gate OR the reviewer's comment and re-gated the
    // stale draft. The fix re-appends the full call+result pair for any fresh
    // tool part whose call is absent from the snapshot.
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-rehydrate-uncaptured-gate-'));
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
        user: { prompt: { task: 'Reply with approval' } },
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

      // Snapshot as written when the prepareStep race LOST: it ends at the
      // step before the gate (store_create + its result). The signed reasoning
      // turn is an earlier turn; the await_human call is nowhere in history.
      const signedAssistant = {
        role: 'assistant',
        content: [
          { type: 'reasoning', text: 'Drafting the reply and logging it to the store.', providerOptions: { anthropic: { signature: 'sig-def-456' } } },
          { type: 'text', text: 'Draft ready, logging the store item.' },
          { type: 'tool-call', toolCallId: 'call-store-create', toolName: 'store_create', input: { title: 'draft item' } },
        ],
      };
      await sessionManager.writeContextSnapshot(sessionID, agentId, {
        version: 1,
        updatedAt: 1_000,
        messageID,
        messages: [
          { role: 'system', content: 'system' },
          { role: 'user', content: 'Reply with approval' },
          signedAssistant,
          { role: 'tool', content: [
            { type: 'tool-result', toolCallId: 'call-store-create', toolName: 'store_create', output: { type: 'json', value: { success: true, id: 'item-1' } } },
          ] },
        ] as any,
        usage: {
          activeTokens: 76_000,
          contextLimit: 922_000,
          usagePercentage: 8.243,
          compacted: false,
          compactions: 0,
          updatedAt: 1_000,
        }
      });

      // Fresh part: the resolved gate, carrying the reviewer's comment. Its
      // tool-call exists only here — never in the snapshot.
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'tool',
        callID: 'call-gate-uncaptured',
        tool: 'await_human',
        state: {
          status: 'completed',
          input: { prompt: 'Approve this reply?', changes: [{ content: 'the draft text' }] },
          output: { status: 'comment', comment: 'i am using herdr, i like the multiplexer', reviewer: { username: 'web' } },
          time: { start: 1_002, end: 5_000 }
        }
      } as any);

      const messages = await rehydrateMessages(sessionManager, sessionID, agentId);

      // The signed turn survives byte-for-byte.
      const signedInReplay = (messages as any[]).find((m) =>
        m.role === 'assistant' && Array.isArray(m.content) && m.content.some((p: any) => p.type === 'reasoning')
      );
      expect(signedInReplay).toBeDefined();
      expect(signedInReplay.content).toEqual(signedAssistant.content);

      // The gate call was re-appended as its own turn, exactly once...
      const gateCalls = (messages as any[]).flatMap((m) =>
        m.role === 'assistant' && Array.isArray(m.content)
          ? m.content.filter((p: any) => p.type === 'tool-call' && p.toolCallId === 'call-gate-uncaptured')
          : []
      );
      expect(gateCalls).toHaveLength(1);

      // ...and the reviewer's comment survives as its result (not dropped as an
      // orphan).
      const gateResults = (messages as any[]).flatMap((m) =>
        m.role === 'tool' && Array.isArray(m.content)
          ? m.content.filter((p: any) => p.type === 'tool-result' && p.toolCallId === 'call-gate-uncaptured')
          : []
      );
      expect(gateResults).toHaveLength(1);
      expect(gateResults[0].output).toEqual({
        type: 'json',
        value: { status: 'comment', comment: 'i am using herdr, i like the multiplexer', reviewer: { username: 'web' } }
      });

      // No dangling tool_use and no orphaned tool_result anywhere.
      const callIds = new Set(
        (messages as any[]).flatMap((m) =>
          m.role === 'assistant' && Array.isArray(m.content)
            ? m.content.filter((p: any) => p.type === 'tool-call').map((p: any) => p.toolCallId)
            : []
        )
      );
      const resultIds = (messages as any[]).flatMap((m) =>
        m.role === 'tool' && Array.isArray(m.content)
          ? m.content.filter((p: any) => p.type === 'tool-result').map((p: any) => p.toolCallId)
          : []
      );
      for (const id of resultIds) expect(callIds.has(id)).toBe(true);
      for (const id of callIds) expect(resultIds).toContain(id);
    } finally {
      await rm(projectRoot, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });
});
