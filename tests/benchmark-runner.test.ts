import { afterEach, beforeAll, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs';
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

beforeEach(() => {
  runs = [];
  respond = async () => ({ text: 'done' });
  tempDir = mkdtempSync(join(tmpdir(), 'benchmark-runner-'));
  mkdirSync(join(tempDir, 'agents'), { recursive: true });
  agentPath = join(tempDir, 'agents', 'worker.agentuse');
  writeFileSync(agentPath, '---\nmodel: ${model}\n---\nDo the work.\n');
});

afterEach(() => {
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
