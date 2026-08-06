import { describe, expect, it } from 'bun:test';
import { buildTokenTuningPrompt } from '../src/cli/serve/web/components/token-prompt-button';
import type { SessionContextPayload } from '../src/cli/serve/types';

function payload(overrides: Partial<SessionContextPayload> = {}): SessionContextPayload {
  return {
    sessionId: 'ses_abc',
    model: 'anthropic/claude-sonnet-4',
    agent: { id: 'news', name: 'news-digest', filePath: 'agents/news.agentuse' },
    layers: [
      { id: 'l1', kind: 'tools', label: 'Tool catalog', chars: 76_000, estTokens: 19_000 },
      { id: 'l2', kind: 'instructions', label: 'Agent instructions', source: 'agents/news.agentuse', chars: 8_000, estTokens: 2_000 },
      { id: 'l3', kind: 'prompt', label: 'Run prompt', chars: 400, estTokens: 100 },
    ],
    tools: [
      { name: 'tools__sandbox_exec', chars: 24_000, estTokens: 6_000 },
      { name: 'tools__filesystem_read', chars: 4_000, estTokens: 1_000 },
    ],
    fileReads: [
      { path: '/repo/docs/spec.md', tool: 'tools__filesystem_read', reads: 3, chars: 40_000, estTokens: 10_000 },
      { path: '/repo/README.md', tool: 'tools__filesystem_read', reads: 1, chars: 2_000, estTokens: 500 },
    ],
    traffic: {
      outputChars: 12_000,
      outputEstTokens: 3_000,
      toolResultChars: 32_000,
      toolResultEstTokens: 8_000,
      toolResults: [
        {
          tool: 'tools__sandbox_exec',
          calls: 4,
          failed: 1,
          pending: 0,
          chars: 32_000,
          estTokens: 8_000,
          callDetails: [
            { label: 'uv run /Users/x/.claude/skills/thing/scripts/fetch.py --id 7', chars: 24_000, estTokens: 6_000, status: 'ok' },
            { label: 'ls -la', chars: 8_000, estTokens: 2_000, status: 'ok' },
            { label: 'boom', chars: 0, estTokens: 0, status: 'failed' },
          ],
        },
        {
          tool: 'tools__filesystem_read',
          calls: 4,
          failed: 0,
          pending: 0,
          chars: 42_000,
          estTokens: 10_500,
          countedAsFiles: true,
        },
      ],
    },
    totals: { chars: 84_400, estTokens: 21_100, withFileReadsEstTokens: 31_600 },
    measured: { input: 180_000, output: 4_000, reasoning: 0, cacheRead: 120_000, cacheWrite: 9_000 },
    ...overrides,
  };
}

describe('the token-tuning prompt', () => {
  it('names the run and the numbers a coding agent needs to start', () => {
    const prompt = buildTokenTuningPrompt(payload());

    expect(prompt).toContain('Session ID: ses_abc');
    expect(prompt).toContain('agents/news.agentuse');
    expect(prompt).toContain('180,000 input tokens, 120,000 cached');
    expect(prompt).toContain('agentuse sessions show ses_abc --full');
  });

  it('splits the opening prompt from what the run added', () => {
    const prompt = buildTokenTuningPrompt(payload());

    expect(prompt).toContain('Opening prompt: ~21k');
    // 10.5k files + 8k tool results + 3k output
    expect(prompt).toContain('Added by the run: ~22k');
    expect(prompt).toContain('files read: ~11k');
    expect(prompt).toContain('tool results: ~8.0k');
  });

  it('lists the heaviest layers first, not in send order', () => {
    const prompt = buildTokenTuningPrompt(payload());
    const catalog = prompt.indexOf('Tool catalog');
    const instructions = prompt.indexOf('Agent instructions');

    expect(catalog).toBeGreaterThan(-1);
    expect(catalog).toBeLessThan(instructions);
  });

  it('itemises the tool catalog so there is something concrete to cut', () => {
    const prompt = buildTokenTuningPrompt(payload());

    expect(prompt).toContain('of 2 in the catalog');
    expect(prompt).toContain('tools__sandbox_exec — ~6.0k');
  });

  it('flags a file that was read more than once', () => {
    const prompt = buildTokenTuningPrompt(payload());

    expect(prompt).toContain('/repo/docs/spec.md — ~10k — read 3× (each read costs again)');
    expect(prompt).toContain('/repo/README.md — ~500');
    expect(prompt).not.toContain('README.md — ~500 — read');
  });

  it('carries the heaviest individual calls with their paths shortened', () => {
    const prompt = buildTokenTuningPrompt(payload());

    expect(prompt).toContain('sandbox_exec — 5 calls, 1 failed — ~8.0k');
    expect(prompt).toContain('~6.0k: uv run …/thing/scripts/fetch.py --id 7');
    // A failed call returned nothing, so it is not an example of heavy output.
    expect(prompt).not.toContain(': boom');
  });

  it('leaves out read tools whose bytes are already listed as files', () => {
    const prompt = buildTokenTuningPrompt(payload());
    const section = prompt.slice(prompt.indexOf('Heaviest tool results'));

    expect(section).not.toContain('filesystem_read');
  });

  it('says the run compacted when it did', () => {
    expect(buildTokenTuningPrompt(payload())).not.toContain('compacted');
    expect(buildTokenTuningPrompt(payload({ compacted: true }))).toContain('compacted its context');
  });

  it('appends the operator note as a focus line', () => {
    const prompt = buildTokenTuningPrompt(payload(), '  keep the research step  ');

    expect(prompt).toContain('Focus on: keep the research step');
  });

  it('survives a run that recorded nothing but its id', () => {
    const bare: SessionContextPayload = {
      sessionId: 'ses_empty',
      agent: { id: 'a', name: 'a' },
      layers: [],
      tools: [],
      fileReads: [],
      traffic: { outputChars: 0, outputEstTokens: 0, toolResultChars: 0, toolResultEstTokens: 0, toolResults: [] },
      totals: { chars: 0, estTokens: 0, withFileReadsEstTokens: 0 },
    };

    const prompt = buildTokenTuningPrompt(bare);

    expect(prompt).toContain('ses_empty');
    expect(prompt).toContain('Opening prompt: ~0');
    expect(prompt).not.toContain('Heaviest');
  });
});

describe('the window-limit line', () => {
  it('reads a million-token window as 1M, not 1000k', () => {
    const prompt = buildTokenTuningPrompt(payload({
      measured: {
        input: 300_000, output: 2_000, reasoning: 0, cacheRead: 0, cacheWrite: 0,
        context: { activeTokens: 65_000, contextLimit: 1_000_000, usagePercentage: 6.5, compactions: 0 },
      },
    }));

    expect(prompt).toContain('Peak window: 6.5% of 1M');
  });
});
