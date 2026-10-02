import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import { tmpdir } from 'os';
import { join } from 'path';
import type { ParsedAgent } from '../src/parser';
import type { LoadedSuite } from '../src/benchmark/loader';
import type { BenchmarkRunConfig, Scenario, SuiteConfig } from '../src/benchmark/types';

mock.restore();

// No model provider is ever called: the agent run, its preparation, and MCP
// are stubbed, and each stubbed run is recorded for the assertions.
interface RecordedRun {
  model: string;
  modelCandidates?: string[];
  maxSteps?: number;
  projectContext?: { projectRoot: string; stateRoot: string; cwd: string };
}
let runs: RecordedRun[] = [];
let respond: (call: RecordedRun) => Promise<{
  text: string;
  inputTokens?: number;
  toolCalls?: number;
}> = async () => ({ text: 'done' });

mock.module('../src/mcp', () => ({ connectMCP: async () => [] }));
mock.module('../src/runner/preparation', () => ({
  prepareAgentExecution: async () => ({ tools: {}, systemMessages: [] }),
}));
mock.module('../src/runner/run', () => ({
  runAgent: async (
    agent: ParsedAgent,
    _mcp: unknown,
    _debug: boolean,
    _signal: AbortSignal,
    _start: number,
    _verbose: boolean,
    _agentFilePath: string,
    maxSteps: number | undefined,
    _sessionManager: unknown,
    projectContext: RecordedRun['projectContext'],
  ) => {
    const call: RecordedRun = {
      model: agent.config.model,
      ...(agent.config.modelCandidates && { modelCandidates: agent.config.modelCandidates }),
      ...(maxSteps !== undefined && { maxSteps }),
      ...(projectContext && { projectContext }),
    };
    runs.push(call);
    const reply = await respond(call);
    const inputTokens = reply.inputTokens ?? 1_000_000;
    return {
      text: reply.text,
      finishReason: 'stop',
      usage: { inputTokens, outputTokens: 0, totalTokens: inputTokens },
      toolCallCount: reply.toolCalls ?? 1,
      toolCallTraces: [],
    };
  },
}));

let runBenchmarkSuite: typeof import('../src/benchmark/runner').runBenchmarkSuite;
let calculateMetrics: typeof import('../src/benchmark/calculator').calculateMetrics;
let generateJsonReport: typeof import('../src/benchmark/reporter/json').generateJsonReport;

beforeAll(async () => {
  ({ runBenchmarkSuite } = await import('../src/benchmark/runner'));
  ({ calculateMetrics } = await import('../src/benchmark/calculator'));
  ({ generateJsonReport } = await import('../src/benchmark/reporter/json'));
});

// $1 per million input tokens in the shipped registry.
const PRICED = 'anthropic:claude-haiku-4-5';
const PRICED_B = 'anthropic:claude-sonnet-4-5';

let tempDir: string;
let agentPath: string;
let originalXdg: string | undefined;

beforeEach(() => {
  runs = [];
  respond = async () => ({ text: 'done' });
  tempDir = mkdtempSync(join(tmpdir(), 'benchmark-runner-'));
  // Trial state directories resolve under $XDG_DATA_HOME; keep them in the temp tree.
  originalXdg = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = join(tempDir, 'state');
  mkdirSync(join(tempDir, 'agents'), { recursive: true });
  agentPath = join(tempDir, 'agents', 'worker.agentuse');
  writeFileSync(agentPath, '---\nmodel: ${model}\n---\nDo the work.\n');
});

afterEach(() => {
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdg;
  rmSync(tempDir, { recursive: true, force: true });
});

function scenario(over: Partial<Scenario> = {}): Scenario {
  return {
    id: 'say-done',
    name: 'Say done',
    input: 'Say done.',
    expected: { output: { type: 'contains', values: ['done'] } },
    ...over,
  };
}

function suite(
  config: Partial<SuiteConfig> & { models: string[] },
  scenarios: Scenario[] = [scenario()],
  agentModel = '${model}',
): LoadedSuite {
  const agent: ParsedAgent = {
    name: 'worker',
    instructions: 'Do the work.',
    config: { model: agentModel } as ParsedAgent['config'],
  };
  return {
    suite: {
      id: 'suite',
      name: 'Suite',
      config: { runs: 1, timeout: 300, ...config },
      tests: [{ agent: 'agents/worker.agentuse', scenarios }],
    },
    suitePath: join(tempDir, 'suite.suite.yaml'),
    tests: [{ agent, agentPath, scenarios }],
  };
}

function runConfig(over: Partial<BenchmarkRunConfig> = {}): BenchmarkRunConfig {
  return { suitePath: join(tempDir, 'suite.suite.yaml'), outputDir: join(tempDir, 'results'), ...over };
}

describe('benchmark scoring', () => {
  it('scores the live result exactly as a reload of its saved JSON does', async () => {
    let call = 0;
    // Different tool counts and one miss, so efficiency and pass@k both matter.
    respond = async () => {
      call++;
      return call === 2 ? { text: 'nope', toolCalls: 3 } : { text: 'done', toolCalls: call };
    };
    const live = await runBenchmarkSuite(suite({ models: [PRICED, PRICED_B], runs: 2 }), runConfig());

    const reloaded = calculateMetrics(JSON.parse(generateJsonReport(live)));

    expect(live.ranking).toEqual(reloaded.ranking);
    expect(live.modelResults).toEqual(reloaded.modelResults);
    expect(live.config.totalTrials).toBe(reloaded.config.totalTrials);
  });
});

describe('benchmark model identity', () => {
  it('runs a fixed-model agent under each suite model, labelled by the model that ran', async () => {
    const loaded = suite({ models: [PRICED, PRICED_B] }, [scenario()], 'openai:gpt-5-mini');
    loaded.tests[0]!.agent.config.modelCandidates = ['openai:gpt-5-mini', 'openai:gpt-5'];

    const result = await runBenchmarkSuite(loaded, runConfig());

    expect(runs.map((r) => r.model)).toEqual([PRICED, PRICED_B]);
    // No fallback list survives: a trial measures exactly one model.
    expect(runs.every((r) => r.modelCandidates === undefined || r.modelCandidates.join() === r.model)).toBe(true);
    expect(Object.keys(result.modelResults)).toEqual([PRICED, PRICED_B]);
  });

  it('resolves a version alias to the concrete id it ran and prices it', async () => {
    const result = await runBenchmarkSuite(suite({ models: ['anthropic:claude-haiku'] }), runConfig());

    expect(runs.map((r) => r.model)).toEqual([PRICED]);
    expect(Object.keys(result.modelResults)).toEqual([PRICED]);
    expect(result.ranking[0]!.costUsd).toBeCloseTo(1);
  });
});

describe('benchmark effective settings', () => {
  it("passes the suite's maxSteps to every trial and persists the settings that ran", async () => {
    const result = await runBenchmarkSuite(suite({ models: [PRICED], runs: 2, timeout: 120, maxSteps: 7 }), runConfig());

    expect(runs.map((r) => r.maxSteps)).toEqual([7, 7]);
    const saved = JSON.parse(generateJsonReport(result));
    expect(saved.config).toEqual({ models: [PRICED], runs: 2, timeout: 120, maxSteps: 7 });
  });

  it('lets CLI flags win over the suite file', async () => {
    const result = await runBenchmarkSuite(
      suite({ models: [PRICED_B], runs: 3, timeout: 120, maxSteps: 7 }),
      runConfig({ models: [PRICED], runs: 1, timeout: 30, maxSteps: 2 }),
    );

    expect(runs.map((r) => [r.model, r.maxSteps])).toEqual([[PRICED, 2]]);
    expect(result.config).toMatchObject({ models: [PRICED], runs: 1, timeout: 30, maxSteps: 2 });
  });

  it("leaves each agent's own maxSteps in force when the suite sets none", async () => {
    const { BenchmarkSuiteSchema } = await import('../src/benchmark/types');
    const parsed = BenchmarkSuiteSchema.parse({
      id: 's', name: 'S', config: { models: [PRICED] }, tests: [],
    });
    expect(parsed.config.maxSteps).toBeUndefined();

    await runBenchmarkSuite(suite({ models: [PRICED] }), runConfig());
    expect(runs[0]!.maxSteps).toBeUndefined();
  });
});

describe('benchmark trial workspace and verdict', () => {
  const artifactScenario = (over: Partial<Scenario> = {}) => scenario({
    id: 'write-report',
    expected: { artifacts: [{ path: 'report.md', exists: true, contains: ['total'] }] },
    ...over,
  });

  it('fails a trial whose expected artifact is missing, even with no output check', async () => {
    const result = await runBenchmarkSuite(suite({ models: [PRICED] }, [artifactScenario()]), runConfig());

    const trial = result.modelResults[PRICED]!.agents[0]!.scenarios[0]!.trials[0]!;
    expect(trial.output.valid).toBe(false);
    expect(trial.output.validationDetails).toBe('Artifact failures: report.md');
    expect(result.ranking[0]!.completionRate).toBe(0);
    expect(result.modelResults[PRICED]!.aggregate.errorCounts!.validation_failure).toBe(1);
  });

  it('judges the artifact the agent wrote in its own workspace', async () => {
    respond = async (call) => {
      writeFileSync(join(call.projectContext!.cwd, 'report.md'), 'The total is 4.');
      return { text: 'written' };
    };
    const result = await runBenchmarkSuite(suite({ models: [PRICED] }, [artifactScenario()]), runConfig());

    expect(result.ranking[0]!.completionRate).toBe(1);
    // The agent's own directory is never written to.
    expect(existsSync(join(tempDir, 'agents', 'report.md'))).toBe(false);
  });

  it('gives every trial a fresh workspace as cwd and state root, then removes it', async () => {
    const seen: boolean[] = [];
    respond = async (call) => {
      const cwd = call.projectContext!.cwd;
      seen.push(existsSync(join(cwd, 'leftover')));
      writeFileSync(join(cwd, 'leftover'), 'x');
      return { text: 'done' };
    };
    await runBenchmarkSuite(suite({ models: [PRICED, PRICED_B], runs: 2 }), runConfig());

    expect(seen).toEqual([false, false, false, false]);
    const contexts = runs.map((r) => r.projectContext!);
    expect(new Set(contexts.map((c) => c.cwd)).size).toBe(4);
    for (const context of contexts) {
      expect(context.projectRoot).toBe(join(tempDir, 'agents'));
      expect(context.stateRoot).toBe(context.cwd);
      expect(context.cwd.startsWith(join(tempDir, 'agents'))).toBe(false);
      expect(existsSync(context.cwd)).toBe(false);
    }
  });

  it("removes the state a trial kept under its workspace's project directory", async () => {
    const { getProjectDirSync } = await import('../src/storage/paths');
    const stateDirs: string[] = [];
    respond = async (call) => {
      const dir = getProjectDirSync(call.projectContext!.stateRoot);
      mkdirSync(join(dir, 'learnings'), { recursive: true });
      writeFileSync(join(dir, 'learnings', 'worker.learnings.md'), '# captured');
      stateDirs.push(dir);
      return { text: 'done' };
    };
    await runBenchmarkSuite(suite({ models: [PRICED], runs: 2 }), runConfig());

    expect(stateDirs).toHaveLength(2);
    expect(stateDirs.every((dir) => dir.startsWith(join(tempDir, 'state')) && !existsSync(dir))).toBe(true);
  });

  it("seeds the workspace from the scenario's fixture", async () => {
    mkdirSync(join(tempDir, 'fixtures', 'sales'), { recursive: true });
    writeFileSync(join(tempDir, 'fixtures', 'sales', 'input.csv'), 'a,b\n1,2\n');
    let input = '';
    respond = async (call) => {
      input = readFileSync(join(call.projectContext!.cwd, 'input.csv'), 'utf-8');
      return { text: 'done' };
    };
    await runBenchmarkSuite(suite({ models: [PRICED] }, [scenario({ fixture: 'fixtures/sales' })]), runConfig());

    expect(input).toBe('a,b\n1,2\n');
  });

  it('rejects a suite whose fixture does not exist before running anything', async () => {
    const { loadSuite } = await import('../src/benchmark/loader');
    const suitePath = join(tempDir, 'suite.suite.yaml');
    writeFileSync(suitePath, [
      'id: s', 'name: S', 'config:', `  models: [${PRICED}]`, 'tests:', '  - agent: agents/worker.agentuse',
      '    scenarios:', '      - id: a', '        name: A', '        input: go', '        fixture: fixtures/missing',
      '        expected: {}', '',
    ].join('\n'));

    await expect(loadSuite(suitePath)).rejects.toThrow('Fixture for scenario "a" not found');
  });
});

describe('benchmark budget', () => {
  it('stops the whole suite once suite-wide spend reaches the budget', async () => {
    // $1 per haiku trial, $3 per sonnet trial; 4 trials planned.
    const result = await runBenchmarkSuite(
      suite({ models: [PRICED, PRICED_B] }, [scenario(), scenario({ id: 'second', name: 'Second' })]),
      runConfig({ budgetUsd: 2.5 }),
    );

    // $1 + $1 leaves room, the $3 trial overshoots, and nothing starts after it.
    expect(runs.map((r) => r.model)).toEqual([PRICED, PRICED, PRICED_B]);
    expect(result.config.budgetExhausted).toBe(true);
    expect(result.config.totalTrials).toBe(3);
    expect(result.config.totalScenarios).toBe(2);
    expect(JSON.parse(generateJsonReport(result)).config).toMatchObject({ budgetUsd: 2.5, budgetExhausted: true });
  });

  it('runs everything when the budget is never reached', async () => {
    const result = await runBenchmarkSuite(suite({ models: [PRICED], runs: 2 }), runConfig({ budgetUsd: 10 }));

    expect(runs).toHaveLength(2);
    expect(result.config.budgetExhausted).toBeUndefined();
  });

  it('refuses to start a budgeted run with a model it cannot price', async () => {
    await expect(
      runBenchmarkSuite(suite({ models: [PRICED, 'demo:test'] }), runConfig({ budgetUsd: 5 })),
    ).rejects.toThrow('none is known for: demo:test');
    expect(runs).toHaveLength(0);
  });

  it('shows an unpriced model with a failed trial as unknown cost, not $0', async () => {
    let call = 0;
    respond = async () => {
      if (++call === 2) throw new Error('provider down');
      return { text: 'done' };
    };
    const result = await runBenchmarkSuite(suite({ models: ['demo:test'], runs: 2 }), runConfig());

    const trials = result.modelResults['demo:test']!.agents[0]!.scenarios[0]!.trials;
    expect(trials[1]!.execution.success).toBe(false);
    expect(trials[1]!.usage.estimatedCostUsd).toBeUndefined();
    expect(result.ranking[0]!.costUsd).toBeUndefined();
  });
});
