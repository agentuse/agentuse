import { describe, expect, it } from 'bun:test';
import { serverScheduleAgentPath } from '../src/cli/schedules';

describe('schedule daemon path translation', () => {
  it('translates project-relative state paths to served-scope run paths', () => {
    expect(serverScheduleAgentPath(
      '/workspace/repo',
      'packages/app/agents/daily.agentuse',
      { root: '/workspace/repo', scopeRoot: '/workspace/repo/packages/app' },
    )).toBe('agents/daily.agentuse');
  });

  it('keeps project-relative paths for an unscoped server', () => {
    expect(serverScheduleAgentPath(
      '/workspace/repo',
      'agents/daily.agentuse',
      { root: '/workspace/repo' },
    )).toBe('agents/daily.agentuse');
  });

  it('rejects an agent outside the served scope', () => {
    expect(() => serverScheduleAgentPath(
      '/workspace/repo',
      'agents/outside.agentuse',
      { root: '/workspace/repo', scopeRoot: '/workspace/repo/packages/app' },
    )).toThrow('Invalid project-relative agent path');
  });
});
