import { ulid } from 'ulid';
import { mkdir, rm } from 'fs/promises';
import { join, dirname } from 'path';
import { runAgent } from '../runner/run.js';
import { prepareAgentExecution } from '../runner/preparation.js';
import { connectMCP } from '../mcp.js';
import {
  agentForBenchmarkModel,
  resolveSuiteConfig,
  substituteTemplateVariables,
  type LoadedSuite,
  type LoadedTest,
} from './loader.js';
import { resolveModelString } from '../utils/model-alias.js';
import {
  type BenchmarkRunConfig,
  type EffectiveSuiteConfig,
  type TrialResult,
  type RawTrialEntry,
  type SuiteResult,
  type Scenario,
  type ErrorCategory,
} from './types.js';
import { calculateMetrics } from './calculator.js';
import { evaluateCompletion } from './evaluator/completion.js';
import { evaluateArtifacts } from './evaluator/artifacts.js';
import { toErrorMessage } from '../utils/error-message.js';
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
  settings: EffectiveSuiteConfig,
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
  const timeout = settings.timeout;
  const timeoutId = setTimeout(() => abortController.abort(), timeout * 1000);
  const projectRoot = dirname(agentFilePath);

  try {
    // Connect MCP servers from agent config
    const mcpClients = await connectMCP(
      agent.config.mcpServers,
      false,
      dirname(config.suitePath),
      projectRoot
    );

    try {
      // Use agent directory as projectRoot for skill discovery and cwd for bash commands
      const projectContext = { projectRoot, stateRoot: projectRoot, cwd: projectRoot };

      // Create goal tracker for this trial
      const goalTracker = new GoalTracker();
      const goalTools = createGoalTools(goalTracker);

      // Use the core preparation logic to get skills, tools, etc.
      const preparedExecution = await prepareAgentExecution({
        agent,
        mcpClients,
        agentFilePath,
        cliMaxSteps: settings.maxSteps,
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
        settings.maxSteps,
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
      message: toErrorMessage(error),
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
          : `Error: ${toErrorMessage(error)}`,
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
 * Run every trial of one scenario and return them as raw entries.
 */
async function runScenario(
  test: LoadedTest,
  agent: ParsedAgent,
  scenario: Scenario,
  model: string,
  config: BenchmarkRunConfig,
  settings: EffectiveSuiteConfig
): Promise<RawTrialEntry[]> {
  const { runs } = settings;
  logger.info(`  Scenario: ${scenario.name} (${runs} runs)`);

  const entries: RawTrialEntry[] = [];
  for (let i = 0; i < runs; i++) {
    logger.info(`    Trial ${i + 1}/${runs}...`);
    const trial = await runTrial(agent, scenario, i + 1, config, settings, test.agentPath);
    entries.push({
      model,
      agentPath: test.agentPath,
      agentName: test.agent.name,
      scenarioId: scenario.id,
      scenarioName: scenario.name,
      ...(scenario.difficulty && { difficulty: scenario.difficulty }),
      trial,
    });

    // Check cost budget
    if (settings.budgetUsd) {
      const totalCost = entries.reduce(
        (sum, e) => sum + (e.trial.usage.estimatedCostUsd ?? 0),
        0
      );
      if (totalCost > settings.budgetUsd) {
        logger.warn(`Cost budget exceeded ($${totalCost.toFixed(2)} > $${settings.budgetUsd})`);
        break;
      }
    }
  }
  return entries;
}

/**
 * Run the full benchmark suite.
 *
 * The runner only records raw trials. Every metric, score, and ranking comes
 * from {@link calculateMetrics}, the same function that re-scores a saved JSON
 * result, so the live report and a later view of its file always agree.
 */
export async function runBenchmarkSuite(
  loadedSuite: LoadedSuite,
  config: BenchmarkRunConfig
): Promise<SuiteResult> {
  const { suite, tests } = loadedSuite;
  const runId = ulid();
  const startTime = Date.now();

  const settings = resolveSuiteConfig(suite.config, config);
  const { runs } = settings;
  // Resolve each suite model once; trials are labelled and priced by the
  // concrete id they actually ran.
  const targets = settings.models.map((requested) => ({
    requested,
    resolved: resolveModelString(requested),
  }));
  const models = targets.map((target) => target.resolved.model);

  logger.info(`\nBenchmark: ${suite.name}`);
  logger.info(`Models: ${models.join(', ')}`);
  logger.info(`Runs per scenario: ${runs}`);
  logger.info(`Total scenarios: ${tests.reduce((sum, t) => sum + t.scenarios.length, 0)}`);
  logger.separator();

  const trials: RawTrialEntry[] = [];
  for (const target of targets) {
    const model = target.resolved.model;
    logger.info(`\n=== Model: ${model} ===\n`);
    for (const test of tests) {
      logger.info(`Agent: ${test.agent.name} (model: ${model})`);
      const agent = agentForBenchmarkModel(test.agent, target);
      for (const scenario of test.scenarios) {
        trials.push(...await runScenario(test, agent, scenario, model, config, settings));
      }
    }
  }

  return calculateMetrics({
    version: 2,
    suiteId: suite.id,
    suiteName: suite.name,
    runId,
    timestamp: startTime,
    durationMs: Date.now() - startTime,
    // Persist what actually ran: the resolved models and every effective setting.
    config: { ...settings, models },
    trials,
  });
}
