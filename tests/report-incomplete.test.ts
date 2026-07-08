import { describe, it, expect } from 'bun:test';
import { createReportIncompleteTool, type RunOutcome } from '../src/tools/report-incomplete';
import { loadAgentTools } from '../src/runner/tools-loader';
import { displayStatusLabel, isEndedStatus, sessionErrorText } from '../src/cli/serve/web/lib/format';
import type { ParsedAgent } from '../src/parser';

describe('report_incomplete tool', () => {
  it('records the reason into the shared outcome and keeps the run alive', async () => {
    const outcome: RunOutcome = {};
    const tool = createReportIncompleteTool(outcome) as any;

    const reply = await tool.execute({ reason: 'Substack session logged out; needs re-auth' });

    expect(outcome.incomplete).toEqual({ reason: 'Substack session logged out; needs re-auth' });
    // The tool must not throw/suspend: the agent continues to bookkeeping.
    expect(typeof reply).toBe('string');
    expect(reply).toContain('incomplete');
  });

  it('last call wins when the agent refines the reason', async () => {
    const outcome: RunOutcome = {};
    const tool = createReportIncompleteTool(outcome) as any;

    await tool.execute({ reason: 'first' });
    await tool.execute({ reason: 'second, more specific' });

    expect(outcome.incomplete?.reason).toBe('second, more specific');
  });
});

describe('loadAgentTools outcome wiring', () => {
  const agent: ParsedAgent = {
    name: 'outcome-test-agent',
    instructions: 'noop',
    config: { model: 'anthropic:claude-sonnet-4-0' }
  };

  it('always exposes report_incomplete, even with no tools configured', async () => {
    const loaded = await loadAgentTools({ agent, mcpConnections: [] });

    expect(loaded.all.report_incomplete).toBeDefined();
    expect(loaded.runOutcome).toEqual({});
  });

  it('shares the runOutcome ref with the exposed tool', async () => {
    const loaded = await loadAgentTools({ agent, mcpConnections: [] });

    await (loaded.all.report_incomplete as any).execute({ reason: 'blocked precondition' });

    expect(loaded.runOutcome.incomplete).toEqual({ reason: 'blocked precondition' });
  });
});

describe('incomplete status labels (web)', () => {
  it('maps error + INCOMPLETE to its own label, like stopped/timeout', () => {
    expect(displayStatusLabel('error', 'INCOMPLETE')).toBe('incomplete');
    expect(displayStatusLabel('error', 'USER_STOPPED')).toBe('stopped');
    expect(displayStatusLabel('error', 'TIMEOUT')).toBe('timeout');
    expect(displayStatusLabel('error', 'EXECUTION_ERROR')).toBe('error');
    expect(displayStatusLabel('error', undefined)).toBe('error');
    // Only error carries the sub-label; other statuses pass through untouched.
    expect(displayStatusLabel('completed', 'INCOMPLETE')).toBe('completed');
  });

  it('treats incomplete as an ended status', () => {
    expect(isEndedStatus('incomplete')).toBe(true);
  });

  it('renders a dedicated error text for agent-declared incompleteness', () => {
    expect(sessionErrorText({
      sessionStatus: 'error',
      errorCode: 'INCOMPLETE',
      errorMessage: 'Substack session logged out'
    })).toBe('Agent reported the run incomplete: Substack session logged out');
  });
});
