import { ulid } from 'ulid';
import { cp, mkdir, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join, dirname, resolve } from 'path';
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
import { evaluateTrial } from './evaluator/index.js';
import { getGitRootSync, getProjectDirSync } from '../storage/paths.js';
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
  agentFilePath: string,
  workspace: string
): Promise<TrialResult> {
  const startTime = Date.now();
  let timeToFirstToken: number | undefined;

  // Substitute dynamic variables ({{$uuid}}, {{$timestamp}}, etc.) for this trial
  const scenarioInput = substituteTemplateVariables(scenario.input);

  // Set up abort controller with timeout
  const abortController = new AbortController();
  const timeout = settings.timeout;
  const timeoutId = setTimeout(() => abortController.abort(), timeout * 1000);
  const projectRoot = dirname(agentFilePath);

  try {
    await prepareTrialWorkspace(workspace, scenario, config);

    // Connect MCP servers from agent config
    const mcpClients = await connectMCP(
      agent.config.mcpServers,
      false,
      dirname(config.suitePath),
      projectRoot
    );

    try {
      // The agent directory stays projectRoot, so skills and ${agentDir} resolve
      // as usual. The trial's own workspace is its cwd (files it writes, and
      // the artifacts it is judged on) and its stateRoot (learnings it
      // captures), so nothing one trial leaves behind reaches the next trial,
      // another model, or the agent's real state.
      const projectContext = { projectRoot, stateRoot: workspace, cwd: workspace };

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

      // Process goal tracking
      if (result.toolCallTraces) {
        goalTracker.processTraces(result.toolCallTraces);
      }
      const trackedGoals = goalTracker.getGoals();
      const goalMetrics = goalTracker.getMetrics();

      // One verdict per trial, from the output and the artifacts together,
      // judged in the same workspace the agent ran in.
      return await evaluateTrial({
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
        output: { text: result.text, valid: false },
        artifacts: { checked: 0, passed: 0, details: [] },
        goals: {
          tracked: trackedGoals,
          metrics: goalMetrics,
        },
      }, scenario, workspace);
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
    await removeTrialWorkspace(workspace);
  }
}

/** A fresh workspace, seeded from the scenario's fixture directory if it has one. */
async function prepareTrialWorkspace(
  workspace: string,
  scenario: Scenario,
  config: BenchmarkRunConfig
): Promise<void> {
  await rm(workspace, { recursive: true, force: true });
  await mkdir(workspace, { recursive: true });
  if (scenario.fixture) {
    await cp(resolve(dirname(config.suitePath), scenario.fixture), workspace, { recursive: true });
  }
}

/**
 * Remove a trial workspace and the per-project state the run keyed on it.
 * Workspaces live outside any repository, so that state directory belongs to
 * this trial alone; the check keeps a temp dir that somehow sits inside a
 * repository from ever deleting that repository's state.
 */
async function removeTrialWorkspace(workspace: string): Promise<void> {
  try {
    if (getGitRootSync(workspace) === null) {
      await rm(getProjectDirSync(workspace), { recursive: true, force: true });
    }
    await rm(workspace, { recursive: true, force: true });
  } catch (error) {
    logger.warn(`Could not remove benchmark workspace ${workspace}: ${toErrorMessage(error)}`);
  }
}

/** Path-safe form of a model id, agent name, or scenario id. */
function pathSegment(value: string): string {
  return value.replace(/[^\w.-]+/g, '_');
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
  settings: EffectiveSuiteConfig,
  workspaceRoot: string
): Promise<RawTrialEntry[]> {
  const { runs } = settings;
  logger.info(`  Scenario: ${scenario.name} (${runs} runs)`);

  const entries: RawTrialEntry[] = [];
  for (let i = 0; i < runs; i++) {
    logger.info(`    Trial ${i + 1}/${runs}...`);
    const workspace = join(
      workspaceRoot,
      pathSegment(model),
      pathSegment(test.agent.name),
      pathSegment(scenario.id),
      `trial-${i + 1}`
    );
    const trial = await runTrial(agent, scenario, i + 1, config, settings, test.agentPath, workspace);
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

  // Trial workspaces live under the system temp dir, outside any repository,
  // keyed by run so concurrent runs never share one.
  const workspaceRoot = join(tmpdir(), 'agentuse-benchmark', runId);
  const trials: RawTrialEntry[] = [];
  try {
    for (const target of targets) {
      const model = target.resolved.model;
      logger.info(`\n=== Model: ${model} ===\n`);
      for (const test of tests) {
        logger.info(`Agent: ${test.agent.name} (model: ${model})`);
        const agent = agentForBenchmarkModel(test.agent, target);
        for (const scenario of test.scenarios) {
          trials.push(...await runScenario(test, agent, scenario, model, config, settings, workspaceRoot));
        }
      }
    }
  } finally {
    await rm(workspaceRoot, { recursive: true, force: true }).catch(() => {});
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
