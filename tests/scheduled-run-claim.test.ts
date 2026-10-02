import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { existsSync, mkdtempSync, rmSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import { executeAgent } from '../src/worker/run';
import { createWorkerContext } from '../src/worker/context';
import { acquireOwnershipLock } from '../src/utils/ownership-lock';
import { SCHEDULED_RUN_ACTIVE, scheduledRunLockPath } from '../src/utils/scheduler-lock';

let projectRoot: string;

beforeEach(() => {
  projectRoot = mkdtempSync(join(tmpdir(), 'agentuse-scheduled-claim-'));
});

afterEach(() => {
  rmSync(projectRoot, { recursive: true, force: true });
});

// The agent file does not exist, so a run that gets past the claim ends at
// AGENT_NOT_FOUND without touching any model or session storage.
const scheduledRequest = (trigger: 'scheduled' | 'manual' = 'scheduled') => ({
  id: 'req-1',
  type: 'execute' as const,
  agentPath: './nightly.agentuse',
  projectRoot,
  trigger,
});

describe('scheduled run claim in the worker', () => {
  it('skips a scheduled run while another live process still holds its claim', async () => {
    const held = await acquireOwnershipLock(scheduledRunLockPath(projectRoot, 'nightly.agentuse'), { maxWaitMs: 0 });
    try {
      const response = await executeAgent(createWorkerContext(), scheduledRequest());
      expect(response.success).toBe(false);
      expect(!response.success && response.error.code).toBe(SCHEDULED_RUN_ACTIVE);
    } finally {
      await held.release();
    }
  });

  it('claims and releases the run when no other run holds it', async () => {
    const response = await executeAgent(createWorkerContext(), scheduledRequest());
    expect(!response.success && response.error.code).toBe('AGENT_NOT_FOUND');
    expect(existsSync(scheduledRunLockPath(projectRoot, 'nightly.agentuse'))).toBe(false);
  });

  it('does not gate runs that were not started by the scheduler', async () => {
    const held = await acquireOwnershipLock(scheduledRunLockPath(projectRoot, 'nightly.agentuse'), { maxWaitMs: 0 });
    try {
      const response = await executeAgent(createWorkerContext(), scheduledRequest('manual'));
      expect(!response.success && response.error.code).toBe('AGENT_NOT_FOUND');
    } finally {
      await held.release();
    }
  });
});
