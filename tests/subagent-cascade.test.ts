import { describe, it, expect } from 'bun:test';
import {
  findPendingSubagentWaitChildId,
  findPendingAwaitHumanPart,
  descendToLeafGate,
  findStaleCascadeChild,
  describeStaleCascade,
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
  error?: { code?: string; message?: string };
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
          ...(node.error && { error: node.error }),
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

// A parent parked on a delegated child can lose its gate without anything
// resuming it (the child ends while the ancestors stay suspended). descendToLeafGate
// returns null for BOTH that dead end and the healthy mid-flight case, so the
// approvals list needs this second read to tell "unresolvable" from "still working"
// instead of dropping the session and rendering it invisible.
describe('findStaleCascadeChild', () => {
  it('reports a child that ended incomplete (the report_incomplete orphan)', async () => {
    const reader = makeReader({
      leaf: {
        status: 'error',
        parts: [awaitHumanPart('leaf-token', 'completed')],
        agentName: 'LinkedIn AI News',
        error: { code: 'INCOMPLETE', message: 'Image billing limit reached' },
      },
    });
    const stale = await findStaleCascadeChild(reader, 'leaf');
    expect(stale).toEqual({
      sessionId: 'leaf',
      agentName: 'LinkedIn AI News',
      status: 'error',
      error: { code: 'INCOMPLETE', message: 'Image billing limit reached' },
    });
  });

  it('reports a child that completed without its parent being resumed', async () => {
    const reader = makeReader({
      leaf: { status: 'completed', parts: [awaitHumanPart('leaf-token', 'completed')], agentName: 'leaf-agent' },
    });
    expect(await findStaleCascadeChild(reader, 'leaf')).toMatchObject({ sessionId: 'leaf', status: 'completed' });
  });

  it('reports a missing child session record', async () => {
    expect(await findStaleCascadeChild(makeReader({}), 'gone')).toMatchObject({
      sessionId: 'gone',
      status: 'missing',
    });
  });

  it('reports a suspended child holding neither a gate nor a bookmark', async () => {
    const reader = makeReader({
      mid: { status: 'suspended', parts: [{ type: 'tool', tool: 'x', state: { status: 'completed' } }] },
    });
    expect(await findStaleCascadeChild(reader, 'mid')).toMatchObject({ sessionId: 'mid', status: 'suspended' });
  });

  it('returns null while a live gate is waiting below (healthy approval)', async () => {
    const reader = makeReader({
      mid: { status: 'suspended', parts: [subagentWaitPart('leaf')] },
      leaf: { status: 'suspended', parts: [awaitHumanPart('leaf-token')] },
    });
    expect(await findStaleCascadeChild(reader, 'mid')).toBeNull();
  });

  it('returns null while a descendant is still running (mid-flight, not stranded)', async () => {
    const reader = makeReader({
      mid: { status: 'suspended', parts: [subagentWaitPart('leaf')] },
      leaf: { status: 'running', parts: [] },
    });
    expect(await findStaleCascadeChild(reader, 'mid')).toBeNull();
  });

  it('finds the break several levels down', async () => {
    const reader = makeReader({
      mid: { status: 'suspended', parts: [subagentWaitPart('leaf')] },
      leaf: { status: 'error', parts: [], agentName: 'deep-leaf', error: { message: 'boom' } },
    });
    expect(await findStaleCascadeChild(reader, 'mid')).toMatchObject({ sessionId: 'leaf', agentName: 'deep-leaf' });
  });
});

describe('describeStaleCascade', () => {
  it('names the child, its outcome, and the way out', () => {
    expect(describeStaleCascade({
      sessionId: 'leaf', agentName: 'LinkedIn AI News', status: 'error',
      error: { code: 'INCOMPLETE', message: 'Image billing limit reached' },
    })).toBe(
      'Waiting on delegated sub-agent "LinkedIn AI News", but it ended error: Image billing limit reached. ' +
      'This run can no longer be resumed; stop it and re-run the agent.'
    );
  });

  it('does not double the sentence period when the child reason ends in one', () => {
    const text = describeStaleCascade({
      sessionId: 'leaf', agentName: 'leaf', status: 'error',
      error: { message: 'Login expired.' },
    });
    expect(text).toContain('Login expired. This run');
    expect(text).not.toContain('..');
  });

  it('reads sensibly with no recorded reason', () => {
    expect(describeStaleCascade({ sessionId: 'leaf', agentName: 'leaf', status: 'completed' }))
      .toContain('but it ended completed.');
  });

  it('calls out a missing session record by id', () => {
    expect(describeStaleCascade({ sessionId: 'gone-1', agentName: 'gone-1', status: 'missing' }))
      .toContain('its session record is missing (gone-1)');
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
