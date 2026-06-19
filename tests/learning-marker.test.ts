import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { describeLearningOutcome } from '../src/learning';
import { recordLearningMarker, recordLearningMarkerForLatestMessage } from '../src/runner';

describe('describeLearningOutcome', () => {
  it('renders a captured auto outcome with lesson titles', () => {
    const { title, message } = describeLearningOutcome({
      status: 'captured',
      source: 'auto',
      count: 2,
      titles: ['Shorten prompts', 'Cache results'],
    });
    expect(title).toBe('Learned 2 lessons');
    expect(message).toBe('from this run: Shorten prompts; Cache results');
  });

  it('uses singular for a single captured lesson', () => {
    const { title } = describeLearningOutcome({ status: 'captured', source: 'approval', count: 1, titles: ['x'] });
    expect(title).toBe('Learned 1 lesson');
  });

  it('labels an approval-sourced capture distinctly', () => {
    const { message } = describeLearningOutcome({ status: 'captured', source: 'approval', count: 1, titles: ['Cite a source'] });
    expect(message).toContain('from reviewer comment');
  });

  it('renders a none outcome', () => {
    const { title, message } = describeLearningOutcome({ status: 'none', source: 'auto', count: 0 });
    expect(title).toBe('No new learnings');
    expect(message).toBe('from this run');
  });

  it('surfaces the error detail on a failed outcome (the Codex regression)', () => {
    const { title, message } = describeLearningOutcome({
      status: 'failed',
      source: 'auto',
      count: 0,
      detail: 'Stream must be set to true',
    });
    expect(title).toBe('Learning capture failed');
    expect(message).toContain('Stream must be set to true');
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

describe('recordLearningMarker', () => {
  it('persists a learning part that survives a round-trip through getMessageParts', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-learning-marker-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(projectRoot);

      await recordLearningMarker(sessionManager, sessionID, 'agents/review', messageID, {
        status: 'failed',
        source: 'auto',
        count: 0,
        titles: [],
        detail: 'Stream must be set to true',
      });

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/review', messageID);
      const learning = parts.find((p) => p.type === 'learning') as any;
      expect(learning).toBeDefined();
      expect(learning.status).toBe('failed');
      expect(learning.source).toBe('auto');
      expect(learning.detail).toBe('Stream must be set to true');
      expect(typeof learning.time?.start).toBe('number');
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });

  it('attaches a marker to the latest message when the message id is not in scope', async () => {
    const originalXdg = process.env.XDG_DATA_HOME;
    const projectRoot = await mkdtemp(join(tmpdir(), 'agentuse-learning-marker-latest-'));
    process.env.XDG_DATA_HOME = projectRoot;
    try {
      await initStorage(projectRoot);
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(projectRoot);

      await recordLearningMarkerForLatestMessage(sessionManager, sessionID, 'agents/review', {
        status: 'captured',
        source: 'approval',
        count: 1,
        titles: ['Cite a source'],
      });

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/review', messageID);
      const learning = parts.find((p) => p.type === 'learning') as any;
      expect(learning).toBeDefined();
      expect(learning.status).toBe('captured');
      expect(learning.source).toBe('approval');
      expect(learning.titles).toEqual(['Cite a source']);
    } finally {
      if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
      else process.env.XDG_DATA_HOME = originalXdg;
      await rm(projectRoot, { recursive: true, force: true });
    }
  });
});
