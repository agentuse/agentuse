import { describe, it, expect } from 'bun:test';
import {
  findPendingSubagentWaitChildId,
  findPendingAwaitHumanPart,
  descendToLeafGate,
  findRootSessionId,
  type CascadeSessionReader,
} from '../src/runner/subagent-cascade';

// ---- Part / session builders ------------------------------------------------

function subagentWaitPart(childSessionID: string, status: 'pending' | 'completed' = 'pending') {
  return {
    type: 'tool',
    tool: 'subagent__leaf',
    state: {
      status,
      ...(status === 'pending'
        ? { resumePayload: { kind: 'subagent_wait', childSessionID, childAgentName: 'leaf' } }
        : { output: { output: 'done' } }),
    },
  };
}

function awaitHumanPart(resumeToken = 'leaf-token', status: 'pending' | 'completed' = 'pending') {
  return {
    type: 'tool',
    tool: 'await_human',
    state: {
      status,
      input: { prompt: 'Approve?' },
      ...(status === 'pending'
        ? { resumePayload: { kind: 'await_human', resumeToken, approvalUrl: 'http://leaf/url' } }
        : { output: { status: 'approve' } }),
    },
  };
}

type Node = {
  status: 'suspended' | 'completed' | 'running' | 'error';
  parentSessionID?: string;
  parts: any[];
  agentName?: string;
};

// A minimal in-memory CascadeSessionReader over a node map.
function makeReader(nodes: Record<string, Node>): CascadeSessionReader {
  return {
    async findSession(sessionId: string) {
      const node = nodes[sessionId];
      if (!node) return null;
      return {
        session: {
          id: sessionId,
          status: node.status,
          ...(node.parentSessionID && { parentSessionID: node.parentSessionID }),
          agent: { id: sessionId, name: node.agentName ?? sessionId },
        } as any,
        agentId: 'agent',
      };
    },
    async getSessionMessages(sessionId: string) {
      return nodes[sessionId] ? [{ id: 'm1' }] : [];
    },
    async getMessageParts(sessionId: string) {
      return nodes[sessionId]?.parts ?? [];
    },
  };
}

describe('findPendingSubagentWaitChildId', () => {
  it('returns the childSessionID of a pending subagent_wait part', () => {
    expect(findPendingSubagentWaitChildId([subagentWaitPart('child-1')])).toBe('child-1');
  });

  it('ignores a completed subagent_wait part (only pending bookmarks are live)', () => {
    expect(findPendingSubagentWaitChildId([subagentWaitPart('child-1', 'completed')])).toBeUndefined();
  });

  it('returns undefined when there is no subagent_wait part', () => {
    expect(findPendingSubagentWaitChildId([awaitHumanPart()])).toBeUndefined();
    expect(findPendingSubagentWaitChildId([])).toBeUndefined();
  });

  it('picks the latest pending bookmark when several exist', () => {
    expect(findPendingSubagentWaitChildId([
      subagentWaitPart('old', 'completed'),
      subagentWaitPart('new'),
    ])).toBe('new');
  });
});

describe('findPendingAwaitHumanPart', () => {
  it('finds the pending await_human gate', () => {
    const part = findPendingAwaitHumanPart([subagentWaitPart('c'), awaitHumanPart('tk')]);
    expect(part?.state?.resumePayload?.resumeToken).toBe('tk');
  });

  it('ignores a completed (already-decided) gate', () => {
    expect(findPendingAwaitHumanPart([awaitHumanPart('tk', 'completed')])).toBeUndefined();
  });
});

describe('descendToLeafGate', () => {
  it('descends one level: root child -> leaf await_human gate', async () => {
    const reader = makeReader({
      leaf: { status: 'suspended', parts: [awaitHumanPart('leaf-token')], agentName: 'reply-to-post' },
    });
    const gate = await descendToLeafGate(reader, 'leaf');
    expect(gate).not.toBeNull();
    expect(gate!.session.id).toBe('leaf');
    expect(gate!.approvalPart.state.resumePayload.resumeToken).toBe('leaf-token');
  });

  it('descends multiple levels: mid -> leaf', async () => {
    const reader = makeReader({
      mid: { status: 'suspended', parts: [subagentWaitPart('leaf')] },
      leaf: { status: 'suspended', parts: [awaitHumanPart('leaf-token')], agentName: 'reply-to-post' },
    });
    // getApprovalInfo on the root calls descend with the root's childId (= mid).
    const gate = await descendToLeafGate(reader, 'mid');
    expect(gate!.session.id).toBe('leaf');
    expect(gate!.session.agent.name).toBe('reply-to-post');
    expect(gate!.approvalPart.state.resumePayload.resumeToken).toBe('leaf-token');
  });

  it('returns null for a stale chain (child no longer suspended)', async () => {
    const reader = makeReader({
      leaf: { status: 'completed', parts: [awaitHumanPart('leaf-token', 'completed')] },
    });
    expect(await descendToLeafGate(reader, 'leaf')).toBeNull();
  });

  it('returns null when a child is missing', async () => {
    const reader = makeReader({});
    expect(await descendToLeafGate(reader, 'gone')).toBeNull();
  });

  it('returns null when a suspended child holds neither gate nor bookmark', async () => {
    const reader = makeReader({
      mid: { status: 'suspended', parts: [{ type: 'tool', tool: 'x', state: { status: 'completed' } }] },
    });
    expect(await descendToLeafGate(reader, 'mid')).toBeNull();
  });
});

describe('findRootSessionId', () => {
  it('walks parentSessionID up to the topmost ancestor', async () => {
    const reader = makeReader({
      root: { status: 'suspended', parts: [] },
      mid: { status: 'suspended', parentSessionID: 'root', parts: [] },
      leaf: { status: 'suspended', parentSessionID: 'mid', parts: [] },
    });
    expect(await findRootSessionId(reader, 'leaf')).toBe('root');
    expect(await findRootSessionId(reader, 'mid')).toBe('root');
    expect(await findRootSessionId(reader, 'root')).toBe('root');
  });

  it('returns the id unchanged when there is no parent', async () => {
    const reader = makeReader({ solo: { status: 'suspended', parts: [] } });
    expect(await findRootSessionId(reader, 'solo')).toBe('solo');
  });
});
