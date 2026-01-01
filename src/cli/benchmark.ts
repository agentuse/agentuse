import { Command } from 'commander';
import chalk from 'chalk';
import { resolve } from 'path';
import { loadSuite, getTotalScenarios, resolveSuitePath, BENCHMARK_DIRS } from '../benchmark/loader.js';
import { runBenchmarkSuite } from '../benchmark/runner.js';
import { saveReports, generateMarkdownReport, generateHtmlReport, isRawBenchmarkResult, type ReportFormat } from '../benchmark/reporter/index.js';
import { calculateMetrics } from '../benchmark/calculator.js';
import type { BenchmarkRunConfig, SuiteResult } from '../benchmark/types.js';

export function createBenchmarkCommand(): Command {
  const benchmarkCommand = new Command('benchmark')
    .description('Run LLM benchmarks to evaluate agent performance');

  // Run benchmark
  benchmarkCommand
    .command('run')
    .description('Execute a benchmark suite')
    .argument('<suite>', 'Path to suite YAML file')
    .option('-m, --models <models...>', 'Override models to evaluate')
    .option('-r, --runs <number>', 'Number of runs (trials) per scenario', parseInt)
    .option('--timeout <seconds>', 'Timeout per scenario in seconds', parseInt)
    .option('--max-steps <number>', 'Max steps per scenario', parseInt)
    .option('--budget <usd>', 'Cost budget in USD (stops if exceeded)', parseFloat)
    .option('-o, --output <dir>', 'Output directory for reports', './.agentuse/benchmark/results')
    .option('--format <formats...>', 'Output formats: json, markdown, html')
    .option('-v, --verbose', 'Enable verbose logging')
    .action(async (suitePath: string, options: {
      models?: string[];
      runs?: number;
      timeout?: number;
      maxSteps?: number;
      budget?: number;
      output?: string;
      format?: string[];
      verbose?: boolean;
    }) => {
      try {
        console.log(chalk.bold('\n🧪 AgentUse Benchmark\n'));

        // Resolve suite path (supports name, relative path, or absolute path)
        const absoluteSuitePath = await resolveSuitePath(suitePath);
        console.log(chalk.gray(`Suite: ${absoluteSuitePath}`));

        // Load suite
        console.log(chalk.gray('Loading suite...'));
        const loadedSuite = await loadSuite(absoluteSuitePath);

        // Show suite info
        const totalScenarios = getTotalScenarios(loadedSuite.suite);
        const models = options.models ?? loadedSuite.suite.config.models;
        const runs = options.runs ?? loadedSuite.suite.config.runs;
        const totalTrials = totalScenarios * models.length * runs;

        console.log(chalk.cyan(`\n📋 ${loadedSuite.suite.name}`));
        console.log(chalk.gray(`   Models: ${models.join(', ')}`));
        console.log(chalk.gray(`   Scenarios: ${totalScenarios}`));
        console.log(chalk.gray(`   Runs per scenario: ${runs}`));
        console.log(chalk.gray(`   Total trials: ${totalTrials}`));

        if (options.budget) {
          console.log(chalk.yellow(`   Budget: $${options.budget}`));
        }

        console.log('');

        // Build config
        const config: BenchmarkRunConfig = {
          suitePath: absoluteSuitePath,
          ...(options.models && { models: options.models }),
          ...(options.runs !== undefined && { runs: options.runs }),
          ...(options.timeout !== undefined && { timeout: options.timeout }),
          ...(options.maxSteps !== undefined && { maxSteps: options.maxSteps }),
          ...(options.budget !== undefined && { budgetUsd: options.budget }),
          ...(options.output && { outputDir: options.output }),
          formats: (options.format as ReportFormat[]) ?? ['json', 'markdown', 'html'],
          ...(options.verbose !== undefined && { verbose: options.verbose }),
        };

        // Run benchmark
        console.log(chalk.bold('Running benchmark...\n'));
        const result = await runBenchmarkSuite(loadedSuite, config);

        // Print results summary
        console.log(chalk.bold('\n📊 Results\n'));

        console.log(chalk.bold('Model Ranking:'));
        for (const entry of result.ranking) {
          const medal = entry.rank === 1 ? '🥇' : entry.rank === 2 ? '🥈' : entry.rank === 3 ? '🥉' : '  ';
          const modelName = entry.model.split(':')[1] || entry.model;
          const costDisplay = entry.costUsd !== undefined
            ? chalk.gray('$' + entry.costUsd.toFixed(3))
            : chalk.gray('—');
          console.log(
            `${medal} ${chalk.bold(entry.rank + '.')} ${chalk.white(modelName)} - ` +
            `Score: ${chalk.cyan(entry.score.toFixed(1))} | ` +
            `Completion: ${chalk.green((entry.completionRate * 100).toFixed(0) + '%')} | ` +
            `Pass^k: ${chalk.yellow((entry.passK * 100).toFixed(0) + '%')} | ` +
            `Avg Tools: ${chalk.magenta(entry.meanToolCalls.toFixed(1))} | ` +
            `Cost: ${costDisplay}`
          );
        }

        // Save reports
        console.log(chalk.gray('\nSaving reports...'));
        const outputDir = options.output ?? './.agentuse/benchmark/results';
        const formats = (options.format as ReportFormat[]) ?? ['json', 'markdown', 'html'];
        const savedFiles = await saveReports(result, outputDir, formats);

        console.log(chalk.green('\n✓ Reports saved:'));
        for (const file of savedFiles) {
          console.log(chalk.gray(`  ${file}`));
        }

        console.log(chalk.bold(`\n✨ Benchmark completed in ${(result.durationMs / 1000).toFixed(1)}s\n`));

      } catch (error) {
        console.error(chalk.red(`\n❌ Benchmark failed: ${error instanceof Error ? error.message : String(error)}\n`));
        if (options.verbose && error instanceof Error) {
          console.error(chalk.gray(error.stack));
        }
        process.exit(1);
      }
    });

  // List available suites
  benchmarkCommand
    .command('list')
    .description('List available benchmark suites')
    .option('-d, --dir <directory>', 'Directory to search (overrides default locations)')
    .action(async (options: { dir?: string }) => {
      const { readdir } = await import('fs/promises');
      const { existsSync } = await import('fs');
      const { join, basename } = await import('path');

      interface SuiteEntry {
        name: string;
        path: string;
        source: 'local' | 'builtin';
      }

      const suites: SuiteEntry[] = [];

      try {
        // If custom dir provided, only search there
        if (options.dir) {
          const dir = resolve(options.dir);
          if (!existsSync(dir)) {
            console.log(chalk.yellow(`Directory not found: ${dir}`));
            return;
          }
          const files = await readdir(dir);
          for (const file of files) {
            if (file.endsWith('.suite.yaml') || file.endsWith('.suite.yml')) {
              suites.push({
                name: basename(file, file.endsWith('.suite.yaml') ? '.suite.yaml' : '.suite.yml'),
                path: join(dir, file),
                source: 'builtin',
              });
            }
          }
        } else {
          // Search both directories
          const dirs = [
            { path: resolve(BENCHMARK_DIRS.local), source: 'local' as const },
            { path: resolve(BENCHMARK_DIRS.builtin), source: 'builtin' as const },
          ];

          for (const { path: dir, source } of dirs) {
            if (!existsSync(dir)) continue;
            try {
              const files = await readdir(dir);
              for (const file of files) {
                if (file.endsWith('.suite.yaml') || file.endsWith('.suite.yml')) {
                  suites.push({
                    name: basename(file, file.endsWith('.suite.yaml') ? '.suite.yaml' : '.suite.yml'),
                    path: join(dir, file),
                    source,
                  });
                }
              }
            } catch {
              // Directory doesn't exist or not readable, skip
            }
          }
        }

        if (suites.length === 0) {
          console.log(chalk.yellow('No benchmark suites found'));
          console.log(chalk.gray(`\nSearched in:\n  - ${BENCHMARK_DIRS.local}\n  - ${BENCHMARK_DIRS.builtin}`));
          return;
        }

        console.log(chalk.bold('\nAvailable Benchmark Suites:\n'));
        for (const suite of suites) {
          const tag = suite.source === 'local' ? chalk.cyan('[local]') : chalk.gray('[builtin]');
          console.log(`  ${tag} ${chalk.white(suite.name)}`);
          console.log(chalk.gray(`         ${suite.path}`));
        }
        console.log(chalk.gray('\nRun with: agentuse benchmark run <name>\n'));
      } catch (error) {
        console.error(chalk.red(`Failed to list suites: ${error instanceof Error ? error.message : String(error)}`));
        process.exit(1);
      }
    });

  // View results
  benchmarkCommand
    .command('results')
    .description('View benchmark results')
    .argument('[runId]', 'Run ID (hash) to view specific result')
    .option('--latest', 'Show the latest run')
    .option('--markdown', 'Output as markdown')
    .option('--web', 'Open HTML report in browser')
    .option('--dir <directory>', 'Results directory', './.agentuse/benchmark/results')
    .action(async (runId: string | undefined, options: { latest?: boolean; markdown?: boolean; web?: boolean; dir?: string }) => {
      const { readdir, readFile } = await import('fs/promises');
      const { join } = await import('path');

      try {
        const dir = resolve(options.dir ?? './.agentuse/benchmark/results');
        const files = await readdir(dir);
        const jsonFiles = files.filter(f => f.endsWith('.json'));

        if (jsonFiles.length === 0) {
          console.log(chalk.yellow(`No benchmark results found in ${dir}`));
          return;
        }

        // Load all results with full data
        interface ResultEntry {
          file: string;
          data: SuiteResult;
        }

        const results: ResultEntry[] = [];

        for (const file of jsonFiles) {
          try {
            const content = await readFile(join(dir, file), 'utf-8');
            const parsed = JSON.parse(content);

            // Must be raw format (version 2)
            if (!isRawBenchmarkResult(parsed)) {
              console.log(chalk.yellow(`Skipping ${file}: incompatible format (re-run benchmark to generate new format)`));
              continue;
            }

            const suiteResult = calculateMetrics(parsed);
            results.push({ file, data: suiteResult });
          } catch {
            // Skip invalid files
          }
        }

        // Sort by timestamp descending
        results.sort((a, b) => b.data.timestamp - a.data.timestamp);

        if (results.length === 0) {
          console.log(chalk.yellow(`No valid benchmark results found in ${dir}`));
          return;
        }

        // Formatting helpers
        const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
        const cost = (v: number | undefined) => v === undefined ? '—' : v < 0.01 ? `$${v.toFixed(4)}` : v < 1 ? `$${v.toFixed(3)}` : `$${v.toFixed(2)}`;
        const dur = (ms: number) => ms < 1000 ? `${ms.toFixed(0)}ms` : `${(ms / 1000).toFixed(1)}s`;
        const getModelName = (m: string) => m.split(':')[1] || m;

        // Helper to display a single result
        const displayResult = async (entry: ResultEntry) => {
          const result = entry.data;

          // Handle --markdown option
          if (options.markdown) {
            const { writeFile: writeFileAsync, mkdir: mkdirAsync } = await import('fs/promises');

            const markdown = generateMarkdownReport(result);
            const outputDir = resolve('.agentuse/benchmark/results');
            await mkdirAsync(outputDir, { recursive: true });
            const mdPath = join(outputDir, `${result.suiteId}-${result.runId}.md`);
            await writeFileAsync(mdPath, markdown, 'utf-8');

            console.log(markdown);
            console.log(chalk.green(`\nSaved to: ${mdPath}`));
            return;
          }

          // Handle --web option
          if (options.web) {
            const { writeFile: writeFileAsync, mkdir: mkdirAsync } = await import('fs/promises');
            const { exec } = await import('child_process');

            const html = generateHtmlReport(result);
            const outputDir = resolve('.agentuse/benchmark/results');
            await mkdirAsync(outputDir, { recursive: true });
            const htmlPath = join(outputDir, `${result.suiteId}-${result.runId}.html`);
            await writeFileAsync(htmlPath, html, 'utf-8');

            // Open in browser
            const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
            exec(`${openCmd} "${htmlPath}"`, (err) => {
              if (err) {
                console.log(chalk.yellow(`Could not open browser. HTML saved to: ${htmlPath}`));
              } else {
                console.log(chalk.green(`Opened in browser: ${htmlPath}`));
              }
            });
            return;
          }

          // Default: show in terminal
          console.log(chalk.bold(`\n📊 ${result.suiteName}\n`));
          console.log(chalk.gray(`Run ID:     ${result.runId}`));
          console.log(chalk.gray(`Date:       ${new Date(result.timestamp).toISOString()}`));
          console.log(chalk.gray(`Duration:   ${dur(result.durationMs)}`));
          console.log(chalk.gray(`Models:     ${result.config.models.length}`));
          console.log(chalk.gray(`Scenarios:  ${result.config.totalScenarios}`));
          console.log(chalk.gray(`Runs/scenario: ${result.config.runs}`));

          // Model comparison table
          console.log(chalk.bold('\n── Model Comparison ──\n'));

          const models = Object.keys(result.modelResults);
          const nameWidth = Math.max(12, ...models.map(m => getModelName(m).length));

          // Header
          const headers = ['Model', 'Score', 'Completion', 'Pass^k', 'Consistency', 'Efficiency', 'Latency', 'Cost'];
          const widths = [nameWidth, 7, 10, 8, 11, 10, 9, 10];
          console.log(chalk.gray(headers.map((h, i) => h.padEnd(widths[i])).join(' ')));
          console.log(chalk.gray('─'.repeat(widths.reduce((a, b) => a + b + 1, 0))));

          // Sort by rank
          const sortedModels = [...models].sort((a, b) => {
            const rankA = result.ranking.find(r => r.model === a)?.rank ?? 999;
            const rankB = result.ranking.find(r => r.model === b)?.rank ?? 999;
            return rankA - rankB;
          });

          for (const model of sortedModels) {
            const agg = result.modelResults[model].aggregate;
            const scoreColor = agg.overallScore >= 80 ? chalk.green : agg.overallScore >= 60 ? chalk.yellow : chalk.red;

            const row = [
              getModelName(model).padEnd(widths[0]),
              scoreColor(agg.overallScore.toFixed(1).padStart(widths[1] - 1) + ' '),
              pct(agg.completionRate).padStart(widths[2]),
              pct(agg.passK).padStart(widths[3]),
              pct(agg.consistency).padStart(widths[4]),
              pct(agg.efficiency).padStart(widths[5]),
              dur(agg.latencyMeanMs).padStart(widths[6]),
              cost(agg.totalCostUsd).padStart(widths[7]),
            ];
            console.log(row.join(' '));
          }

          // Show errors if any
          let hasErrors = false;
          for (const model of models) {
            const errors = result.modelResults[model].aggregate.errorCounts;
            if (errors && Object.values(errors).some(v => v > 0)) {
              if (!hasErrors) {
                console.log(chalk.bold('\n── Errors ──\n'));
                hasErrors = true;
              }
              const errorList = Object.entries(errors)
                .filter(([, v]) => v > 0)
                .map(([k, v]) => `${k}: ${v}`)
                .join(', ');
              console.log(chalk.red(`  ${getModelName(model)}: ${errorList}`));
            }
          }

          // Scenario breakdown per model
          console.log(chalk.bold('\n── Scenario Breakdown ──'));

          for (const model of sortedModels) {
            const mr = result.modelResults[model];
            console.log(chalk.cyan(`\n  ${getModelName(model)}`));

            // Collect all scenarios
            const scenarios = mr.agents.flatMap(a => a.scenarios);
            if (scenarios.length === 0) {
              console.log(chalk.gray('    No scenarios'));
              continue;
            }

            // Check if any scenario has goals
            const hasGoals = scenarios.some(s => s.metrics.goals);

            // Calculate column widths for scenario table
            const scenarioNameWidth = Math.max(20, ...scenarios.map(s => s.scenarioName.length));

            if (hasGoals) {
              // Header with goals
              const sHeaders = ['Scenario', 'Status', 'Goals', 'Recovery', 'Tools', 'Time', 'Cost'];
              const sWidths = [scenarioNameWidth, 8, 8, 10, 7, 8, 10];
              console.log(chalk.gray('    ' + sHeaders.map((h, i) => h.padEnd(sWidths[i])).join(' ')));
              console.log(chalk.gray('    ' + '─'.repeat(sWidths.reduce((a, b) => a + b + 1, 0))));

              for (const scenario of scenarios) {
                const m = scenario.metrics;
                const statusIcon = m.completionRate === 1 ? chalk.green('✓') : m.completionRate > 0 ? chalk.yellow('◐') : chalk.red('✗');
                const statusText = m.completionRate === 1 ? 'Pass' : m.completionRate > 0 ? 'Partial' : 'Fail';
                const goalsStr = m.goals ? `${m.goals.completedGoals}/${m.goals.totalGoals}` : '-';
                const recoveryStr = m.goals ? pct(m.goals.recoveryRate) : '-';
                const toolsStr = m.goals ? m.goals.avgAttemptsPerGoal.toFixed(1) : '-';

                const row = [
                  scenario.scenarioName.slice(0, scenarioNameWidth).padEnd(scenarioNameWidth),
                  `${statusIcon} ${statusText}`.padEnd(sWidths[1] + 2), // +2 for icon
                  goalsStr.padStart(sWidths[2]),
                  recoveryStr.padStart(sWidths[3]),
                  toolsStr.padStart(sWidths[4]),
                  dur(m.latency.meanMs).padStart(sWidths[5]),
                  cost(m.cost.totalUsd).padStart(sWidths[6]),
                ];
                console.log('    ' + row.join(' '));
              }
            } else {
              // Header without goals
              const sHeaders = ['Scenario', 'Status', 'Pass^k', 'Consistency', 'Time', 'Cost'];
              const sWidths = [scenarioNameWidth, 8, 8, 11, 8, 10];
              console.log(chalk.gray('    ' + sHeaders.map((h, i) => h.padEnd(sWidths[i])).join(' ')));
              console.log(chalk.gray('    ' + '─'.repeat(sWidths.reduce((a, b) => a + b + 1, 0))));

              for (const scenario of scenarios) {
                const m = scenario.metrics;
                const statusIcon = m.completionRate === 1 ? chalk.green('✓') : m.completionRate > 0 ? chalk.yellow('◐') : chalk.red('✗');
                const statusText = m.completionRate === 1 ? 'Pass' : m.completionRate > 0 ? 'Partial' : 'Fail';

                const row = [
                  scenario.scenarioName.slice(0, scenarioNameWidth).padEnd(scenarioNameWidth),
                  `${statusIcon} ${statusText}`.padEnd(sWidths[1] + 2),
                  pct(m.passK).padStart(sWidths[2]),
                  pct(m.consistency).padStart(sWidths[3]),
                  dur(m.latency.meanMs).padStart(sWidths[4]),
                  cost(m.cost.totalUsd).padStart(sWidths[5]),
                ];
                console.log('    ' + row.join(' '));
              }
            }
          }

          console.log('');
        };

        // Find by runId if provided
        if (runId) {
          const match = results.find(r => r.data.runId.startsWith(runId) || r.data.runId === runId);
          if (!match) {
            console.log(chalk.yellow(`No result found matching run ID: ${runId}`));
            return;
          }
          await displayResult(match);
          return;
        }

        if (options.latest) {
          await displayResult(results[0]);
        } else {
          // Display as table
          console.log(chalk.bold('\n📊 Benchmark Results\n'));

          // Calculate column widths
          const suiteWidth = Math.max(10, ...results.map(r => r.data.suiteName.length));
          const hashWidth = 8;
          const dateWidth = 19;

          // Header
          const header = [
            'Suite'.padEnd(suiteWidth),
            'Hash'.padEnd(hashWidth),
            'Timestamp'.padEnd(dateWidth),
          ].join('  ');
          console.log(chalk.gray(header));
          console.log(chalk.gray('─'.repeat(header.length)));

          // Rows
          for (const entry of results.slice(0, 20)) {
            const date = new Date(entry.data.timestamp);
            const dateStr = date.toISOString().slice(0, 19).replace('T', ' ');
            const row = [
              entry.data.suiteName.padEnd(suiteWidth),
              entry.data.runId.slice(0, hashWidth).padEnd(hashWidth),
              dateStr,
            ].join('  ');
            console.log(row);
          }

          if (results.length > 20) {
            console.log(chalk.gray(`\n... and ${results.length - 20} more`));
          }
          console.log(chalk.gray('\nUse --latest to view the most recent result\n'));
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
          console.log(chalk.yellow('No benchmark results found'));
        } else {
          console.error(chalk.red(`Failed to read results: ${error instanceof Error ? error.message : String(error)}`));
        }
        process.exit(1);
      }
    });

  return benchmarkCommand;
}
