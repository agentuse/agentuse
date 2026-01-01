import { z } from 'zod';
import { getModelFromRegistry } from '../generated/models';

// ============ Expected Output Validation ============

export const ContainsValidationSchema = z.object({
  type: z.literal('contains'),
  values: z.array(z.string()),
});

export const RegexValidationSchema = z.object({
  type: z.literal('regex'),
  pattern: z.string(),
});

export const LLMJudgeValidationSchema = z.object({
  type: z.literal('llm-judge'),
  criteria: z.string(),
  model: z.string().optional(), // defaults to gpt-5.2-mini
});

export const OutputValidationSchema = z.discriminatedUnion('type', [
  ContainsValidationSchema,
  RegexValidationSchema,
  LLMJudgeValidationSchema,
]);

export type OutputValidation = z.infer<typeof OutputValidationSchema>;

// ============ Artifact Validation ============

export const ArtifactExpectationSchema = z.object({
  path: z.string(),
  exists: z.boolean().default(true),
  contains: z.array(z.string()).optional(),
});

export type ArtifactExpectation = z.infer<typeof ArtifactExpectationSchema>;

// ============ Scenario (embedded in suite) ============

export const ScenarioSchema = z.object({
  id: z.string(),
  name: z.string(),
  difficulty: z.enum(['easy', 'medium', 'hard']).optional(),
  input: z.string(), // Goal/problem given to agent
  expected: z.object({
    artifacts: z.array(ArtifactExpectationSchema).optional(),
    output: OutputValidationSchema.optional(),
  }),
});

export type Scenario = z.infer<typeof ScenarioSchema>;

// ============ Test (agent + scenarios) ============

export const TestSchema = z.object({
  agent: z.string(), // path to .agentuse file
  scenarios: z.array(ScenarioSchema),
});

export type Test = z.infer<typeof TestSchema>;

// ============ Suite Configuration ============

export const SuiteConfigSchema = z.object({
  models: z.array(z.string()),
  runs: z.number().int().positive().default(3), // number of trials per scenario
  timeout: z.number().positive().default(300), // seconds
  maxSteps: z.number().int().positive().default(30),
});

export type SuiteConfig = z.infer<typeof SuiteConfigSchema>;

// ============ Benchmark Suite ============

export const BenchmarkSuiteSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  config: SuiteConfigSchema,
  tests: z.array(TestSchema),
});

export type BenchmarkSuite = z.infer<typeof BenchmarkSuiteSchema>;

// ============ Tool Call Trace (from existing types) ============

export interface ToolCallTrace {
  name: string;
  type: 'tool' | 'subagent' | 'llm';
  startTime: number;
  duration: number;
  tokens?: number;
  success?: boolean;
  input?: unknown;
}

// ============ Goal Tracking ============

/**
 * A tracked goal declared by the agent during execution
 */
export interface TrackedGoal {
  id: string;
  name: string;
  description?: string;
  startTime: number;
  endTime?: number;
  status: 'active' | 'completed' | 'failed' | 'abandoned';
  toolCalls: Array<{
    name: string;
    success: boolean;
    duration: number;
  }>;
}

/**
 * Aggregated metrics for goal tracking
 */
export interface GoalMetrics {
  totalGoals: number;
  completedGoals: number;
  failedGoals: number;
  abandonedGoals: number;
  goalCompletionRate: number;       // completed / total (0-1)
  avgAttemptsPerGoal: number;       // tool calls per goal
  toolCallSuccessRate: number;      // successful calls / total calls (0-1)
  toolCallFailureRate: number;      // failed calls / total calls (0-1)
  toolCallEfficiency?: number;      // relative efficiency vs best performer (0-1), calculated post-run
  recoveryRate: number;             // goals completed after a failure (0-1)
}

// ============ Token Efficiency ============

/**
 * Token efficiency metrics - tokens per successful completion
 */
export interface TokenEfficiency {
  inputPerSuccess: number;
  outputPerSuccess: number;
  totalPerSuccess: number;
}

// ============ Tool Metrics ============

/**
 * Per-tool success rate metrics
 */
export interface ToolMetrics {
  name: string;
  totalCalls: number;
  successfulCalls: number;
  failedCalls: number;
  successRate: number;    // 0-1
  avgDurationMs: number;
}

// ============ Error Categorization ============

export type ErrorCategory =
  | 'timeout'
  | 'runtime_error'
  | 'validation_failure'
  | 'tool_error'
  | 'unknown';

export interface ErrorCounts {
  timeout: number;
  runtime_error: number;
  validation_failure: number;
  tool_error: number;
  unknown: number;
}

// ============ Trial Result ============

export interface TrialResult {
  trialNumber: number;
  seed?: number;

  execution: {
    success: boolean;
    durationMs: number;
    timeToFirstTokenMs?: number;
    finishReason: string;
    error?: {
      type: string;
      message: string;
      category: ErrorCategory;
    };
  };

  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd?: number; // undefined if model pricing not available
  };

  toolCalls: {
    total: number;
    names: string[];
    traces: ToolCallTrace[];
  };

  output: {
    text: string;
    valid: boolean;
    validationDetails?: string;
  };

  artifacts: {
    checked: number;
    passed: number;
    details: Array<{
      path: string;
      exists: boolean;
      containsMatch: boolean;
    }>;
  };

  goals?: {
    tracked: TrackedGoal[];
    metrics: GoalMetrics;
  };
}

// ============ Scenario Result (aggregated across trials) ============

export interface ScenarioResult {
  scenarioId: string;
  scenarioName: string;
  agentPath: string;
  model: string;
  difficulty?: 'easy' | 'medium' | 'hard';

  trials: TrialResult[];

  metrics: {
    completionRate: number; // 0-1, proportion of successful trials
    passK: number; // 0-1, probability of at least one success in k trials
    consistency: number; // 0-1, low variance = high consistency
    efficiency?: number; // 0-1, relative efficiency vs best performer (calculated post-run)

    latency: {
      meanMs: number;
      medianMs: number;
      p95Ms: number;
      stdDevMs: number;
    };

    cost: {
      meanUsd?: number; // undefined if model pricing not available
      totalUsd?: number; // undefined if model pricing not available
      perSuccessUsd?: number; // cost per successful completion
    };

    toolCalls: {
      meanCount: number;
      uniqueTools: string[];
      perToolMetrics?: ToolMetrics[];
    };

    tokenEfficiency?: TokenEfficiency;
    errorCounts?: ErrorCounts;
    goals?: GoalMetrics;
  };
}

// ============ Agent Result (all scenarios for one agent) ============

export interface AgentResult {
  agentPath: string;
  agentName: string;
  model: string;
  scenarios: ScenarioResult[];

  aggregate: {
    completionRate: number;
    passK: number;
    consistency: number; // 0-1, average consistency across scenarios
    efficiency: number; // 0-1, fewer tool calls = higher efficiency (only successful trials)
    meanToolCalls: number; // Raw average tool calls (successful trials only)
    latencyMeanMs: number;
    totalCostUsd?: number; // undefined if model pricing not available
    costPerSuccessUsd?: number;
    tokenEfficiency?: TokenEfficiency;
    errorCounts?: ErrorCounts;
    goals?: GoalMetrics;
    weightedScore?: number; // Difficulty-weighted score (0-100), undefined if no difficulties set
  };
}

// ============ Suite Result (full benchmark run) ============

export interface SuiteResult {
  suiteId: string;
  suiteName: string;

  runId: string; // ULID
  timestamp: number;
  durationMs: number;

  config: {
    models: string[];
    runs: number;
    totalScenarios: number;
    totalTrials: number;
  };

  // Results per model
  modelResults: Record<string, {
    agents: AgentResult[];
    aggregate: {
      completionRate: number;
      passK: number;
      consistency: number; // 0-1, average consistency across all scenarios
      efficiency: number; // 0-1, fewer tool calls = higher efficiency
      meanToolCalls: number; // Raw average tool calls (successful trials only)
      latencyMeanMs: number;
      totalCostUsd?: number; // undefined if model pricing not available
      costPerSuccessUsd?: number;
      tokenEfficiency?: TokenEfficiency;
      errorCounts?: ErrorCounts;
      overallScore: number; // 0-100
      weightedScore?: number; // Difficulty-weighted score (0-100), undefined if no difficulties set
      goals?: GoalMetrics;
    };
  }>;

  // Comparative ranking
  ranking: Array<{
    model: string;
    rank: number;
    score: number;
    weightedScore?: number; // Difficulty-weighted score, undefined if no difficulties set
    completionRate: number;
    passK: number;
    consistency: number;
    efficiency: number;
    meanToolCalls: number; // Raw figure for display
    costUsd?: number; // undefined if model pricing not available
    costPerSuccessUsd?: number;
    goals?: {
      completionRate: number;
      avgAttempts: number;
      toolCallSuccessRate: number;
      toolCallFailureRate: number;
      toolCallEfficiency?: number;
      recoveryRate: number;
    };
  }>;
}

// ============ Raw Benchmark Result (for JSON storage) ============

/**
 * Raw trial entry - minimal data needed to reconstruct metrics
 */
export interface RawTrialEntry {
  model: string;
  agentPath: string;
  agentName: string;
  scenarioId: string;
  scenarioName: string;
  difficulty?: 'easy' | 'medium' | 'hard';
  trial: TrialResult;
}

/**
 * Raw benchmark result - stored in JSON
 * All metrics are computed from this data when loading
 */
export interface RawBenchmarkResult {
  version: 2;

  // Metadata
  suiteId: string;
  suiteName: string;
  runId: string;
  timestamp: number;
  durationMs: number;

  // Config
  config: {
    models: string[];
    runs: number;
  };

  // Raw trial data - flat array
  trials: RawTrialEntry[];
}

// ============ Model Pricing ============

/**
 * Calculate cost for a model based on token usage.
 * Pricing is fetched from the models.dev registry (see src/generated/models.ts).
 * Returns undefined if model is not in registry (no pricing available).
 * Note: models.dev provides cost in USD per million tokens.
 */
export function calculateCost(
  model: string,
  inputTokens: number,
  outputTokens: number
): number | undefined {
  const modelInfo = getModelFromRegistry(model);
  if (!modelInfo?.cost || (modelInfo.cost.input === 0 && modelInfo.cost.output === 0)) {
    return undefined;
  }

  // models.dev provides cost in USD per million tokens
  return (inputTokens * modelInfo.cost.input + outputTokens * modelInfo.cost.output) / 1_000_000;
}

// ============ Benchmark Run Configuration ============

export interface BenchmarkRunConfig {
  suitePath: string;
  models?: string[]; // Override suite config
  runs?: number; // Override trials per scenario
  timeout?: number;
  maxSteps?: number;
  budgetUsd?: number; // Stop if exceeded
  outputDir?: string;
  formats?: Array<'json' | 'markdown' | 'html'>;
  verbose?: boolean;
}
