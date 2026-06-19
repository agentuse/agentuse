import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { describeErrorPart, recordErrorMarker, recordErrorMarkerForLatestMessage } from '../src/runner';

describe('describeErrorPart', () => {
  it('prefers the provider response body over the generic message', () => {
    const { title, message } = describeErrorPart({
      source: 'agent',
      code: 'EXECUTION_ERROR',
      message: 'Bad Request',
      detail: '{"detail":"Instructions are required"}',
      statusCode: 400,
    });
    expect(title).toBe('Run error (EXECUTION_ERROR)');
    expect(message).toBe('HTTP 400: {"detail":"Instructions are required"}');
  });

  it('falls back to the message when there is no detail', () => {
    const { message } = describeErrorPart({ source: 'agent', message: 'Network down' });
    expect(message).toBe('Network down');
  });

  it('labels a compaction failure distinctly', () => {
    const { title } = describeErrorPart({ source: 'compaction', message: 'Bad Request' });
    expect(title).toBe('Context compaction failed');
  });
});

async function makeSessionWithMessage(projectRoot: string) {
  const sessionManager = new SessionManager();
  const sessionID = await sessionManager.createSession({
    agent: { id: 'agents/review', name: 'review', isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const messageID = await sessionManager.createMessage(sessionID, 'agents/review', {
    user: { prompt: { task: 'do work' } },
    assistant: {
      system: [],
      modelID: 'demo:test',
      providerID: 'demo',
      mode: 'build',
      path: { cwd: projectRoot, root: projectRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  return { sessionManager, sessionID, messageID };
}

describe('recordErrorMarker', () => {
  it('persists an error part with the provider detail for a failed run', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-error-marker-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(projectRoot);

      await recordErrorMarker(sessionManager, sessionID, 'agents/review', messageID, {
        source: 'agent',
        code: 'EXECUTION_ERROR',
        message: 'Bad Request',
        detail: '{"detail":"Instructions are required"}',
        statusCode: 400,
      });

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/review', messageID);
      const err = parts.find((p) => p.type === 'error') as any;
      expect(err).toBeDefined();
      expect(err.source).toBe('agent');
      expect(err.code).toBe('EXECUTION_ERROR');
      expect(err.detail).toContain('Instructions are required');
      expect(err.statusCode).toBe(400);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('attaches a run-error marker to the latest message', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-error-marker-latest-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(projectRoot);

      await recordErrorMarkerForLatestMessage(sessionManager, sessionID, 'agents/review', {
        source: 'compaction',
        message: 'Bad Request',
        detail: 'Stream must be set to true',
      });

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/review', messageID);
      const err = parts.find((p) => p.type === 'error') as any;
      expect(err).toBeDefined();
      expect(err.source).toBe('compaction');
      expect(err.detail).toBe('Stream must be set to true');
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
