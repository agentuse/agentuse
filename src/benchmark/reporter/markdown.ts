import { writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import type { SuiteResult } from '../types.js';
import {
  generateReportData,
  formatDuration,
  formatCost,
  formatPercent,
  formatTokens,
  GLOSSARY_ITEMS,
} from './shared.js';

/**
 * Generate Markdown report from suite results
 */
export function generateMarkdownReport(result: SuiteResult): string {
  const data = generateReportData(result);
  const lines: string[] = [];
  const showConsistency = data.runs > 1; // Hide consistency when runs=1 (always 100%)

  // Check if any model has goals
  const hasGoals = data.models.some((m) => m.goals);
  // Check if weighted scores are available (must be non-null number)
  const hasWeightedScores = data.models.some((m) => m.scores.weighted != null);

  // Header
  lines.push(`# ${data.summary.suiteName}`);
  lines.push('');
  lines.push(`**Run ID:** \`${data.summary.runId}\``);
  lines.push(`**Date:** ${new Date(data.generatedAt).toISOString()}`);
  lines.push(`**Duration:** ${formatDuration(data.summary.runDurationMs)}`);
  lines.push('');

  // Summary
  lines.push('## Summary');
  lines.push('');
  lines.push('| Metric | Value |');
  lines.push('|--------|-------|');
  lines.push(`| Models | ${data.summary.totalModels} |`);
  lines.push(`| Scenarios | ${data.summary.totalScenarios} |`);
  lines.push(`| Trials | ${data.summary.totalTrials} |`);
  lines.push(`| Total Cost | ${formatCost(data.summary.totalCostUsd)} |`);
  lines.push('');

  // Model Ranking
  lines.push('## Model Ranking');
  lines.push('');

  // Build header dynamically based on available metrics
  if (hasGoals) {
    const headers = ['Rank', 'Model', 'Score'];
    if (hasWeightedScores) headers.push('Unweighted');
    headers.push('Pass^k', 'Efficiency', 'Tools/Goal', 'Tool Failure', 'Tool Efficiency', 'P95 Latency', 'Avg Cost');
    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`|${headers.map(() => '------').join('|')}|`);
  } else {
    const headers = ['Rank', 'Model', 'Score'];
    if (hasWeightedScores) headers.push('Unweighted');
    headers.push('Completion', 'Pass^k');
    if (showConsistency) headers.push('Consistency');
    headers.push('P95 Latency', 'Avg Cost');
    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`|${headers.map(() => '------').join('|')}|`);
  }

  for (const entry of data.ranking) {
    const model = data.models.find((m) => m.id === entry.model);
    if (!model) continue;

    // When weighted scores exist: Score = weighted (bold), Unweighted = raw
    // When no weighted scores: Score = raw (bold)
    const primaryScore = entry.weighted != null ? entry.weighted : entry.score;
    const scoreStr = `**${primaryScore.toFixed(1)}**`;
    const unweightedStr = hasWeightedScores ? (entry.score?.toFixed(1) ?? '—') : '';

    if (hasGoals) {
      const failureRate = model.goals?.toolCallFailureRate;
      const failureRateStr = failureRate != null && !isNaN(failureRate) ? formatPercent(failureRate) : '—';
      const toolEfficiency = model.goals?.toolCallEfficiency;
      const toolEfficiencyStr = toolEfficiency != null && !isNaN(toolEfficiency) ? formatPercent(toolEfficiency) : '—';

      const cells = [
        entry.rank.toString(),
        model.name,
        scoreStr,
      ];
      if (hasWeightedScores) cells.push(unweightedStr);
      cells.push(
        formatPercent(model.scores.passK),
        formatPercent(model.scores.efficiency),
        model.goals ? model.goals.avgAttempts.toFixed(1) : '—',
        failureRateStr,
        toolEfficiencyStr,
        formatDuration(model.latency.p95Ms),
        formatCost(model.cost.perFullRun)
      );
      lines.push(`| ${cells.join(' | ')} |`);
    } else {
      const cells = [
        entry.rank.toString(),
        model.name,
        scoreStr,
      ];
      if (hasWeightedScores) cells.push(unweightedStr);
      cells.push(
        formatPercent(model.scores.completion),
        formatPercent(model.scores.passK)
      );
      if (showConsistency) cells.push(formatPercent(model.scores.consistency));
      cells.push(
        formatDuration(model.latency.p95Ms),
        formatCost(model.cost.perFullRun)
      );
      lines.push(`| ${cells.join(' | ')} |`);
    }
  }
  lines.push('');

  // Model Details
  lines.push('## Model Details');
  lines.push('');

  for (const model of data.models) {
    lines.push(`### ${model.name}`);
    lines.push('');
    lines.push(`*Provider: ${model.provider}*`);
    lines.push('');

    // Primary score (weighted if exists)
    const primaryScore = model.scores.weighted != null ? model.scores.weighted : model.scores.overall;
    lines.push(`- **Score:** ${primaryScore.toFixed(1)}`);
    if (model.scores.weighted != null) {
      lines.push(`- **Unweighted Score:** ${model.scores.overall.toFixed(1)}`);
    }
    lines.push(`- **Completion:** ${formatPercent(model.scores.completion)}`);
    lines.push(`- **Pass^k:** ${formatPercent(model.scores.passK)}`);
    if (showConsistency) {
      lines.push(`- **Consistency:** ${formatPercent(model.scores.consistency)}`);
    }
    lines.push(`- **Efficiency:** ${formatPercent(model.scores.efficiency)}`);
    lines.push(`- **Mean Latency:** ${formatDuration(model.latency.meanMs)}`);
    lines.push(`- **P95 Latency:** ${formatDuration(model.latency.p95Ms)}`);
    lines.push(`- **Avg Cost:** ${formatCost(model.cost.perFullRun)}`);
    if (model.cost.perSuccess !== undefined) {
      lines.push(`- **Cost/Success:** ${formatCost(model.cost.perSuccess)}`);
    }

    // Goals metrics
    if (model.goals) {
      lines.push('');
      lines.push('#### Goal Metrics');
      lines.push('');
      lines.push('| Metric | Value |');
      lines.push('|--------|-------|');
      lines.push(`| Goal Completion | ${formatPercent(model.goals.completionRate)} |`);
      lines.push(`| Tools/Goal | ${model.goals.avgAttempts.toFixed(1)} |`);
      lines.push(`| Tool Failure Rate | ${formatPercent(model.goals.toolCallFailureRate)} |`);
      if (model.goals.toolCallEfficiency !== undefined) {
        lines.push(`| Tool Efficiency | ${formatPercent(model.goals.toolCallEfficiency)} |`);
      }
    }

    // Errors
    if (model.errors) {
      const totalErrors = Object.values(model.errors).reduce((sum, v) => sum + v, 0);
      if (totalErrors > 0) {
        lines.push('');
        lines.push('#### Errors');
        lines.push('');
        lines.push('| Type | Count |');
        lines.push('|------|-------|');
        if (model.errors.timeout) lines.push(`| Timeout | ${model.errors.timeout} |`);
        if (model.errors.runtime_error) lines.push(`| Runtime | ${model.errors.runtime_error} |`);
        if (model.errors.validation_failure) lines.push(`| Validation | ${model.errors.validation_failure} |`);
        if (model.errors.tool_error) lines.push(`| Tool | ${model.errors.tool_error} |`);
        if (model.errors.unknown) lines.push(`| Unknown | ${model.errors.unknown} |`);

        // Error details
        if (model.errorDetails && model.errorDetails.length > 0) {
          lines.push('');
          lines.push('**Error Details:**');
          lines.push('');
          for (const err of model.errorDetails.slice(0, 10)) {
            lines.push(`- **${err.scenario}** #${err.trial}: \`${err.type}\` - ${err.message}`);
          }
          if (model.errorDetails.length > 10) {
            lines.push(`- ... and ${model.errorDetails.length - 10} more errors`);
          }
        }
      }
    }
    lines.push('');
  }

  // Scenarios Breakdown
  lines.push('## Scenarios Breakdown');
  lines.push('');

  // Build scenario headers
  if (hasGoals) {
    const headers = ['Scenario', 'Model', 'Status', 'Goals', 'Tools/Goal', 'Tool Failure', 'Tool Efficiency', 'Recovery', 'In Tokens', 'Out Tokens', 'Latency', 'Avg Cost'];
    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`|${headers.map(() => '------').join('|')}|`);
  } else {
    const headers = ['Scenario', 'Model', 'Status', 'Completion', 'Pass^k'];
    if (showConsistency) headers.push('Consistency');
    headers.push('In Tokens', 'Out Tokens', 'Latency', 'Avg Cost');
    lines.push(`| ${headers.join(' | ')} |`);
    lines.push(`|${headers.map(() => '------').join('|')}|`);
  }

  for (const scenario of data.scenarios) {
    const difficultyBadge = scenario.difficulty ? ` [${scenario.difficulty}]` : '';

    for (const model of data.models) {
      const r = scenario.results[model.id];
      if (!r) continue;

      // Status
      const status = r.completionRate === 1 ? 'pass' : r.completionRate > 0 ? 'partial' : 'fail';

      if (hasGoals && r.goals) {
        const failureRate = r.goals.toolCallFailureRate;
        const failureRateStr = failureRate != null && !isNaN(failureRate) ? formatPercent(failureRate) : '—';
        const efficiencyStr = r.goals.toolCallEfficiency != null && !isNaN(r.goals.toolCallEfficiency) ? formatPercent(r.goals.toolCallEfficiency) : '—';

        lines.push(`| ${scenario.name}${difficultyBadge} | ${model.name} | ${status} | ${r.goals.completed}/${r.goals.total} | ${r.goals.avgAttempts.toFixed(1)} | ${failureRateStr} | ${efficiencyStr} | ${formatPercent(r.goals.recoveryRate)} | ${formatTokens(r.inputTokens)} | ${formatTokens(r.outputTokens)} | ${formatDuration(r.latencyMs)} | ${formatCost(r.costUsd)} |`);
      } else if (hasGoals) {
        lines.push(`| ${scenario.name}${difficultyBadge} | ${model.name} | ${status} | — | — | — | — | — | ${formatTokens(r.inputTokens)} | ${formatTokens(r.outputTokens)} | ${formatDuration(r.latencyMs)} | ${formatCost(r.costUsd)} |`);
      } else {
        const cells = [
          scenario.name + difficultyBadge,
          model.name,
          status,
          formatPercent(r.completionRate),
          formatPercent(r.passK),
        ];
        if (showConsistency) cells.push(formatPercent(r.consistency));
        cells.push(
          formatTokens(r.inputTokens),
          formatTokens(r.outputTokens),
          formatDuration(r.latencyMs),
          formatCost(r.costUsd)
        );
        lines.push(`| ${cells.join(' | ')} |`);
      }
    }
  }
  lines.push('');

  // Glossary
  lines.push('## Glossary');
  lines.push('');
  lines.push('| Term | Definition |');
  lines.push('|------|------------|');
  for (const item of GLOSSARY_ITEMS) {
    lines.push(`| **${item.term}** | ${item.definition} |`);
  }
  lines.push('');

  // Footer
  lines.push('---');
  lines.push('');
  lines.push('*Generated by AgentUse Benchmark*');

  return lines.join('\n');
}

/**
 * Save Markdown report to file
 */
export async function saveMarkdownReport(
  result: SuiteResult,
  outputDir: string
): Promise<string> {
  await mkdir(outputDir, { recursive: true });

  const filename = `${result.suiteId}-${result.runId}.md`;
  const filepath = join(outputDir, filename);

  await writeFile(filepath, generateMarkdownReport(result), 'utf-8');

  return filepath;
}
