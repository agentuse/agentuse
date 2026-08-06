import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { recordCorrectionsMarker } from '../src/runner';

/**
 * The corrections marker exists so a run says what the injection cap left OUT.
 * Before it, "10 of 26 applied" and "10 of 10 applied" produced byte-identical
 * sessions: the counts were computed, logged to stderr and dropped.
 *
 * So the cases that matter are the three counts surviving a round trip, silence
 * when there is nothing to report, and the marker sorting to the START of the
 * log — a row that lands after the run's tool calls describes the prompt from
 * the wrong end of the story.
 */
async function makeSessionWithMessage(projectRoot: string) {
  const sessionManager = new SessionManager();
  const sessionID = await sessionManager.createSession({
    agent: { id: 'agents/demo', name: 'demo', isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const messageID = await sessionManager.createMessage(sessionID, 'agents/demo', {
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

async function withProject<T>(label: string, fn: (root: string) => Promise<T>): Promise<T> {
  const originalXdg = process.env.XDG_DATA_HOME;
  const projectRoot = await mkdtemp(join(tmpdir(), label));
  process.env.XDG_DATA_HOME = projectRoot;
  try {
    await initStorage(projectRoot);
    return await fn(projectRoot);
  } finally {
    if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
    else process.env.XDG_DATA_HOME = originalXdg;
    await rm(projectRoot, { recursive: true, force: true });
  }
}

describe('recordCorrectionsMarker', () => {
  it('records applied, active and cap so the dormant remainder is recoverable', async () => {
    await withProject('agentuse-corrections-marker-', async (projectRoot) => {
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(projectRoot);

      await recordCorrectionsMarker(sessionManager, sessionID, 'agents/demo', messageID, 10, 26, 10);

      const parts = await sessionManager.getMessageParts(sessionID, 'agents/demo', messageID);
      const marker = parts.find((p) => p.type === 'corrections') as any;
      expect(marker).toBeDefined();
      expect(marker.applied).toBe(10);
      expect(marker.active).toBe(26);
      expect(marker.cap).toBe(10);
      expect(typeof marker.time?.start).toBe('number');
    });
  });

  it('stays silent when no corrections were applied', async () => {
    await withProject('agentuse-corrections-none-', async (projectRoot) => {
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(projectRoot);

      await recordCorrectionsMarker(sessionManager, sessionID, 'agents/demo', messageID, 0, 0, 10);

      // A row on every run of every agent that has never been corrected is noise
      // in the one place that should be signal.
      const parts = await sessionManager.getMessageParts(sessionID, 'agents/demo', messageID);
      expect(parts.some((p) => p.type === 'corrections')).toBe(false);
    });
  });

  it('sorts to the start of the log rather than after the run', async () => {
    await withProject('agentuse-corrections-order-', async (projectRoot) => {
      const { sessionManager, sessionID, messageID } = await makeSessionWithMessage(projectRoot);

      await recordCorrectionsMarker(sessionManager, sessionID, 'agents/demo', messageID, 3, 3, 10);
      await sessionManager.addPart(sessionID, 'agents/demo', messageID, {
        type: 'log',
        level: 'info',
        message: 'something that happened during the run',
        time: { start: Date.now() + 60_000 },
      } as any);

      // `getPartOrder` returns MAX_SAFE_INTEGER for part types it does not list,
      // so omitting a branch there silently parks this marker after the whole
      // run instead of above its first tool call.
      const parts = await sessionManager.getMessageParts(sessionID, 'agents/demo', messageID);
      const corrections = parts.findIndex((p) => p.type === 'corrections');
      const later = parts.findIndex((p) => p.type === 'log');
      expect(corrections).toBeGreaterThanOrEqual(0);
      expect(later).toBeGreaterThanOrEqual(0);
      expect(corrections).toBeLessThan(later);
    });
  });
});
