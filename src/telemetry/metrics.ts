import type { AgentConfig } from '../parser.js';
import type { ToolCallTrace } from '../plugin/types.js';
import type { FeatureUsage, ToolCallMetrics } from './types.js';

const SKILL_TOOL_NAMES = new Set(['tools__skill_load', 'tools__skill_read']);

/** Return a fresh zero value so callers can safely spread or retain it. */
export function emptyToolCallMetrics(): ToolCallMetrics {
  return { total: 0, builtin: 0, mcp: 0, subagent: 0, skill: 0 };
}

/** Aggregate only privacy-safe counts; trace inputs and outputs never leave the process. */
export function aggregateToolCalls(traces: ToolCallTrace[] | undefined): ToolCallMetrics {
  const metrics = emptyToolCallMetrics();

  for (const trace of traces ?? []) {
    if (trace.type === 'llm') continue;

    metrics.total++;
    if (trace.type === 'subagent') {
      metrics.subagent++;
    } else if (trace.name.startsWith('mcp__')) {
      metrics.mcp++;
    } else if (SKILL_TOOL_NAMES.has(trace.name)) {
      metrics.skill++;
    } else {
      metrics.builtin++;
    }
  }

  return metrics;
}

export function countSteps(traces: ToolCallTrace[] | undefined): number {
  return (traces ?? []).filter((trace) => trace.type === 'llm').length;
}

/** Configuration exposure is intentionally separate from trace-derived feature use. */
export function configuredFeatureUsage(
  config: Pick<AgentConfig, 'mcpServers' | 'subagents' | 'skills'> | undefined,
  mode: FeatureUsage['mode'],
): FeatureUsage {
  return {
    mcpServersCount: Object.keys(config?.mcpServers ?? {}).length,
    subagentsConfigured: config?.subagents?.length ?? 0,
    skillsConfigured: Object.keys(config?.skills?.explicit ?? {}).length,
    mode,
  };
}
