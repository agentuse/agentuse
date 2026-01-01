import { ulid } from 'ulid';
import { mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { runAgent } from '../runner/run.js';
import { prepareAgentExecution } from '../runner/preparation.js';
import { connectMCP } from '../mcp.js';
import { substituteModel, substituteTemplateVariables, type LoadedSuite, type LoadedTest } from './loader.js';
import {
  type BenchmarkRunConfig,
  type TrialResult,
  type ScenarioResult,
  type AgentResult,
  type SuiteResult,
  type Scenario,
  type GoalMetrics,
  type ToolMetrics,
  type ErrorCategory,
  type ErrorCounts,
  type TokenEfficiency,
  type ToolCallTrace,
} from './types.js';
import { evaluateCompletion } from './evaluator/completion.js';
import { evaluateArtifacts } from './evaluator/artifacts.js';
import type { ParsedAgent } from '../parser.js';
import { logger } from '../utils/logger.js';
import { GoalTracker } from './goal-tracker.js';
import { createGoalTools, GOAL_TRACKING_PROMPT } from './goal-tools.js';

/**
 * Run a single trial of a scenario
 */
async function runTrial(
  agent: ParsedAgent,
  scenario: Scenario,
  trialNumber: number,
  config: BenchmarkRunConfig,
  agentFilePath: string
): Promise<TrialResult> {
  const startTime = Date.now();
  let timeToFirstToken: number | undefined;

  // Substitute dynamic variables ({{$uuid}}, {{$timestamp}}, etc.) for this trial
  const scenarioInput = substituteTemplateVariables(scenario.input);

  // Create a temp directory for this trial's artifacts
  const trialDir = join(
    config.outputDir ?? '.agentuse/benchmark',
    'trials',
    `${scenario.id}-${trialNumber}`
  );
  await mkdir(trialDir, { recursive: true });

  // Set up abort controller with timeout
  const abortController = new AbortController();
  const timeout = config.timeout ?? 300;
  const timeoutId = setTimeout(() => abortController.abort(), timeout * 1000);

  try {
    // Connect MCP servers from agent config
    const mcpClients = await connectMCP(
      agent.config.mcpServers,
      false,
      dirname(config.suitePath)
    );

    try {
      // Use agent directory as projectRoot for skill discovery and cwd for bash commands
      const projectRoot = dirname(agentFilePath);
      const projectContext = { projectRoot, cwd: projectRoot };

      // Create goal tracker for this trial
      const goalTracker = new GoalTracker();
      const goalTools = createGoalTools(goalTracker);

      // Use the core preparation logic to get skills, tools, etc.
      const preparedExecution = await prepareAgentExecution({
        agent,
        mcpClients,
        agentFilePath,
        cliMaxSteps: config.maxSteps,
        projectContext,
        userPrompt: scenarioInput,
        abortSignal: abortController.signal,
        verbose: config.verbose ?? false,
      });

      // Inject goal tracking tools and prompt
      preparedExecution.tools = { ...preparedExecution.tools, ...goalTools };
      preparedExecution.systemMessages.push({
        role: 'system',
        content: GOAL_TRACKING_PROMPT,
      });

      // Run the agent with pre-computed execution context
      const result = await runAgent(
        agent,
        mcpClients,
        false, // debug
        abortController.signal,
        startTime,
        config.verbose ?? false,
        agentFilePath,
        config.maxSteps,
        undefined, // sessionManager
        projectContext,
        scenarioInput, // userPrompt - this is the scenario goal (with substituted variables)
        preparedExecution
      );

      clearTimeout(timeoutId);

      const durationMs = Date.now() - startTime;

      // Extract tool names from traces
      const toolNames = result.toolCallTraces?.map((t) => t.name) ?? [];

      // Evaluate output if validation is specified
      let outputValid = true;
      let validationDetails = '';

      if (scenario.expected.output) {
        const evalResult = await evaluateCompletion(
          result.text,
          scenario.expected.output
        );
        outputValid = evalResult.valid;
        validationDetails = evalResult.details;
      }

      // Evaluate artifacts if expectations are specified
      let artifactResult = {
        checked: 0,
        passed: 0,
        details: [] as Array<{ path: string; exists: boolean; containsMatch: boolean }>,
      };

      if (scenario.expected.artifacts && scenario.expected.artifacts.length > 0) {
        const evalResult = await evaluateArtifacts(
          scenario.expected.artifacts,
          projectRoot // Use agent's project root for artifact paths
        );
        artifactResult = {
          checked: evalResult.checked,
          passed: evalResult.passed,
          details: evalResult.details.map((d) => ({
            path: d.path,
            exists: d.exists,
            containsMatch: d.containsMatch,
          })),
        };
      }

      // Process goal tracking
      if (result.toolCallTraces) {
        goalTracker.processTraces(result.toolCallTraces);
      }
      const trackedGoals = goalTracker.getGoals();
      const goalMetrics = goalTracker.getMetrics();

      return {
        trialNumber,
        execution: {
          success: true,
          durationMs,
          ...(timeToFirstToken !== undefined && { timeToFirstTokenMs: timeToFirstToken }),
          finishReason: result.finishReason ?? 'unknown',
        },
        usage: {
          inputTokens: result.usage?.inputTokens ?? 0,
          outputTokens: result.usage?.outputTokens ?? 0,
          totalTokens: result.usage?.totalTokens ?? 0,
          // Note: estimatedCostUsd is calculated at display time from current model registry
          // to avoid stale pricing in stored results
        },
        toolCalls: {
          total: result.toolCallCount,
          names: toolNames,
          traces: result.toolCallTraces ?? [],
        },
        output: {
          text: result.text,
          valid: outputValid,
          ...(validationDetails && { validationDetails }),
        },
        artifacts: artifactResult,
        goals: {
          tracked: trackedGoals,
          metrics: goalMetrics,
        },
      };
    } finally {
      // Clean up MCP clients
      for (const connection of mcpClients) {
        try {
          await connection.client.close();
        } catch {
          // Ignore cleanup errors
        }
      }
    }
  } catch (error) {
    clearTimeout(timeoutId);
    const durationMs = Date.now() - startTime;

    const isAbort =
      error instanceof Error &&
      (error.name === 'AbortError' || abortController.signal.aborted);

    const errorInfo = {
      type: error instanceof Error ? error.name : 'unknown',
      message: error instanceof Error ? error.message : String(error),
      category: isAbort ? 'timeout' as ErrorCategory : 'runtime_error' as ErrorCategory,
    };

    return {
      trialNumber,
      execution: {
        success: false,
        durationMs,
        finishReason: isAbort ? 'timeout' : 'error',
        error: errorInfo,
      },
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        estimatedCostUsd: 0,
      },
      toolCalls: {
        total: 0,
        names: [],
        traces: [],
      },
      output: {
        text: '',
        valid: false,
        validationDetails: isAbort
          ? `Timeout after ${timeout}s`
          : `Error: ${error instanceof Error ? error.message : String(error)}`,
      },
      artifacts: {
        checked: 0,
        passed: 0,
        details: [],
      },
    };
  } finally {
    // Clean up trial directory
    try {
      await rm(trialDir, { recursive: true, force: true });
    } catch {
      // Ignore cleanup errors
    }
  }
}

/**
 * Calculate statistics for an array of numbers
 */
function calculateStats(values: number[]): {
  mean: number;
  median: number;
  p95: number;
  stdDev: number;
} {
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
  const successRate =
    trials.filter((t) => t.execution.success && t.output.valid).length /
    trials.length;
  return 1 - Math.pow(1 - successRate, runs);
}

/**
 * Aggregate per-tool metrics from tool call traces
 */
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

/**
 * Aggregate error counts from trials
 */
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

/**
 * Merge error counts from multiple sources
 */
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

/**
 * Calculate token efficiency from successful trials
 */
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

/**
 * Average token efficiency across multiple sources
 */
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

/**
 * Aggregate goal metrics across multiple trials
 */
function aggregateGoalMetrics(trials: TrialResult[]): GoalMetrics | undefined {
  const trialsWithGoals = trials.filter((t) => t.goals && t.goals.tracked.length > 0);
  if (trialsWithGoals.length === 0) {
    return undefined;
  }

  const allMetrics = trialsWithGoals.map((t) => t.goals!.metrics);

  // Average all metrics
  const totalGoals = allMetrics.reduce((sum, m) => sum + m.totalGoals, 0);
  const completedGoals = allMetrics.reduce((sum, m) => sum + m.completedGoals, 0);
  const failedGoals = allMetrics.reduce((sum, m) => sum + m.failedGoals, 0);
  const abandonedGoals = allMetrics.reduce((sum, m) => sum + m.abandonedGoals, 0);

  // Weighted averages for rates (handle undefined for backwards compatibility)
  const avgGoalCompletionRate =
    allMetrics.reduce((sum, m) => sum + m.goalCompletionRate, 0) / allMetrics.length;
  const avgAttemptsPerGoal =
    allMetrics.reduce((sum, m) => sum + m.avgAttemptsPerGoal, 0) / allMetrics.length;
  const avgToolCallSuccessRate =
    allMetrics.reduce((sum, m) => sum + m.toolCallSuccessRate, 0) / allMetrics.length;
  // toolCallFailureRate = 1 - toolCallSuccessRate (derive if missing for backwards compat)
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
    // toolCallEfficiency is calculated at cross-model comparison stage
    recoveryRate: avgRecoveryRate,
  };
}

/**
 * Run all trials for a scenario and aggregate results
 */
async function runScenario(
  agent: ParsedAgent,
  scenario: Scenario,
  model: string,
  runs: number,
  config: BenchmarkRunConfig,
  agentFilePath: string
): Promise<ScenarioResult> {
  logger.info(`  Scenario: ${scenario.name} (${runs} runs)`);

  const trials: TrialResult[] = [];

  for (let i = 0; i < runs; i++) {
    logger.info(`    Trial ${i + 1}/${runs}...`);
    const trial = await runTrial(agent, scenario, i + 1, config, agentFilePath);
    trials.push(trial);

    // Check cost budget
    if (config.budgetUsd) {
      const totalCost = trials.reduce(
        (sum, t) => sum + (t.usage.estimatedCostUsd ?? 0),
        0
      );
      if (totalCost > config.budgetUsd) {
        logger.warn(`Cost budget exceeded ($${totalCost.toFixed(2)} > $${config.budgetUsd})`);
        break;
      }
    }
  }

  // Calculate metrics
  const durations = trials.map((t) => t.execution.durationMs);
  const validCosts = trials
    .map((t) => t.usage.estimatedCostUsd)
    .filter((c): c is number => c !== undefined);
  const toolCounts = trials.map((t) => t.toolCalls.total);

  // Get unique tools used across all trials
  const uniqueTools = [
    ...new Set(trials.flatMap((t) => t.toolCalls.names)),
  ];

  const latencyStats = calculateStats(durations);
  const successfulTrials = trials.filter(
    (t) => t.execution.success && t.output.valid
  );
  const completionRate = successfulTrials.length / trials.length;
  const passK = calculatePassK(trials, runs);

  // Consistency: low variance = high consistency
  const outcomes = trials.map((t) =>
    t.execution.success && t.output.valid ? 1 : 0
  );
  const consistency = 1 - calculateStats(outcomes).stdDev;

  // Aggregate goal metrics across trials
  const goalMetrics = aggregateGoalMetrics(trials);

  // Calculate new metrics
  const allTraces = trials.flatMap((t) => t.toolCalls.traces);
  const perToolMetrics = aggregateToolMetrics(allTraces);
  const tokenEfficiency = calculateTokenEfficiency(trials);
  const errorCounts = aggregateErrorCounts(trials);

  // Cost per success
  const validSuccessCosts = successfulTrials
    .map((t) => t.usage.estimatedCostUsd)
    .filter((c): c is number => c !== undefined);
  const costPerSuccess =
    validSuccessCosts.length > 0
      ? validSuccessCosts.reduce((sum, c) => sum + c, 0) / validSuccessCosts.length
      : undefined;

  return {
    scenarioId: scenario.id,
    scenarioName: scenario.name,
    agentPath: '', // Will be set by caller
    model,
    ...(scenario.difficulty && { difficulty: scenario.difficulty }),
    trials,
    metrics: {
      completionRate,
      passK,
      consistency,
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
        meanCount: toolCounts.reduce((a, b) => a + b, 0) / toolCounts.length,
        uniqueTools,
        perToolMetrics,
      },
      ...(tokenEfficiency && { tokenEfficiency }),
      errorCounts,
      ...(goalMetrics && { goals: goalMetrics }),
    },
  };
}

/**
 * Run all scenarios for an agent with a specific model
 */
async function runAgentBenchmark(
  test: LoadedTest,
  model: string,
  runs: number,
  config: BenchmarkRunConfig
): Promise<AgentResult> {
  logger.info(`Agent: ${test.agent.name} (model: ${model})`);

  // Substitute model placeholder in agent config
  const agent = substituteModel(test.agent, model);

  const scenarios: ScenarioResult[] = [];

  for (const scenario of test.scenarios) {
    const result = await runScenario(agent, scenario, model, runs, config, test.agentPath);
    result.agentPath = test.agentPath;
    scenarios.push(result);
  }

  // Calculate aggregate metrics
  const completionRates = scenarios.map((s) => s.metrics.completionRate);
  const passKs = scenarios.map((s) => s.metrics.passK);
  const consistencies = scenarios.map((s) => s.metrics.consistency);
  const latencies = scenarios.map((s) => s.metrics.latency.meanMs);
  const validCosts = scenarios
    .map((s) => s.metrics.cost.totalUsd)
    .filter((c): c is number => c !== undefined);

  // Calculate mean tool calls for successful trials (efficiency calculated later via relative comparison)
  const successfulTrials = scenarios.flatMap((s) =>
    s.trials.filter((t) => t.execution.success && t.output.valid)
  );
  const meanToolCalls =
    successfulTrials.length > 0
      ? successfulTrials.reduce((sum, t) => sum + t.toolCalls.total, 0) /
        successfulTrials.length
      : 0;
  // Efficiency will be calculated after all models complete (relative to best performer per scenario)
  const efficiency = 0;

  // Aggregate goal metrics across all trials in all scenarios
  const allTrials = scenarios.flatMap((s) => s.trials);
  const agentGoalMetrics = aggregateGoalMetrics(allTrials);

  // Aggregate new metrics
  const agentTokenEfficiency = averageTokenEfficiency(
    scenarios.map((s) => s.metrics.tokenEfficiency)
  );
  const agentErrorCounts = mergeErrorCounts(
    scenarios.map((s) => s.metrics.errorCounts).filter((e): e is ErrorCounts => e !== undefined)
  );

  // Cost per success aggregated across all successful trials
  const validSuccessCosts = successfulTrials
    .map((t) => t.usage.estimatedCostUsd)
    .filter((c): c is number => c !== undefined);
  const costPerSuccess =
    validSuccessCosts.length > 0
      ? validSuccessCosts.reduce((sum, c) => sum + c, 0) / validSuccessCosts.length
      : undefined;

  return {
    agentPath: test.agentPath,
    agentName: test.agent.name,
    model,
    scenarios,
    aggregate: {
      completionRate:
        completionRates.reduce((a, b) => a + b, 0) / completionRates.length,
      passK: passKs.reduce((a, b) => a + b, 0) / passKs.length,
      consistency:
        consistencies.reduce((a, b) => a + b, 0) / consistencies.length,
      efficiency,
      meanToolCalls,
      latencyMeanMs: latencies.reduce((a, b) => a + b, 0) / latencies.length,
      ...(validCosts.length > 0 && { totalCostUsd: validCosts.reduce((a, b) => a + b, 0) }),
      ...(costPerSuccess !== undefined && { costPerSuccessUsd: costPerSuccess }),
      ...(agentTokenEfficiency && { tokenEfficiency: agentTokenEfficiency }),
      errorCounts: agentErrorCounts,
      ...(agentGoalMetrics && { goals: agentGoalMetrics }),
    },
  };
}

/**
 * Calculate relative efficiency for all models based on per-scenario comparison.
 * Efficiency = minToolCalls / meanToolCalls (best performer per scenario = 1.0)
 */
function calculateRelativeEfficiency(
  modelResults: SuiteResult['modelResults']
): void {
  // Collect all scenario results grouped by scenarioId
  const scenariosByModel: Map<
    string, // scenarioId
    Array<{ model: string; agentIdx: number; scenarioIdx: number; meanToolCalls: number }>
  > = new Map();

  for (const [model, result] of Object.entries(modelResults)) {
    for (let agentIdx = 0; agentIdx < result.agents.length; agentIdx++) {
      const agent = result.agents[agentIdx];
      for (let scenarioIdx = 0; scenarioIdx < agent.scenarios.length; scenarioIdx++) {
        const scenario = agent.scenarios[scenarioIdx];
        const scenarioId = scenario.scenarioId;

        // Calculate mean tool calls for successful trials in this scenario
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

  // For each scenario, find minimum tool calls and calculate relative efficiency
  for (const [, entries] of scenariosByModel) {
    // Only consider entries with successful completions (meanToolCalls > 0)
    const successfulEntries = entries.filter((e) => e.meanToolCalls > 0);
    if (successfulEntries.length === 0) continue;

    const minToolCalls = Math.min(...successfulEntries.map((e) => e.meanToolCalls));

    // Update efficiency for each entry (relative to best performer)
    for (const entry of entries) {
      const efficiency =
        entry.meanToolCalls > 0 ? minToolCalls / entry.meanToolCalls : 0;

      // Update the scenario's metrics
      const agent = modelResults[entry.model].agents[entry.agentIdx];
      const scenario = agent.scenarios[entry.scenarioIdx];
      scenario.metrics.efficiency = efficiency;
    }
  }

  // Calculate scenario-level goal toolCallEfficiency
  // Compare avgAttemptsPerGoal across models for each scenario
  const scenarioGoalsByModel: Map<
    string, // scenarioId
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

  // For each scenario, find minimum avgAttemptsPerGoal and calculate relative efficiency
  for (const [, entries] of scenarioGoalsByModel) {
    if (entries.length === 0) continue;

    const minAttempts = Math.min(...entries.map((e) => e.avgAttemptsPerGoal));

    for (const entry of entries) {
      const goalEfficiency = minAttempts / entry.avgAttemptsPerGoal;

      // Update the scenario's goal metrics
      const agent = modelResults[entry.model].agents[entry.agentIdx];
      const scenario = agent.scenarios[entry.scenarioIdx];
      if (scenario.metrics.goals) {
        scenario.metrics.goals.toolCallEfficiency = goalEfficiency;
      }
    }
  }

  // Now recalculate agent-level and model-level efficiency aggregates
  for (const [_model, result] of Object.entries(modelResults)) {
    for (const agent of result.agents) {
      // Average efficiency across scenarios for this agent
      const scenarioEfficiencies = agent.scenarios
        .map((s) => s.metrics.efficiency ?? 0);
      agent.aggregate.efficiency =
        scenarioEfficiencies.length > 0
          ? scenarioEfficiencies.reduce((a, b) => a + b, 0) / scenarioEfficiencies.length
          : 0;
    }

    // Recalculate model-level efficiency
    const agentEfficiencies = result.agents.map((a) => a.aggregate.efficiency);
    result.aggregate.efficiency =
      agentEfficiencies.length > 0
        ? agentEfficiencies.reduce((a, b) => a + b, 0) / agentEfficiencies.length
        : 0;

    // Recalculate overall score with new efficiency
    result.aggregate.overallScore =
      result.aggregate.passK * 60 +
      result.aggregate.efficiency * 40;
  }

  // Calculate goal toolCallEfficiency (relative efficiency based on avgAttemptsPerGoal)
  // Lower avgAttemptsPerGoal = better efficiency
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

/**
 * Run the full benchmark suite
 */
export async function runBenchmarkSuite(
  loadedSuite: LoadedSuite,
  config: BenchmarkRunConfig
): Promise<SuiteResult> {
  const { suite, tests } = loadedSuite;
  const runId = ulid();
  const startTime = Date.now();

  // Use config overrides or suite defaults
  const models = config.models ?? suite.config.models;
  const runs = config.runs ?? suite.config.runs;

  logger.info(`\nBenchmark: ${suite.name}`);
  logger.info(`Models: ${models.join(', ')}`);
  logger.info(`Runs per scenario: ${runs}`);
  logger.info(`Total scenarios: ${tests.reduce((sum, t) => sum + t.scenarios.length, 0)}`);
  logger.separator();

  const modelResults: SuiteResult['modelResults'] = {};

  for (const model of models) {
    logger.info(`\n=== Model: ${model} ===\n`);

    const agents: AgentResult[] = [];

    for (const test of tests) {
      const agentResult = await runAgentBenchmark(test, model, runs, config);
      agents.push(agentResult);
    }

    // Calculate model aggregate
    const completionRates = agents.map((a) => a.aggregate.completionRate);
    const passKs = agents.map((a) => a.aggregate.passK);
    const consistencies = agents.map((a) => a.aggregate.consistency);
    const efficiencies = agents.map((a) => a.aggregate.efficiency);
    const toolCalls = agents.map((a) => a.aggregate.meanToolCalls);
    const latencies = agents.map((a) => a.aggregate.latencyMeanMs);
    const validCosts = agents
      .map((a) => a.aggregate.totalCostUsd)
      .filter((c): c is number => c !== undefined);

    const avgCompletionRate =
      completionRates.reduce((a, b) => a + b, 0) / completionRates.length;
    const avgPassK = passKs.reduce((a, b) => a + b, 0) / passKs.length;
    const avgConsistency =
      consistencies.reduce((a, b) => a + b, 0) / consistencies.length;
    const avgEfficiency =
      efficiencies.reduce((a, b) => a + b, 0) / efficiencies.length;
    const avgMeanToolCalls =
      toolCalls.reduce((a, b) => a + b, 0) / toolCalls.length;

    // Aggregate goal metrics across all agents
    const allModelTrials = agents.flatMap((a) =>
      a.scenarios.flatMap((s) => s.trials)
    );
    const modelGoalMetrics = aggregateGoalMetrics(allModelTrials);

    // Aggregate new metrics
    const modelTokenEfficiency = averageTokenEfficiency(
      agents.map((a) => a.aggregate.tokenEfficiency)
    );
    const modelErrorCounts = mergeErrorCounts(
      agents.map((a) => a.aggregate.errorCounts).filter((e): e is ErrorCounts => e !== undefined)
    );

    // Cost per success aggregated across all successful trials
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

    // Overall score: weighted combination (agentic capability focus)
    // 60% passK (reliability - probability of at least one success in k trials)
    // 40% efficiency (fewer tool calls = higher efficiency)
    // Note: Speed excluded intentionally - this is a capability benchmark, not infrastructure
    const overallScore =
      avgPassK * 60 + avgEfficiency * 40;

    modelResults[model] = {
      agents,
      aggregate: {
        completionRate: avgCompletionRate,
        passK: avgPassK,
        consistency: avgConsistency,
        efficiency: avgEfficiency,
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

  // Calculate relative efficiency across all models for each scenario
  // This updates efficiency values based on best performer per scenario
  calculateRelativeEfficiency(modelResults);

  // Create ranking
  const ranking = Object.entries(modelResults)
    .map(([model, result]) => ({
      model,
      score: result.aggregate.overallScore,
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
    .sort((a, b) => b.score - a.score)
    .map((entry, index) => ({
      ...entry,
      rank: index + 1,
    }));

  const totalScenarios = tests.reduce(
    (sum, t) => sum + t.scenarios.length,
    0
  );

  return {
    suiteId: suite.id,
    suiteName: suite.name,
    runId,
    timestamp: startTime,
    durationMs: Date.now() - startTime,
    config: {
      models,
      runs,
      totalScenarios,
      totalTrials: totalScenarios * models.length * runs,
    },
    modelResults,
    ranking,
  };
}
