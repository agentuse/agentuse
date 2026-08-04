import { describe, it, expect } from 'bun:test';
import {
  createReportCompleteTool,
  createReportIncompleteTool,
  normalizeHeadline,
  MAX_HEADLINE_LENGTH,
  type RunOutcome,
} from '../src/tools/report-outcome';
import { loadAgentTools } from '../src/runner/tools-loader';
import { runResultJson, shouldRequestOutcome, OUTCOME_NUDGE_PROMPT } from '../src/runner/outcome';
import { buildAutonomousAgentPrompt } from '../src/runner/prompt';
import type { ParsedAgent } from '../src/parser';

describe('report_complete tool', () => {
  it('records the headline into the shared outcome and keeps the run alive', async () => {
    const outcome: RunOutcome = {};
    const tool = createReportCompleteTool(outcome) as any;

    const reply = await tool.execute({ headline: 'Posted 10/10 connect replies; 10 of 20 budget left' });

    expect(outcome.complete).toEqual({ headline: 'Posted 10/10 connect replies; 10 of 20 budget left' });
    expect(typeof reply).toBe('string');
    expect(outcome.incomplete).toBeUndefined();
  });

  it('keeps artifacts when given and omits the key when empty', async () => {
    const withArtifacts: RunOutcome = {};
    await (createReportCompleteTool(withArtifacts) as any).execute({
      headline: 'Shipped the fix',
      artifacts: ['/tmp/report.md', 'https://example.com/pr/1'],
    });
    expect(withArtifacts.complete?.artifacts).toEqual(['/tmp/report.md', 'https://example.com/pr/1']);

    const withoutArtifacts: RunOutcome = {};
    await (createReportCompleteTool(withoutArtifacts) as any).execute({
      headline: 'Shipped the fix',
      artifacts: [],
    });
    expect(withoutArtifacts.complete).toEqual({ headline: 'Shipped the fix' });
  });

  it('last call wins when the agent refines the headline', async () => {
    const outcome: RunOutcome = {};
    const tool = createReportCompleteTool(outcome) as any;

    await tool.execute({ headline: 'first' });
    await tool.execute({ headline: 'second, with the real number: 7' });

    expect(outcome.complete?.headline).toBe('second, with the real number: 7');
  });
});

describe('normalizeHeadline', () => {
  it('collapses a multi-line answer into one line', () => {
    expect(normalizeHeadline('Posted 10/10\n\nreplies   today')).toBe('Posted 10/10 replies today');
  });

  it('caps a runaway headline so one-line surfaces stay one line', () => {
    const long = 'x'.repeat(400);
    const normalized = normalizeHeadline(long);

    expect(normalized.length).toBe(MAX_HEADLINE_LENGTH);
    expect(normalized.endsWith('…')).toBe(true);
  });

  it('leaves a well-formed headline untouched', () => {
    const good = 'Posted 10/10 connect replies, all verified; 10 of 20 daily budget left';
    expect(normalizeHeadline(good)).toBe(good);
  });
});

describe('outcome precedence: one slot, two writers', () => {
  it('lets both tools write the same slot', async () => {
    const outcome: RunOutcome = {};
    await (createReportCompleteTool(outcome) as any).execute({ headline: 'Looked done' });
    await (createReportIncompleteTool(outcome) as any).execute({ reason: 'Login actually expired' });

    expect(outcome.complete?.headline).toBe('Looked done');
    expect(outcome.incomplete?.reason).toBe('Login actually expired');
  });

  it('never pairs a failure payload with a success headline', () => {
    const json = runResultJson({
      status: 'failed',
      incomplete: { reason: 'Login expired' },
      complete: { headline: 'Looked done' },
      text: 'partial',
      toolCallCount: 1,
      hasTextOutput: true,
    }, 10);

    expect(json.success).toBe(false);
    expect(json.result).not.toHaveProperty('headline');
  });

  it('carries the headline and artifacts on a clean run', () => {
    const json = runResultJson({
      status: 'completed',
      complete: { headline: 'Posted 10/10', artifacts: ['/tmp/out.md'] },
      text: 'the full report',
      toolCallCount: 3,
      hasTextOutput: true,
    }, 10);

    expect(json.success).toBe(true);
    expect(json.result).toMatchObject({ headline: 'Posted 10/10', artifacts: ['/tmp/out.md'] });
  });
});

describe('shouldRequestOutcome', () => {
  const base = {
    outcome: {} as RunOutcome | undefined,
    segmentFinishReason: 'stop' as string | undefined,
    stepCount: 5,
    maxSteps: 100,
    alreadyAsked: false,
    suspended: false,
  };

  it('asks when a turn ended with no verdict and budget remains', () => {
    expect(shouldRequestOutcome(base)).toBe(true);
  });

  it('stays quiet once either verdict is declared', () => {
    expect(shouldRequestOutcome({ ...base, outcome: { complete: { headline: 'done' } } })).toBe(false);
    expect(shouldRequestOutcome({ ...base, outcome: { incomplete: { reason: 'blocked' } } })).toBe(false);
  });

  it('spends at most one ask per run', () => {
    expect(shouldRequestOutcome({ ...base, alreadyAsked: true })).toBe(false);
  });

  it('does not interrupt a run that is still working or suspended', () => {
    expect(shouldRequestOutcome({ ...base, segmentFinishReason: 'tool-calls' })).toBe(false);
    expect(shouldRequestOutcome({ ...base, segmentFinishReason: 'length' })).toBe(false);
    expect(shouldRequestOutcome({ ...base, suspended: true })).toBe(false);
  });

  it('does not claim a step the run does not have', () => {
    expect(shouldRequestOutcome({ ...base, stepCount: 100, maxSteps: 100 })).toBe(false);
  });

  it('is inert when the outcome tools were never loaded', () => {
    expect(shouldRequestOutcome({ ...base, outcome: undefined })).toBe(false);
  });

  it('asks for the verdict without inviting a second copy of the report', () => {
    expect(OUTCOME_NUDGE_PROMPT).toContain('report_complete');
    expect(OUTCOME_NUDGE_PROMPT).toContain('report_incomplete');
    expect(OUTCOME_NUDGE_PROMPT).toMatch(/do not repeat/i);
  });
});

describe('loadAgentTools outcome wiring', () => {
  // Minimal shape: loadAgentTools only reads name/instructions/config.model here.
  const agent = {
    name: 'outcome-test-agent',
    instructions: 'noop',
    config: { model: 'anthropic:claude-sonnet-4-0' }
  } as unknown as ParsedAgent;

  it('always exposes both outcome tools', async () => {
    const loaded = await loadAgentTools({ agent, mcpConnections: [] });

    expect(loaded.all.report_complete).toBeDefined();
    expect(loaded.all.report_incomplete).toBeDefined();
    expect(loaded.runOutcome).toEqual({});
  });

  it('shares one runOutcome ref across both tools', async () => {
    const loaded = await loadAgentTools({ agent, mcpConnections: [] });

    await (loaded.all.report_complete as any).execute({ headline: 'Swept 40 files, nothing to act on' });
    expect(loaded.runOutcome.complete?.headline).toBe('Swept 40 files, nothing to act on');

    await (loaded.all.report_incomplete as any).execute({ reason: 'blocked precondition' });
    expect(loaded.runOutcome.incomplete?.reason).toBe('blocked precondition');
    // Same object, so the runner sees both and applies incomplete-wins itself.
    expect(loaded.runOutcome.complete).toBeDefined();
  });
});

describe('system prompt outcome contract', () => {
  const prompt = buildAutonomousAgentPrompt('2026-08-04');

  it('routes both verdicts through a tool call', () => {
    expect(prompt).toContain('report_complete');
    expect(prompt).toContain('report_incomplete');
  });

  it('puts the status line outside the guidance precedence ladder', () => {
    expect(prompt).toMatch(/runtime-owned/);
    expect(prompt).toMatch(/never replaces or suppresses it/);
  });
});
