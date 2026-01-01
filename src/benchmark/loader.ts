import { readFile } from 'fs/promises';
import { existsSync } from 'fs';
import { resolve, dirname, join } from 'path';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { randomBytes } from 'crypto';
import { parseAgent, type ParsedAgent } from '../parser.js';
import {
  BenchmarkSuiteSchema,
  type BenchmarkSuite,
  type Scenario,
} from './types.js';

/**
 * Directory paths for benchmark suites
 */
export const BENCHMARK_DIRS = {
  /** User's local suites (gitignored) */
  local: '.agentuse/benchmark/suites',
  /** Shipped example suites (committed) */
  builtin: 'benchmarks/suites',
} as const;

/**
 * Resolve a suite path from name or path.
 * Searches in order: exact path, local (.agentuse/benchmark/suites), builtin (benchmarks/suites)
 * @param input Suite name (e.g., "quick-test") or full path
 * @returns Resolved absolute path to the suite file
 */
export async function resolveSuitePath(input: string): Promise<string> {
  // If it's already an absolute path or exists as-is, use it
  const asProvided = resolve(input);
  if (existsSync(asProvided)) {
    return asProvided;
  }

  // Try adding .suite.yaml extension if not present
  const withExt = input.endsWith('.suite.yaml') || input.endsWith('.suite.yml')
    ? input
    : `${input}.suite.yaml`;

  // Search locations in order: local first (user preference), then builtin
  const candidates = [
    resolve(BENCHMARK_DIRS.local, withExt),
    resolve(BENCHMARK_DIRS.builtin, withExt),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }

  throw new SuiteConfigError(
    `Suite not found: ${input}. Searched in:\n  - ${candidates.join('\n  - ')}`,
    'suitePath',
    'not_found'
  );
}

/**
 * Error thrown when suite configuration is invalid
 */
export class SuiteConfigError extends Error {
  constructor(
    message: string,
    public field: string,
    public issue: string
  ) {
    super(message);
    this.name = 'SuiteConfigError';
  }
}

/**
 * Loaded test with resolved agent
 */
export interface LoadedTest {
  agent: ParsedAgent;
  agentPath: string;
  scenarios: Scenario[];
}

/**
 * Fully loaded benchmark suite with resolved agents
 */
export interface LoadedSuite {
  suite: BenchmarkSuite;
  suitePath: string;
  tests: LoadedTest[];
}

/**
 * Parse and validate a benchmark suite YAML file
 * @param suitePath Path to the suite YAML file
 * @returns Parsed and validated suite configuration
 */
export async function parseSuite(suitePath: string): Promise<BenchmarkSuite> {
  try {
    // Resolve to absolute path
    const absolutePath = resolve(suitePath);

    // Read file content
    const content = await readFile(absolutePath, 'utf-8');

    // Parse YAML
    const data = parseYaml(content);

    // Validate with Zod schema
    const suite = BenchmarkSuiteSchema.parse(data);

    return suite;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
      throw new SuiteConfigError(
        `Suite file not found: ${suitePath}`,
        'suitePath',
        'not_found'
      );
    }

    if (error instanceof z.ZodError) {
      const firstError = error.errors[0];
      const message = error.errors
        .map((e) => `${e.path.join('.')}: ${e.message}`)
        .join(', ');
      const topLevelField = String(firstError.path[0] ?? 'root');
      throw new SuiteConfigError(
        `Invalid suite configuration: ${message}`,
        topLevelField,
        firstError.code
      );
    }

    throw error;
  }
}

/**
 * Load a benchmark suite with all agents resolved
 * @param suitePath Path to the suite YAML file
 * @returns Loaded suite with parsed agents
 */
export async function loadSuite(suitePath: string): Promise<LoadedSuite> {
  // Parse the suite file
  const suite = await parseSuite(suitePath);

  // Resolve agent paths relative to suite file
  const suiteDir = dirname(resolve(suitePath));

  // Load all agents
  const tests: LoadedTest[] = [];

  for (const test of suite.tests) {
    // Resolve agent path relative to suite directory
    const agentPath = join(suiteDir, test.agent);

    try {
      const agent = await parseAgent(agentPath);

      tests.push({
        agent,
        agentPath, // Use absolute path for skill discovery
        scenarios: test.scenarios,
      });
    } catch (error) {
      throw new SuiteConfigError(
        `Failed to load agent "${test.agent}": ${error instanceof Error ? error.message : String(error)}`,
        `tests.${test.agent}`,
        'agent_load_error'
      );
    }
  }

  return {
    suite,
    suitePath: resolve(suitePath),
    tests,
  };
}

/**
 * Get total number of scenarios in a suite
 */
export function getTotalScenarios(suite: BenchmarkSuite): number {
  return suite.tests.reduce((total, test) => total + test.scenarios.length, 0);
}

/**
 * Get total number of trials for a suite run
 * (scenarios * models * runs)
 */
export function getTotalTrials(suite: BenchmarkSuite): number {
  const scenarios = getTotalScenarios(suite);
  const models = suite.config.models.length;
  const runs = suite.config.runs;
  return scenarios * models * runs;
}

/**
 * Substitute model placeholder in agent config
 * Agents use ${model} placeholder which gets replaced at runtime
 */
export function substituteModel(
  agent: ParsedAgent,
  model: string
): ParsedAgent {
  return {
    ...agent,
    config: {
      ...agent.config,
      model: agent.config.model === '${model}' ? model : agent.config.model,
    },
  };
}

/**
 * Built-in dynamic variables for benchmark suite YAML files.
 * Uses {{$variable}} syntax (Postman-style) to differentiate from
 * agent config substitution which uses ${variable} syntax.
 */
const dynamicVariables: Record<string, () => string> = {
  uuid: () => crypto.randomUUID(),
  timestamp: () => new Date().toISOString(),
  randomHex: () => randomBytes(4).toString('hex'), // 8 chars
};

/**
 * Substitute dynamic variables in scenario input text.
 * Supports {{$uuid}}, {{$timestamp}}, {{$randomHex}} syntax.
 * Called at runtime before each trial to ensure unique values.
 */
export function substituteTemplateVariables(input: string): string {
  return input.replace(/\{\{\$(\w+)\}\}/g, (match, varName: string) => {
    const generator = dynamicVariables[varName];
    if (generator) {
      return generator();
    }
    // Return original if unknown variable
    return match;
  });
}
