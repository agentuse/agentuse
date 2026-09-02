import { describe, expect, it } from 'bun:test';
import { isLiveStatus, isWorkingStatus } from '../src/cli/serve/web/lib/format';
import type { ApprovalLogEntry } from '../src/cli/serve/types';

function log(overrides: Partial<ApprovalLogEntry>): ApprovalLogEntry {
  return { id: 'entry', type: 'tool', title: 'tool', ...overrides };
}

describe('working indicator', () => {
  it('stops claiming progress while the run waits on a human', () => {
    const logs = [log({ tool: 'subagent__news_post', status: 'pending' })];
    // The page is still live — the run has not finished — but nothing is working.
    expect(isLiveStatus('suspended', logs)).toBe(true);
    expect(isWorkingStatus('suspended', logs)).toBe(false);
  });

  it('keeps working while a delegated child runs under a suspended manager', () => {
    const logs = [log({
      tool: 'subagent__news_post',
      status: 'pending',
      subagentSession: {
        sessionId: 'child',
        agent: { id: 'agents/child', name: 'Child' },
        status: 'running',
        displayStatus: 'running',
        trigger: 'manual',
        createdAt: 1,
        updatedAt: 2,
        command: '',
      },
    })];
    expect(isWorkingStatus('suspended', logs)).toBe(true);
  });

  it('works whenever the session itself is executing, and never once it ends', () => {
    expect(isWorkingStatus('running', [])).toBe(true);
    expect(isWorkingStatus('preparing', [])).toBe(true);
    expect(isWorkingStatus('completed', [log({ status: 'running' })])).toBe(false);
  });
});
