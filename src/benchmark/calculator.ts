/**
 * Benchmark metrics calculator
 * Computes all derived metrics from raw trial data
 */

import {
  type RawBenchmarkResult,
  type RawTrialEntry,
  type SuiteResult,
  type ScenarioResult,
  type AgentResult,
  type TrialResult,
  type GoalMetrics,
  type ToolMetrics,
  type ErrorCounts,
  type TokenEfficiency,
  type ToolCallTrace,
  calculateCost,
} from './types.js';

// ============ Difficulty Weights ============

/**
 * Weights for difficulty levels when calculating weighted scores
 * Higher difficulty = higher weight in the final score
 */
const DIFFICULTY_WEIGHTS: Record<'easy' | 'medium' | 'hard', number> = {
  easy: 1,
  medium: 2,
  hard: 3,
};

// ============ Stats Helpers ============

interface Stats {
  mean: number;
  median: number;
  p95: number;
  stdDev: number;
}

function calculateStats(values: number[]): Stats {
  if (values.length === 0) {
    return { mean: 0, median: 0, p95: 0, stdDev: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const median = sorted[Math.floor(sorted.length / 2)];
  const p95Index = Math.ceil(sorted.length * 0.95) - 1;
  const p95 = sorted[Math.max(0, p95Index)];

  const variance =
    values.reduce((sum, val) => sum + Math.pow(val - mean, 2), 0) /
    values.length;
  const stdDev = Math.sqrt(variance);

  return { mean, median, p95, stdDev };
}

/**
 * Calculate pass@k metric
 * pass@k = probability of at least one success in k trials
 * pass@k = 1 - (1 - p)^k where p is single-trial success rate
 */
function calculatePassK(trials: TrialResult[], runs: number): number {
  if (trials.length === 0) return 0;
  const successRate =
    trials.filter((t) => t.execution.success && t.output.valid).length /
    trials.length;
  return 1 - Math.pow(1 - successRate, runs);
}

/**
 * Calculate difficulty-weighted score for scenarios
 * Returns undefined if no scenarios have difficulty set
 *
 * @param scenarios - Array of scenario results
 * @returns Weighted score 0-100 or undefined if no difficulties
 */
function calculateWeightedScore(
  scenarios: Array<{
    passK: number;
    efficiency: number;
    toolSuccessRate: number;
    difficulty: 'easy' | 'medium' | 'hard' | undefined;
  }>
): number | undefined {
  const scenariosWithDifficulty = scenarios.filter(s => s.difficulty !== undefined);

  // Only calculate weighted score if at least one scenario has difficulty set
  if (scenariosWithDifficulty.length === 0) {
    return undefined;
  }

  let weightedPassK = 0;
  let weightedEfficiency = 0;
  let weightedToolSuccessRate = 0;
  let totalWeight = 0;

  for (const scenario of scenarios) {
    // Use weight 1 for scenarios without difficulty (treat as easy)
    const weight = scenario.difficulty ? DIFFICULTY_WEIGHTS[scenario.difficulty] : 1;
    weightedPassK += scenario.passK * weight;
    weightedEfficiency += scenario.efficiency * weight;
    weightedToolSuccessRate += scenario.toolSuccessRate * weight;
    totalWeight += weight;
  }

  if (totalWeight === 0) return undefined;

  const avgWeightedPassK = weightedPassK / totalWeight;
  const avgWeightedEfficiency = weightedEfficiency / totalWeight;
  const avgWeightedToolSuccessRate = weightedToolSuccessRate / totalWeight;

  // Formula: passK × 50 + efficiency × 30 + toolSuccessRate × 20
  return avgWeightedPassK * 50 + avgWeightedEfficiency * 30 + avgWeightedToolSuccessRate * 20;
}

// ============ Aggregation Helpers ============

function aggregateToolMetrics(traces: ToolCallTrace[]): ToolMetrics[] {
  const toolMap = new Map<
    string,
    { total: number; success: number; durations: number[] }
  >();

  for (const trace of traces) {
    if (trace.type !== 'tool') continue;

    if (!toolMap.has(trace.name)) {
      toolMap.set(trace.name, { total: 0, success: 0, durations: [] });
    }

    const entry = toolMap.get(trace.name)!;
    entry.total++;
    if (trace.success !== false) entry.success++;
    entry.durations.push(trace.duration);
  }

  return Array.from(toolMap.entries()).map(([name, data]) => ({
    name,
    totalCalls: data.total,
    successfulCalls: data.success,
    failedCalls: data.total - data.success,
    successRate: data.total > 0 ? data.success / data.total : 1,
    avgDurationMs:
      data.durations.length > 0
        ? data.durations.reduce((a, b) => a + b, 0) / data.durations.length
        : 0,
  }));
}

function aggregateErrorCounts(trials: TrialResult[]): ErrorCounts {
  const counts: ErrorCounts = {
    timeout: 0,
    runtime_error: 0,
    validation_failure: 0,
    tool_error: 0,
    unknown: 0,
  };

  for (const trial of trials) {
    if (!trial.execution.success || !trial.output.valid) {
      const category =
        trial.execution.error?.category ??
        (trial.output.valid ? 'unknown' : 'validation_failure');
      counts[category]++;
    }
  }

  return counts;
}

function mergeErrorCounts(allCounts: ErrorCounts[]): ErrorCounts {
  const merged: ErrorCounts = {
    timeout: 0,
    runtime_error: 0,
    validation_failure: 0,
    tool_error: 0,
    unknown: 0,
  };

  for (const counts of allCounts) {
    merged.timeout += counts.timeout;
    merged.runtime_error += counts.runtime_error;
    merged.validation_failure += counts.validation_failure;
    merged.tool_error += counts.tool_error;
    merged.unknown += counts.unknown;
  }

  return merged;
}

function calculateTokenEfficiency(
  trials: TrialResult[]
): TokenEfficiency | undefined {
  const successfulTrials = trials.filter(
    (t) => t.execution.success && t.output.valid
  );
  if (successfulTrials.length === 0) return undefined;

  return {
    inputPerSuccess:
      successfulTrials.reduce((sum, t) => sum + t.usage.inputTokens, 0) /
      successfulTrials.length,
    outputPerSuccess:
      successfulTrials.reduce((sum, t) => sum + t.usage.outputTokens, 0) /
      successfulTrials.length,
    totalPerSuccess:
      successfulTrials.reduce((sum, t) => sum + t.usage.totalTokens, 0) /
      successfulTrials.length,
  };
}

function averageTokenEfficiency(
  efficiencies: (TokenEfficiency | undefined)[]
): TokenEfficiency | undefined {
  const valid = efficiencies.filter((e): e is TokenEfficiency => e !== undefined);
  if (valid.length === 0) return undefined;

  return {
    inputPerSuccess:
      valid.reduce((sum, e) => sum + e.inputPerSuccess, 0) / valid.length,
    outputPerSuccess:
      valid.reduce((sum, e) => sum + e.outputPerSuccess, 0) / valid.length,
    totalPerSuccess:
      valid.reduce((sum, e) => sum + e.totalPerSuccess, 0) / valid.length,
  };
}

function aggregateGoalMetrics(trials: TrialResult[]): GoalMetrics | undefined {
  const trialsWithGoals = trials.filter((t) => t.goals && t.goals.tracked.length > 0);
  if (trialsWithGoals.length === 0) {
    return undefined;
  }

  const allMetrics = trialsWithGoals.map((t) => t.goals!.metrics);

  const totalGoals = allMetrics.reduce((sum, m) => sum + m.totalGoals, 0);
  const completedGoals = allMetrics.reduce((sum, m) => sum + m.completedGoals, 0);
  const failedGoals = allMetrics.reduce((sum, m) => sum + m.failedGoals, 0);
  const abandonedGoals = allMetrics.reduce((sum, m) => sum + m.abandonedGoals, 0);

  const avgGoalCompletionRate =
    allMetrics.reduce((sum, m) => sum + m.goalCompletionRate, 0) / allMetrics.length;
  const avgAttemptsPerGoal =
    allMetrics.reduce((sum, m) => sum + m.avgAttemptsPerGoal, 0) / allMetrics.length;
  const avgToolCallSuccessRate =
    allMetrics.reduce((sum, m) => sum + m.toolCallSuccessRate, 0) / allMetrics.length;
  const avgToolCallFailureRate =
    allMetrics.reduce((sum, m) => sum + (m.toolCallFailureRate ?? (1 - m.toolCallSuccessRate)), 0) / allMetrics.length;
  const avgRecoveryRate =
    allMetrics.reduce((sum, m) => sum + m.recoveryRate, 0) / allMetrics.length;

  return {
    totalGoals,
    completedGoals,
    failedGoals,
    abandonedGoals,
    goalCompletionRate: avgGoalCompletionRate,
    avgAttemptsPerGoal,
    toolCallSuccessRate: avgToolCallSuccessRate,
    toolCallFailureRate: avgToolCallFailureRate,
    recoveryRate: avgRecoveryRate,
  };
}

// ============ Scenario Metrics ============

function calculateScenarioMetrics(
  trials: TrialResult[],
  scenarioId: string,
  scenarioName: string,
  agentPath: string,
  model: string,
  runs: number,
  difficulty?: 'easy' | 'medium' | 'hard'
): ScenarioResult {
  const successfulTrials = trials.filter(
    (t) => t.execution.success && t.output.valid
  );
  const completionRate = trials.length > 0 ? successfulTrials.length / trials.length : 0;
  const passK = calculatePassK(trials, runs);

  // Consistency: low variance = high consistency
  const outcomes = trials.map((t) =>
    t.execution.success && t.output.valid ? 1 : 0
  );
  const consistency = 1 - calculateStats(outcomes).stdDev;

  // Latency stats
  const latencies = trials.map((t) => t.execution.durationMs);
  const latencyStats = calculateStats(latencies);

  // Cost stats - filter out undefined costs
  const validCosts = trials
    .map((t) => t.usage.estimatedCostUsd)
    .filter((c): c is number => c !== undefined);
  const validSuccessCosts = successfulTrials
    .map((t) => t.usage.estimatedCostUsd)
    .filter((c): c is number => c !== undefined);
  const costPerSuccess =
    validSuccessCosts.length > 0
      ? validSuccessCosts.reduce((sum, c) => sum + c, 0) / validSuccessCosts.length
      : undefined;

  // Tool call stats (from successful trials only)
  const toolCounts = successfulTrials.map((t) => t.toolCalls.total);
  const uniqueTools = [...new Set(trials.flatMap((t) => t.toolCalls.names))];
  const allTraces = trials.flatMap((t) => t.toolCalls.traces);
  const perToolMetrics = aggregateToolMetrics(allTraces);

  // Goal metrics
  const goalMetrics = aggregateGoalMetrics(trials);

  // Token efficiency and errors
  const tokenEfficiency = calculateTokenEfficiency(trials);
  const errorCounts = aggregateErrorCounts(trials);

  return {
    scenarioId,
    scenarioName,
    agentPath,
    model,
    ...(difficulty && { difficulty }),
    trials,
    metrics: {
      completionRate,
      passK,
      consistency,
      // efficiency is calculated later in cross-model comparison
      latency: {
        meanMs: latencyStats.mean,
        medianMs: latencyStats.median,
        p95Ms: latencyStats.p95,
        stdDevMs: latencyStats.stdDev,
      },
      cost: {
        ...(validCosts.length > 0 && {
          meanUsd: validCosts.reduce((a, b) => a + b, 0) / validCosts.length,
          totalUsd: validCosts.reduce((a, b) => a + b, 0),
        }),
        ...(costPerSuccess !== undefined && { perSuccessUsd: costPerSuccess }),
      },
      toolCalls: {
        meanCount: toolCounts.length > 0 ? toolCounts.reduce((a, b) => a + b, 0) / toolCounts.length : 0,
        uniqueTools,
        perToolMetrics,
      },
      ...(tokenEfficiency && { tokenEfficiency }),
      errorCounts,
      ...(goalMetrics && { goals: goalMetrics }),
    },
  };
}

// ============ Relative Efficiency ============

function calculateRelativeEfficiency(
  modelResults: SuiteResult['modelResults']
): void {
  // Collect all scenario results grouped by scenarioId
  const scenariosByModel: Map<
    string,
    Array<{ model: string; agentIdx: number; scenarioIdx: number; meanToolCalls: number }>
  > = new Map();

  for (const [model, result] of Object.entries(modelResults)) {
    for (let agentIdx = 0; agentIdx < result.agents.length; agentIdx++) {
      const agent = result.agents[agentIdx];
      for (let scenarioIdx = 0; scenarioIdx < agent.scenarios.length; scenarioIdx++) {
        const scenario = agent.scenarios[scenarioIdx];
        const scenarioId = scenario.scenarioId;

        const successfulTrials = scenario.trials.filter(
          (t) => t.execution.success && t.output.valid
        );
        const meanToolCalls =
          successfulTrials.length > 0
            ? successfulTrials.reduce((sum, t) => sum + t.toolCalls.total, 0) /
              successfulTrials.length
            : 0;

        if (!scenariosByModel.has(scenarioId)) {
          scenariosByModel.set(scenarioId, []);
        }
        scenariosByModel.get(scenarioId)!.push({
          model,
          agentIdx,
          scenarioIdx,
          meanToolCalls,
        });
      }
    }
  }

  // Calculate tool call efficiency per scenario
  for (const [, entries] of scenariosByModel) {
    const successfulEntries = entries.filter((e) => e.meanToolCalls > 0);
    if (successfulEntries.length === 0) continue;

    const minToolCalls = Math.min(...successfulEntries.map((e) => e.meanToolCalls));

    for (const entry of entries) {
      const efficiency =
        entry.meanToolCalls > 0 ? minToolCalls / entry.meanToolCalls : 0;

      const agent = modelResults[entry.model].agents[entry.agentIdx];
      const scenario = agent.scenarios[entry.scenarioIdx];
      scenario.metrics.efficiency = efficiency;
    }
  }

  // Calculate scenario-level goal toolCallEfficiency
  const scenarioGoalsByModel: Map<
    string,
    Array<{ model: string; agentIdx: number; scenarioIdx: number; avgAttemptsPerGoal: number }>
  > = new Map();

  for (const [model, result] of Object.entries(modelResults)) {
    for (let agentIdx = 0; agentIdx < result.agents.length; agentIdx++) {
      const agent = result.agents[agentIdx];
      for (let scenarioIdx = 0; scenarioIdx < agent.scenarios.length; scenarioIdx++) {
        const scenario = agent.scenarios[scenarioIdx];
        const goals = scenario.metrics.goals;
        if (!goals || goals.avgAttemptsPerGoal <= 0) continue;

        const scenarioId = scenario.scenarioId;
        if (!scenarioGoalsByModel.has(scenarioId)) {
          scenarioGoalsByModel.set(scenarioId, []);
        }
        scenarioGoalsByModel.get(scenarioId)!.push({
          model,
          agentIdx,
          scenarioIdx,
          avgAttemptsPerGoal: goals.avgAttemptsPerGoal,
        });
      }
    }
  }

  for (const [, entries] of scenarioGoalsByModel) {
    if (entries.length === 0) continue;

    const minAttempts = Math.min(...entries.map((e) => e.avgAttemptsPerGoal));

    for (const entry of entries) {
      const goalEfficiency = minAttempts / entry.avgAttemptsPerGoal;

      const agent = modelResults[entry.model].agents[entry.agentIdx];
      const scenario = agent.scenarios[entry.scenarioIdx];
      if (scenario.metrics.goals) {
        scenario.metrics.goals.toolCallEfficiency = goalEfficiency;
      }
    }
  }

  // Recalculate agent-level and model-level efficiency aggregates
  for (const [_model, result] of Object.entries(modelResults)) {
    for (const agent of result.agents) {
      const scenarioEfficiencies = agent.scenarios
        .map((s) => s.metrics.efficiency ?? 0);
      agent.aggregate.efficiency =
        scenarioEfficiencies.length > 0
          ? scenarioEfficiencies.reduce((a, b) => a + b, 0) / scenarioEfficiencies.length
          : 0;

      // Calculate agent-level weighted score
      const agentScenarioData = agent.scenarios.map(s => ({
        passK: s.metrics.passK,
        efficiency: s.metrics.efficiency ?? 0,
        toolSuccessRate: s.metrics.goals?.toolCallSuccessRate ?? 1,
        difficulty: s.difficulty,
      }));
      const agentWeightedScore = calculateWeightedScore(agentScenarioData);
      if (agentWeightedScore !== undefined) {
        agent.aggregate.weightedScore = agentWeightedScore;
      }
    }

    const agentEfficiencies = result.agents.map((a) => a.aggregate.efficiency);
    result.aggregate.efficiency =
      agentEfficiencies.length > 0
        ? agentEfficiencies.reduce((a, b) => a + b, 0) / agentEfficiencies.length
        : 0;

    // Recalculate overall score
    // Formula: passK × 50 + efficiency × 30 + toolSuccessRate × 20
    const toolSuccessRate = result.aggregate.goals?.toolCallSuccessRate ?? 1;
    result.aggregate.overallScore =
      result.aggregate.passK * 50 +
      result.aggregate.efficiency * 30 +
      toolSuccessRate * 20;

    // Calculate model-level weighted score from all scenarios
    const allScenarioData = result.agents.flatMap(a =>
      a.scenarios.map(s => ({
        passK: s.metrics.passK,
        efficiency: s.metrics.efficiency ?? 0,
        toolSuccessRate: s.metrics.goals?.toolCallSuccessRate ?? 1,
        difficulty: s.difficulty,
      }))
    );
    const modelWeightedScore = calculateWeightedScore(allScenarioData);
    if (modelWeightedScore !== undefined) {
      result.aggregate.weightedScore = modelWeightedScore;
    }
  }

  // Calculate model-level goal toolCallEfficiency
  const modelsWithGoals = Object.entries(modelResults)
    .filter(([, result]) => result.aggregate.goals && result.aggregate.goals.avgAttemptsPerGoal > 0)
    .map(([model, result]) => ({
      model,
      avgAttemptsPerGoal: result.aggregate.goals!.avgAttemptsPerGoal,
    }));

  if (modelsWithGoals.length > 0) {
    const minAttempts = Math.min(...modelsWithGoals.map((m) => m.avgAttemptsPerGoal));

    for (const { model, avgAttemptsPerGoal } of modelsWithGoals) {
      const goalEfficiency = minAttempts / avgAttemptsPerGoal;
      if (modelResults[model].aggregate.goals) {
        modelResults[model].aggregate.goals.toolCallEfficiency = goalEfficiency;
      }
    }
  }
}

// ============ Main Calculator ============

/**
 * Calculate all metrics from raw benchmark data
 * This is the main entry point for computing SuiteResult from RawBenchmarkResult
 */
export function calculateMetrics(raw: RawBenchmarkResult): SuiteResult {
  const { suiteId, suiteName, runId, timestamp, durationMs, config, trials } = raw;
  // Support legacy 'k' field for backward compatibility with older JSON files
  const runs = config.runs ?? (config as { k?: number }).k ?? 1;

  // Recalculate costs using current model registry pricing
  // This ensures pricing updates are reflected when viewing old results
  for (const entry of trials) {
    const { inputTokens, outputTokens } = entry.trial.usage;
    const cost = calculateCost(entry.model, inputTokens, outputTokens);
    if (cost !== undefined) {
      entry.trial.usage.estimatedCostUsd = cost;
    }
  }

  // Group trials by model → agent → scenario
  const modelMap = new Map<string, Map<string, Map<string, RawTrialEntry[]>>>();

  for (const entry of trials) {
    if (!modelMap.has(entry.model)) {
      modelMap.set(entry.model, new Map());
    }
    const agentMap = modelMap.get(entry.model)!;

    if (!agentMap.has(entry.agentPath)) {
      agentMap.set(entry.agentPath, new Map());
    }
    const scenarioMap = agentMap.get(entry.agentPath)!;

    if (!scenarioMap.has(entry.scenarioId)) {
      scenarioMap.set(entry.scenarioId, []);
    }
    scenarioMap.get(entry.scenarioId)!.push(entry);
  }

  // Build model results
  const modelResults: SuiteResult['modelResults'] = {};

  for (const [model, agentMap] of modelMap) {
    const agents: AgentResult[] = [];

    for (const [agentPath, scenarioMap] of agentMap) {
      const scenarios: ScenarioResult[] = [];
      let agentName = '';

      for (const [scenarioId, entries] of scenarioMap) {
        const firstEntry = entries[0];
        agentName = firstEntry.agentName;

        const trialResults = entries.map((e) => e.trial);
        const scenarioResult = calculateScenarioMetrics(
          trialResults,
          scenarioId,
          firstEntry.scenarioName,
          agentPath,
          model,
          runs,
          firstEntry.difficulty
        );
        scenarios.push(scenarioResult);
      }

      // Calculate agent aggregate
      const completionRates = scenarios.map((s) => s.metrics.completionRate);
      const passKs = scenarios.map((s) => s.metrics.passK);
      const consistencies = scenarios.map((s) => s.metrics.consistency);
      const latencies = scenarios.map((s) => s.metrics.latency.meanMs);
      const validCosts = scenarios
        .map((s) => s.metrics.cost.totalUsd)
        .filter((c): c is number => c !== undefined);

      const allTrials = scenarios.flatMap((s) => s.trials);
      const successfulTrials = allTrials.filter(
        (t) => t.execution.success && t.output.valid
      );
      const toolCounts = successfulTrials.map((t) => t.toolCalls.total);

      const agentGoalMetrics = aggregateGoalMetrics(allTrials);
      const agentTokenEfficiency = averageTokenEfficiency(
        scenarios.map((s) => s.metrics.tokenEfficiency)
      );
      const agentErrorCounts = mergeErrorCounts(
        scenarios.map((s) => s.metrics.errorCounts).filter((e): e is ErrorCounts => e !== undefined)
      );
      const validSuccessCosts = successfulTrials
        .map((t) => t.usage.estimatedCostUsd)
        .filter((c): c is number => c !== undefined);
      const agentCostPerSuccess =
        validSuccessCosts.length > 0
          ? validSuccessCosts.reduce((sum, c) => sum + c, 0) / validSuccessCosts.length
          : undefined;

      agents.push({
        agentPath,
        agentName,
        model,
        scenarios,
        aggregate: {
          completionRate: completionRates.reduce((a, b) => a + b, 0) / completionRates.length,
          passK: passKs.reduce((a, b) => a + b, 0) / passKs.length,
          consistency: consistencies.reduce((a, b) => a + b, 0) / consistencies.length,
          efficiency: 0, // Calculated later
          meanToolCalls: toolCounts.length > 0 ? toolCounts.reduce((a, b) => a + b, 0) / toolCounts.length : 0,
          latencyMeanMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
          ...(validCosts.length > 0 && { totalCostUsd: validCosts.reduce((a, b) => a + b, 0) }),
          ...(agentCostPerSuccess !== undefined && { costPerSuccessUsd: agentCostPerSuccess }),
          ...(agentTokenEfficiency && { tokenEfficiency: agentTokenEfficiency }),
          errorCounts: agentErrorCounts,
          ...(agentGoalMetrics && { goals: agentGoalMetrics }),
        },
      });
    }

    // Calculate model aggregate
    const completionRates = agents.map((a) => a.aggregate.completionRate);
    const passKs = agents.map((a) => a.aggregate.passK);
    const consistencies = agents.map((a) => a.aggregate.consistency);
    const toolCalls = agents.map((a) => a.aggregate.meanToolCalls);
    const latencies = agents.map((a) => a.aggregate.latencyMeanMs);
    const validCosts = agents
      .map((a) => a.aggregate.totalCostUsd)
      .filter((c): c is number => c !== undefined);

    const avgCompletionRate = completionRates.reduce((a, b) => a + b, 0) / completionRates.length;
    const avgPassK = passKs.reduce((a, b) => a + b, 0) / passKs.length;
    const avgConsistency = consistencies.reduce((a, b) => a + b, 0) / consistencies.length;
    const avgMeanToolCalls = toolCalls.reduce((a, b) => a + b, 0) / toolCalls.length;

    const allModelTrials = agents.flatMap((a) => a.scenarios.flatMap((s) => s.trials));
    const modelGoalMetrics = aggregateGoalMetrics(allModelTrials);
    const modelTokenEfficiency = averageTokenEfficiency(
      agents.map((a) => a.aggregate.tokenEfficiency)
    );
    const modelErrorCounts = mergeErrorCounts(
      agents.map((a) => a.aggregate.errorCounts).filter((e): e is ErrorCounts => e !== undefined)
    );

    const successfulTrials = allModelTrials.filter(
      (t) => t.execution.success && t.output.valid
    );
    const validSuccessCosts = successfulTrials
      .map((t) => t.usage.estimatedCostUsd)
      .filter((c): c is number => c !== undefined);
    const modelCostPerSuccess =
      validSuccessCosts.length > 0
        ? validSuccessCosts.reduce((sum, c) => sum + c, 0) / validSuccessCosts.length
        : undefined;

    // Initial overall score (will be recalculated after efficiency and toolSuccessRate)
    const overallScore = avgPassK * 50; // efficiency and toolSuccessRate added later

    modelResults[model] = {
      agents,
      aggregate: {
        completionRate: avgCompletionRate,
        passK: avgPassK,
        consistency: avgConsistency,
        efficiency: 0, // Calculated later
        meanToolCalls: avgMeanToolCalls,
        latencyMeanMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
        ...(validCosts.length > 0 && { totalCostUsd: validCosts.reduce((a, b) => a + b, 0) }),
        ...(modelCostPerSuccess !== undefined && { costPerSuccessUsd: modelCostPerSuccess }),
        ...(modelTokenEfficiency && { tokenEfficiency: modelTokenEfficiency }),
        errorCounts: modelErrorCounts,
        overallScore,
        ...(modelGoalMetrics && { goals: modelGoalMetrics }),
      },
    };
  }

  // Calculate relative efficiency across all models
  calculateRelativeEfficiency(modelResults);

  // Build ranking
  const ranking = Object.entries(modelResults)
    .map(([model, result]) => ({
      model,
      score: result.aggregate.overallScore,
      ...(result.aggregate.weightedScore !== undefined && {
        weightedScore: result.aggregate.weightedScore,
      }),
      completionRate: result.aggregate.completionRate,
      passK: result.aggregate.passK,
      consistency: result.aggregate.consistency,
      efficiency: result.aggregate.efficiency,
      meanToolCalls: result.aggregate.meanToolCalls,
      ...(result.aggregate.totalCostUsd !== undefined && {
        costUsd: result.aggregate.totalCostUsd,
      }),
      ...(result.aggregate.costPerSuccessUsd !== undefined && {
        costPerSuccessUsd: result.aggregate.costPerSuccessUsd,
      }),
      ...(result.aggregate.goals && {
        goals: {
          completionRate: result.aggregate.goals.goalCompletionRate,
          avgAttempts: result.aggregate.goals.avgAttemptsPerGoal,
          toolCallSuccessRate: result.aggregate.goals.toolCallSuccessRate,
          toolCallFailureRate: result.aggregate.goals.toolCallFailureRate,
          ...(result.aggregate.goals.toolCallEfficiency !== undefined && {
            toolCallEfficiency: result.aggregate.goals.toolCallEfficiency,
          }),
          recoveryRate: result.aggregate.goals.recoveryRate,
        },
      }),
    }))
    // Sort by weighted score if available, otherwise by regular score
    .sort((a, b) => (b.weightedScore ?? b.score) - (a.weightedScore ?? a.score))
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));

  const totalScenarios = Object.values(modelResults).reduce(
    (sum, mr) => sum + mr.agents.reduce((s, a) => s + a.scenarios.length, 0),
    0
  ) / config.models.length;

  return {
    suiteId,
    suiteName,
    runId,
    timestamp,
    durationMs,
    config: {
      models: config.models,
      runs,
      totalScenarios,
      totalTrials: trials.length,
    },
    modelResults,
    ranking,
  };
}

/**
 * Extract raw data from a SuiteResult for storage
 * This is the inverse of calculateMetrics
 */
export function extractRawData(result: SuiteResult): RawBenchmarkResult {
  const trials: RawTrialEntry[] = [];

  for (const [model, mr] of Object.entries(result.modelResults)) {
    for (const agent of mr.agents) {
      for (const scenario of agent.scenarios) {
        for (const trial of scenario.trials) {
          trials.push({
            model,
            agentPath: agent.agentPath,
            agentName: agent.agentName,
            scenarioId: scenario.scenarioId,
            scenarioName: scenario.scenarioName,
            ...(scenario.difficulty && { difficulty: scenario.difficulty }),
            trial,
          });
        }
      }
    }
  }

  return {
    version: 2,
    suiteId: result.suiteId,
    suiteName: result.suiteName,
    runId: result.runId,
    timestamp: result.timestamp,
    durationMs: result.durationMs,
    config: {
      models: result.config.models,
      runs: result.config.runs,
    },
    trials,
  };
}
