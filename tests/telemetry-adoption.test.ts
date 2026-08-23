import { describe, expect, it } from 'bun:test';
import type { ToolCallTrace } from '../src/plugin/types';
import {
  aggregateToolCalls,
  classifyExecution,
  configuredFeatureUsage,
  isCanonicalRemoteExample,
} from '../src/telemetry';

function trace(name: string, type: ToolCallTrace['type'] = 'tool'): ToolCallTrace {
  return { name, type, startTime: 1, duration: 2, success: true };
}

describe('adoption telemetry metrics', () => {
  it('separates MCP, subagent, skill, and builtin use without retaining trace content', () => {
    const metrics = aggregateToolCalls([
      { ...trace('mcp__github__search'), input: { query: 'private' }, output: 'private result' },
      trace('researcher', 'subagent'),
      trace('tools__skill_load'),
      trace('tools__skill_read'),
      trace('tools__bash'),
      trace('claude-sonnet-4-6', 'llm'),
    ]);

    expect(metrics).toEqual({
      total: 5,
      builtin: 1,
      mcp: 1,
      subagent: 1,
      skill: 2,
    });
    expect(JSON.stringify(metrics)).not.toContain('private');
  });

  it('returns explicit zeroes when a run has no completed traces', () => {
    expect(aggregateToolCalls(undefined)).toEqual({
      total: 0,
      builtin: 0,
      mcp: 0,
      subagent: 0,
      skill: 0,
    });
  });

  it('keeps configured feature exposure separate from actual calls', () => {
    const features = configuredFeatureUsage({
      mcpServers: { github: {} as never, slack: {} as never },
      subagents: [{ name: 'researcher', path: './researcher.agentuse' } as never],
      skills: {
        auto: true,
        trusted: false,
        explicit: { browser: { trust: false }, research: { trust: false } },
      },
    }, 'cli');

    expect(features).toEqual({
      mcpServersCount: 2,
      subagentsConfigured: 1,
      skillsConfigured: 2,
      mode: 'cli',
    });
  });
});

describe('execution classification', () => {
  it('recognizes only the canonical remote hello example', () => {
    expect(isCanonicalRemoteExample('https://agentuse.io/hello.agentuse')).toBe(true);
    expect(isCanonicalRemoteExample('https://www.agentuse.io/hello.agentuse')).toBe(true);
    expect(isCanonicalRemoteExample('./hello.agentuse')).toBe(false);
    expect(isCanonicalRemoteExample('https://example.com/hello.agentuse')).toBe(false);
    expect(isCanonicalRemoteExample('https://agentuse.io/hello.agentuse?variant=1')).toBe(false);
  });

  it('classifies example, user, mock, and health-check runs with precedence', () => {
    expect(classifyExecution({
      agentSource: 'remote', trigger: 'manual', isMock: false, isExampleAgent: true,
    })).toEqual({
      executionClass: 'example', agentSource: 'remote', isMock: false, trigger: 'manual',
    });

    expect(classifyExecution({
      agentSource: 'local', trigger: 'scheduled', isMock: false,
    }).executionClass).toBe('user_agent');

    expect(classifyExecution({
      agentSource: 'remote', trigger: 'manual', isMock: true, isExampleAgent: true,
    }).executionClass).toBe('test');

    expect(classifyExecution({
      agentSource: 'local', trigger: 'api', isMock: false, isHealthCheck: true,
    }).executionClass).toBe('health_check');
  });
});
