/**
 * Reject is terminal: a human `reject` on an await_human gate seals the run so
 * no further await_human can suspend / re-ask the human. Only reject seals -
 * approve and comment (the revise-and-re-gate path) must not. This is the
 * runtime guarantee that replaces the per-agent "on reject, stop" prompt rule
 * that a model ignored on 2026-07-22 (x-engage-reply re-gated a rejected draft
 * three times, ~1.6M tokens).
 */
import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import * as fs from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { applyResumeToolResult } from '../src/runner/resume';
import { GateSealStore, GATE_SEAL_FILENAME } from '../src/runner/gate-seal';

async function makeSuspendedSession() {
  const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-gate-seal-'));
  process.env.XDG_DATA_HOME = projectRoot;
  await initStorage(projectRoot);
  const sessionManager = new SessionManager();
  const agentId = 'agents/reply';
  const sessionID = await sessionManager.createSession({
    agent: { id: agentId, name: 'reply', isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot }
  });
  const messageID = await sessionManager.createMessage(sessionID, agentId, {
    user: { prompt: { task: 'Draft a reply' } },
    assistant: {
      system: ['system'], modelID: 'test', providerID: 'demo', mode: 'build',
      path: { cwd: projectRoot, root: projectRoot }, cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
    }
  });
  await sessionManager.addPart(sessionID, agentId, messageID, {
    type: 'tool',
    callID: 'call-gate',
    tool: 'await_human',
    state: {
      status: 'pending',
      input: { prompt: 'Approve?' },
      suspendedAt: 1_000,
      resumePayload: { kind: 'await_human', prompt: 'Approve?', resumeToken: 'tok-123' }
    }
  } as any);
  await sessionManager.updateSession(sessionID, agentId, { status: 'suspended' });
  const sessionDir = await sessionManager.getSessionDirectory(sessionID, agentId);
  return { projectRoot, sessionManager, sessionID, agentId, sessionDir };
}

async function resumeWith(status: string, extra: Record<string, unknown> = {}) {
  const ctx = await makeSuspendedSession();
  await applyResumeToolResult({
    sessionManager: ctx.sessionManager,
    sessionId: ctx.sessionID,
    toolResult: { status, reviewer: { username: 'web' }, ...extra },
    resumeToken: 'tok-123',
  });
  return ctx;
}

async function cleanup(projectRoot: string) {
  await rm(projectRoot, { recursive: true, force: true });
  delete process.env.XDG_DATA_HOME;
}

describe('gate seal at the resume boundary', () => {
  it('reject seals the run (serve/Slack spelling: "rejected")', async () => {
    const { projectRoot, sessionDir } = await resumeWith('rejected');
    try {
      expect(fs.existsSync(join(sessionDir, GATE_SEAL_FILENAME))).toBe(true);
      expect(new GateSealStore(sessionDir).isSealed()).toBe(true);
    } finally {
      await cleanup(projectRoot);
    }
  });

  it('reject seals under the CLI decision shape too ("reject", not "rejected")', async () => {
    const { projectRoot, sessionDir } = await resumeWith('reject');
    try {
      expect(new GateSealStore(sessionDir).isSealed()).toBe(true);
    } finally {
      await cleanup(projectRoot);
    }
  });

  it('comment does NOT seal (it is the revise-and-re-gate path)', async () => {
    const { projectRoot, sessionDir } = await resumeWith('commented', { comment: 'try another angle' });
    try {
      expect(fs.existsSync(join(sessionDir, GATE_SEAL_FILENAME))).toBe(false);
      expect(new GateSealStore(sessionDir).isSealed()).toBe(false);
    } finally {
      await cleanup(projectRoot);
    }
  });

  it('approve does NOT seal', async () => {
    const { projectRoot, sessionDir } = await resumeWith('approved');
    try {
      expect(new GateSealStore(sessionDir).isSealed()).toBe(false);
    } finally {
      await cleanup(projectRoot);
    }
  });
});

describe('GateSealStore', () => {
  it('isSealed is false before sealing, true after, and survives re-binding a fresh instance', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'agentuse-gate-seal-unit-'));
    try {
      expect(new GateSealStore(dir).isSealed()).toBe(false);
      new GateSealStore(dir).seal('human reviewer rejected an await_human gate', 42);
      // A fresh instance (the resumed worker in another process) sees the seal.
      const reader = new GateSealStore(dir);
      expect(reader.isSealed()).toBe(true);
      const raw = JSON.parse(fs.readFileSync(join(dir, GATE_SEAL_FILENAME), 'utf8'));
      expect(raw.sealedAt).toBe(42);
      expect(raw.version).toBe(1);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('an unbound store never seals or reports sealed', () => {
    const unbound = new GateSealStore();
    expect(unbound.filePath).toBeUndefined();
    unbound.seal('noop');
    expect(unbound.isSealed()).toBe(false);
  });
});
