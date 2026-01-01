import type { SuiteResult, ErrorCounts } from '../types.js';

/**
 * Shared data structure for benchmark reports.
 * Used by both HTML and Markdown reporters to ensure consistent output.
 */
export interface ReportData {
  version: string;
  generatedAt: number;
  runs: number; // trials per scenario - used to hide consistency when runs=1
  summary: {
    suiteId: string;
    suiteName: string;
    runId: string;
    totalScenarios: number;
    totalTrials: number;
    totalModels: number;
    totalCostUsd: number;
    runDurationMs: number;
  };
  models: Array<{
    id: string;
    name: string;
    provider: string;
    scores: {
      overall: number;
      weighted?: number; // Difficulty-weighted score
      completion: number;
      passK: number;
      consistency: number;
      efficiency: number;
    };
    latency: {
      meanMs: number;
      p95Ms: number;
    };
    cost: {
      total?: number; // undefined if model pricing not available
      perFullRun?: number; // avg cost to run all scenarios once
      perScenario?: number;
      perSuccess?: number;
    };
    goals?: {
      completionRate: number;
      avgAttempts: number;
      toolCallFailureRate: number;
      toolCallEfficiency?: number;
    };
    tokenEfficiency?: {
      inputPerSuccess: number;
      outputPerSuccess: number;
      totalPerSuccess: number;
    };
    errors?: ErrorCounts;
    errorDetails?: Array<{
      scenario: string;
      trial: number;
      type: string;
      message: string;
    }>;
  }>;
  scenarios: Array<{
    id: string;
    name: string;
    agentPath: string;
    difficulty?: string;
    results: Record<
      string,
      {
        completionRate: number;
        passK: number;
        consistency: number;
        latencyMs: number;
        costUsd?: number | undefined; // undefined if model pricing not available
        inputTokens: number;
        outputTokens: number;
        goals?: {
          completed: number;
          total: number;
          recoveryRate: number;
          avgAttempts: number;
          toolCallFailureRate: number;
          toolCallEfficiency?: number;
        };
      }
    >;
  }>;
  ranking: Array<{
    model: string;
    rank: number;
    score: number;
    weighted?: number; // Difficulty-weighted score
    consistency: number;
  }>;
}

/**
 * Calculate P95 from an array of values
 */
export function calculateP95(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.ceil(sorted.length * 0.95) - 1;
  return sorted[Math.max(0, idx)];
}

/**
 * Format duration in human-readable format
 */
export function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms}ms`;
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`;
  const minutes = Math.floor(ms / 60000);
  const seconds = ((ms % 60000) / 1000).toFixed(0);
  return `${minutes}m ${seconds}s`;
}

/**
 * Format cost in USD (returns '—' if undefined)
 */
export function formatCost(usd: number | undefined): string {
  if (usd === undefined) return '—';
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  if (usd < 1) return `$${usd.toFixed(3)}`;
  return `$${usd.toFixed(2)}`;
}

/**
 * Format percentage
 */
export function formatPercent(value: number): string {
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * Format token count (K/M suffixes)
 */
export function formatTokens(count: number): string {
  if (count >= 1000000) return `${(count / 1000000).toFixed(1)}M`;
  if (count >= 1000) return `${(count / 1000).toFixed(1)}K`;
  return count.toString();
}

/**
 * Generate shared data structure for benchmark reports
 */
export function generateReportData(result: SuiteResult): ReportData {
  const getProvider = (model: string): string => {
    const [provider] = model.split(':');
    return provider || 'unknown';
  };

  const getDisplayName = (model: string): string => {
    const parts = model.split(':');
    return parts[1] || model;
  };

  return {
    version: '1.0',
    generatedAt: Date.now(),
    runs: result.config.runs,

    summary: {
      suiteId: result.suiteId,
      suiteName: result.suiteName,
      runId: result.runId,
      totalScenarios: result.config.totalScenarios,
      totalTrials: result.config.totalTrials,
      totalModels: result.config.models.length,
      totalCostUsd: Object.values(result.modelResults).reduce(
        (sum, mr) => sum + (mr.aggregate.totalCostUsd ?? 0),
        0
      ),
      runDurationMs: result.durationMs,
    },

    models: Object.entries(result.modelResults).map(([model, mr]) => {
      const allTrialDurations = mr.agents.flatMap((a) =>
        a.scenarios.flatMap((s) => s.trials.map((t) => t.execution.durationMs))
      );
      const scenarioCount = mr.agents.reduce(
        (sum, a) => sum + a.scenarios.length,
        0
      );

      // Extract detailed error information from failed trials
      const errorDetails: Array<{
        scenario: string;
        trial: number;
        type: string;
        message: string;
      }> = [];
      for (const agent of mr.agents) {
        for (const scenario of agent.scenarios) {
          for (const trial of scenario.trials) {
            if (!trial.execution.success || !trial.output.valid) {
              errorDetails.push({
                scenario: scenario.scenarioName,
                trial: trial.trialNumber,
                type: trial.execution.error?.category ?? 'validation_failure',
                message:
                  trial.execution.error?.message ??
                  trial.output.validationDetails ??
                  'Unknown error',
              });
            }
          }
        }
      }

      return {
        id: model,
        name: getDisplayName(model),
        provider: getProvider(model),
        scores: {
          overall: mr.aggregate.overallScore,
          ...(mr.aggregate.weightedScore !== undefined && {
            weighted: mr.aggregate.weightedScore,
          }),
          completion: mr.aggregate.completionRate,
          passK: mr.aggregate.passK,
          consistency: mr.aggregate.consistency,
          efficiency: mr.aggregate.efficiency,
        },
        latency: {
          meanMs: mr.aggregate.latencyMeanMs,
          p95Ms: calculateP95(allTrialDurations),
        },
        cost: {
          ...(mr.aggregate.totalCostUsd !== undefined && {
            total: mr.aggregate.totalCostUsd,
            perFullRun: mr.aggregate.totalCostUsd / (result.config.runs || 1),
            perScenario: mr.aggregate.totalCostUsd / (scenarioCount || 1),
          }),
          ...(mr.aggregate.costPerSuccessUsd !== undefined && {
            perSuccess: mr.aggregate.costPerSuccessUsd,
          }),
        },
        ...(mr.aggregate.goals && {
          goals: {
            completionRate: mr.aggregate.goals.goalCompletionRate,
            avgAttempts: mr.aggregate.goals.avgAttemptsPerGoal,
            toolCallFailureRate: mr.aggregate.goals.toolCallFailureRate ?? (1 - mr.aggregate.goals.toolCallSuccessRate),
            ...(mr.aggregate.goals.toolCallEfficiency !== undefined && {
              toolCallEfficiency: mr.aggregate.goals.toolCallEfficiency,
            }),
          },
        }),
        ...(mr.aggregate.tokenEfficiency && {
          tokenEfficiency: mr.aggregate.tokenEfficiency,
        }),
        ...(mr.aggregate.errorCounts && {
          errors: mr.aggregate.errorCounts,
        }),
        ...(errorDetails.length > 0 && { errorDetails }),
      };
    }),

    scenarios: (() => {
      const scenarioMap = new Map<
        string,
        {
          id: string;
          name: string;
          agentPath: string;
          difficulty?: string;
          results: Record<
            string,
            {
              completionRate: number;
              passK: number;
              consistency: number;
              latencyMs: number;
              costUsd?: number; // undefined if model pricing not available
              inputTokens: number;
              outputTokens: number;
              goals?: {
                completed: number;
                total: number;
                recoveryRate: number;
                avgAttempts: number;
                toolCallFailureRate: number;
                toolCallEfficiency?: number;
              };
            }
          >;
        }
      >();

      for (const [model, mr] of Object.entries(result.modelResults)) {
        for (const agent of mr.agents) {
          for (const scenario of agent.scenarios) {
            if (!scenarioMap.has(scenario.scenarioId)) {
              scenarioMap.set(scenario.scenarioId, {
                id: scenario.scenarioId,
                name: scenario.scenarioName,
                agentPath: scenario.agentPath,
                ...(scenario.difficulty && { difficulty: scenario.difficulty }),
                results: {},
              });
            }

            const entry = scenarioMap.get(scenario.scenarioId)!;
            const goals = scenario.metrics.goals;
            // Calculate total input/output tokens from all trials
            const inputTokens = scenario.trials.reduce((sum, t) => sum + t.usage.inputTokens, 0);
            const outputTokens = scenario.trials.reduce((sum, t) => sum + t.usage.outputTokens, 0);
            entry.results[model] = {
              completionRate: scenario.metrics.completionRate,
              passK: scenario.metrics.passK,
              consistency: scenario.metrics.consistency,
              latencyMs: scenario.metrics.latency.meanMs,
              ...(scenario.metrics.cost.meanUsd !== undefined && {
                costUsd: scenario.metrics.cost.meanUsd,
              }),
              inputTokens,
              outputTokens,
              ...(goals && {
                goals: {
                  completed: goals.completedGoals,
                  total: goals.totalGoals,
                  recoveryRate: goals.recoveryRate,
                  avgAttempts: goals.avgAttemptsPerGoal,
                  // Derive toolCallFailureRate if missing (backwards compat)
                  toolCallFailureRate: goals.toolCallFailureRate ?? (1 - goals.toolCallSuccessRate),
                  ...(goals.toolCallEfficiency !== undefined && {
                    toolCallEfficiency: goals.toolCallEfficiency,
                  }),
                },
              }),
            };
          }
        }
      }

      return Array.from(scenarioMap.values());
    })(),

    ranking: result.ranking.map((r) => ({
      model: r.model,
      rank: r.rank,
      score: r.score,
      ...(r.weightedScore !== undefined && { weighted: r.weightedScore }),
      consistency: r.consistency,
    })),
  };
}

/**
 * Glossary definitions for report metrics
 */
export const GLOSSARY_ITEMS = [
  {
    term: 'Score',
    definition: 'Composite performance score (0-100): Pass@k x 50 + Efficiency x 30 + Tool Success Rate x 20. When difficulties are set, harder scenarios contribute more (easy=1x, medium=2x, hard=3x).',
  },
  {
    term: 'Unweighted',
    definition: 'Raw score treating all scenarios equally, regardless of difficulty. Shown for comparison when difficulty weighting is applied.',
  },
  {
    term: 'Completion',
    definition: 'Percentage of trials where the agent successfully completed the task with valid output.',
  },
  {
    term: 'Pass^k',
    definition: 'Pass@k metric: probability that at least one of k trials succeeds. Higher is better.',
  },
  {
    term: 'Consistency',
    definition: 'How reliably the model produces the same result across multiple trials (only shown when k > 1).',
  },
  {
    term: 'Efficiency',
    definition: 'Relative efficiency score comparing cost-performance ratio against the best model (0-100%).',
  },
  {
    term: 'Tools/Goal',
    definition: 'Average number of tool calls needed to complete each goal. Lower indicates more efficient tool usage.',
  },
  {
    term: 'Tool Failure',
    definition: 'Percentage of tool calls that failed (errors, invalid params). Lower is better.',
  },
  {
    term: 'Tool Efficiency',
    definition: 'Ratio of goals achieved to total tool calls made. Higher means fewer wasted calls per goal.',
  },
  {
    term: 'Recovery',
    definition: 'Percentage of failed tool calls that were successfully retried and recovered.',
  },
  {
    term: 'P95 Latency',
    definition: '95th percentile response time—95% of trials complete faster than this duration.',
  },
  {
    term: 'Avg Cost',
    definition: 'Average cost per run. In Model Ranking, this is the cost to run all scenarios once. In Scenarios Breakdown, this is the cost per trial.',
  },
  {
    term: 'Cost/Success',
    definition: 'Average cost per successful trial. Accounts for failed attempts, so lower is more cost-effective.',
  },
];
