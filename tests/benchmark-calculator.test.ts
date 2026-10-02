import { describe, expect, it } from 'bun:test';
import { calculateMetrics } from '../src/benchmark/calculator';
import type { RawBenchmarkResult, RawTrialEntry, TrialResult } from '../src/benchmark/types';

// $1 per million input tokens in the shipped registry, so 1M input tokens = $1.
const PRICED = 'anthropic:claude-haiku-4-5';
const UNPRICED = 'demo:test';

function trial(over: { success?: boolean; valid?: boolean; inputTokens?: number } = {}): TrialResult {
  const success = over.success ?? true;
  return {
    trialNumber: 1,
    execution: { success, durationMs: 100, finishReason: success ? 'stop' : 'error' },
    usage: { inputTokens: over.inputTokens ?? 1_000_000, outputTokens: 0, totalTokens: over.inputTokens ?? 1_000_000 },
    toolCalls: { total: 1, names: ['bash'], traces: [] },
    output: { text: 'done', valid: over.valid ?? true },
    artifacts: { checked: 0, passed: 0, details: [] },
  };
}

function raw(model: string, trials: TrialResult[]): RawBenchmarkResult {
  const entries: RawTrialEntry[] = trials.map((t) => ({
    model,
    agentPath: '/agents/a.agentuse',
    agentName: 'a',
    scenarioId: 's1',
    scenarioName: 'Scenario 1',
    trial: t,
  }));
  return {
    version: 2,
    suiteId: 'suite',
    suiteName: 'Suite',
    runId: 'run',
    timestamp: 0,
    durationMs: 0,
    config: { models: [model], runs: trials.length },
    trials: entries,
  };
}

describe('benchmark Cost/Success', () => {
  it('divides the spend of every attempt, failed ones included, by the successes', () => {
    // One success and one validation failure at $1 each: a success costs $2.
    const result = calculateMetrics(raw(PRICED, [trial(), trial({ valid: false })]));
    const model = result.modelResults[PRICED]!;
    expect(model.agents[0]!.scenarios[0]!.metrics.cost.perSuccessUsd).toBeCloseTo(2);
    expect(model.agents[0]!.aggregate.costPerSuccessUsd).toBeCloseTo(2);
    expect(model.aggregate.costPerSuccessUsd).toBeCloseTo(2);
    expect(result.ranking[0]!.costPerSuccessUsd).toBeCloseTo(2);
  });

  it('is undefined when nothing succeeded', () => {
    const result = calculateMetrics(raw(PRICED, [trial({ valid: false }), trial({ success: false })]));
    expect(result.modelResults[PRICED]!.aggregate.costPerSuccessUsd).toBeUndefined();
    expect(result.ranking[0]!.costPerSuccessUsd).toBeUndefined();
  });

  it('is undefined when the price is unknown, even if a failed trial stored a zero', () => {
    const failed = trial({ success: false, inputTokens: 0 });
    failed.usage.estimatedCostUsd = 0;
    const result = calculateMetrics(raw(UNPRICED, [trial(), failed]));
    expect(result.modelResults[UNPRICED]!.aggregate.costPerSuccessUsd).toBeUndefined();
  });
});
