/**
 * Telemetry module for anonymous usage tracking
 *
 * Collects anonymous usage data to help improve agentuse.
 * No personal information, prompts, code, or file paths are ever collected.
 *
 * Opt-out: Set AGENTUSE_TELEMETRY_DISABLED=true
 */

import { PostHog } from 'posthog-node';
import { getOrCreateAnonymousId, isFirstRun, markFirstRunComplete } from './id';
import type { ExecutionResult, ToolCallMetrics, StartupError } from './types';
import type { ToolCallTrace } from '../plugin/types';

// PostHog configuration
// This is a public write-only key - safe to commit
const POSTHOG_API_KEY = 'phc_aOtJsTJ38N4bdZVt8B2YeuwbQjsMtlTPQvyM7NtaZap';
const POSTHOG_HOST = 'https://us.i.posthog.com';

// Package version - imported dynamically to avoid circular deps
let VERSION = 'unknown';

/**
 * Check if telemetry is disabled via environment variable
 */
function isDisabled(): boolean {
  const value = process.env.AGENTUSE_TELEMETRY_DISABLED;
  return value === 'true' || value === '1';
}

/**
 * Check if running in CI environment
 */
function isCI(): boolean {
  return !!(
    process.env.CI ||
    process.env.GITHUB_ACTIONS ||
    process.env.GITLAB_CI ||
    process.env.CIRCLECI ||
    process.env.TRAVIS ||
    process.env.JENKINS_URL ||
    process.env.BUILDKITE
  );
}

/**
 * Check if running in Docker container
 */
function isDocker(): boolean {
  try {
    const fs = require('fs');
    // Check for .dockerenv file or cgroup
    return fs.existsSync('/.dockerenv') ||
      (fs.existsSync('/proc/1/cgroup') &&
        fs.readFileSync('/proc/1/cgroup', 'utf8').includes('docker'));
  } catch {
    return false;
  }
}

/**
 * Check if running via npx (not globally/locally installed)
 * npx runs from a cache directory like:
 * - ~/.npm/_npx/...
 * - node_modules/.npx-cache/...
 */
function isNpx(): boolean {
  try {
    const scriptPath = process.argv[1] || '';
    return (
      scriptPath.includes('/_npx/') ||
      scriptPath.includes('\\_npx\\') ||
      scriptPath.includes('/.npx-cache/') ||
      scriptPath.includes('\\.npx-cache\\')
    );
  } catch {
    return false;
  }
}

/**
 * Check if running from a local development build
 * Local dev builds have a .git folder in the package root
 */
function isLocalDev(): boolean {
  try {
    const fs = require('fs');
    const path = require('path');
    const packageRoot = path.join(__dirname, '..');
    return fs.existsSync(path.join(packageRoot, '.git'));
  } catch {
    return false;
  }
}

/**
 * Parse model identifier into provider and model name
 * e.g., "anthropic:claude-sonnet-4-5" -> { provider: "anthropic", modelName: "claude-sonnet-4-5" }
 */
export function parseModel(modelId: string): { provider: string; modelName: string } {
  const colonIndex = modelId.indexOf(':');
  if (colonIndex === -1) {
    // No provider prefix, assume it's just the model name
    return { provider: 'unknown', modelName: modelId };
  }
  return {
    provider: modelId.slice(0, colonIndex),
    modelName: modelId.slice(colonIndex + 1),
  };
}

/**
 * Aggregate tool call traces into metrics by type
 * MCP tools are prefixed with "mcp__"
 */
export function aggregateToolCalls(traces: ToolCallTrace[] | undefined): ToolCallMetrics {
  const metrics: ToolCallMetrics = {
    total: 0,
    builtin: 0,
    mcp: 0,
    subagent: 0,
  };

  if (!traces) return metrics;

  for (const trace of traces) {
    // Skip LLM calls - we only count tool calls
    if (trace.type === 'llm') continue;

    metrics.total++;

    if (trace.type === 'subagent') {
      metrics.subagent++;
    } else if (trace.name.startsWith('mcp__')) {
      metrics.mcp++;
    } else {
      metrics.builtin++;
    }
  }

  return metrics;
}

/**
 * Count LLM steps from traces
 */
export function countSteps(traces: ToolCallTrace[] | undefined): number {
  if (!traces) return 0;
  return traces.filter(t => t.type === 'llm').length;
}

/**
 * Extract time to first token from the first LLM trace
 * Returns undefined if not available
 */
export function getTimeToFirstToken(traces: ToolCallTrace[] | undefined): number | undefined {
  if (!traces) return undefined;

  // Find the first LLM trace with timing info
  const firstLlm = traces.find(t => t.type === 'llm');
  if (!firstLlm) return undefined;

  // TTFT would be the difference between promptTokens processing and first output
  // For now, we'll estimate from the trace timing if available
  // This is approximate - the trace records duration but not TTFT specifically
  return undefined; // Will be passed explicitly from the stream if needed
}

/**
 * Categorize error into a type for telemetry
 */
export function categorizeError(error: unknown): ExecutionResult['errorType'] {
  if (!error) return undefined;

  const message = error instanceof Error ? error.message.toLowerCase() : String(error).toLowerCase();

  if (message.includes('timeout') || message.includes('timed out')) {
    return 'timeout';
  }
  if (message.includes('abort') || message.includes('cancel') || message.includes('interrupt')) {
    return 'user_abort';
  }
  if (message.includes('api') || message.includes('rate limit') || message.includes('401') || message.includes('403')) {
    return 'api_error';
  }
  if (message.includes('tool') || message.includes('function')) {
    return 'tool_error';
  }

  return 'unknown';
}

/**
 * TelemetryManager handles anonymous usage tracking
 */
class TelemetryManager {
  private client: PostHog | null = null;
  private anonymousId: string | null = null;
  private enabled: boolean;
  private initialized: boolean = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    this.enabled = !isDisabled();
  }

  /**
   * Initialize the telemetry client
   * Must be called before capturing events
   */
  async init(version: string): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._init(version);
    return this.initPromise;
  }

  private async _init(version: string): Promise<void> {
    VERSION = version;

    if (!this.enabled) {
      this.initialized = true;
      return;
    }

    try {
      this.anonymousId = await getOrCreateAnonymousId();

      this.client = new PostHog(POSTHOG_API_KEY, {
        host: POSTHOG_HOST,
        // CLI: send events immediately, don't batch
        flushAt: 1,
        flushInterval: 0,
      });

      this.initialized = true;
    } catch {
      // Telemetry init failed - continue without it
      this.enabled = false;
      this.initialized = true;
    }
  }

  /**
   * Check if this is the first run (for showing telemetry notice)
   */
  async isFirstRun(): Promise<boolean> {
    if (!this.enabled) return false;
    return isFirstRun();
  }

  /**
   * Mark first run as complete (telemetry notice shown)
   */
  async markFirstRunComplete(): Promise<void> {
    if (!this.enabled) return;
    await markFirstRunComplete();
  }

  /**
   * Capture an agent execution event
   */
  captureExecution(result: ExecutionResult): void {
    if (!this.enabled || !this.initialized || !this.client || !this.anonymousId) {
      return;
    }

    try {
      this.client.capture({
        distinctId: this.anonymousId,
        event: 'agent_execution',
        properties: {
          // Ensure truly anonymous - no person profile
          $process_person_profile: false,

          // Version and environment
          version: VERSION,
          os: process.platform,
          arch: process.arch,
          node_version: process.version,
          is_ci: isCI(),
          is_docker: isDocker(),
          is_npx: isNpx(),
          is_local_dev: isLocalDev(),

          // Execution metrics (no sensitive data)
          provider: result.provider,
          model_name: result.modelName,
          duration_ms: result.durationMs,
          tokens_input: result.inputTokens,
          tokens_output: result.outputTokens,
          success: result.success,
          error_type: result.errorType,

          // Tool call metrics
          ...(result.toolCalls && {
            tool_calls_total: result.toolCalls.total,
            tool_calls_builtin: result.toolCalls.builtin,
            tool_calls_mcp: result.toolCalls.mcp,
            tool_calls_subagent: result.toolCalls.subagent,
          }),

          // LLM steps
          ...(result.steps !== undefined && { steps: result.steps }),

          // Performance & Reliability
          ...(result.finishReason && { finish_reason: result.finishReason }),
          ...(result.hasTextOutput !== undefined && { has_text_output: result.hasTextOutput }),
          ...(result.timeToFirstTokenMs !== undefined && { time_to_first_token_ms: result.timeToFirstTokenMs }),

          // Feature Adoption
          ...(result.features && {
            mcp_servers_count: result.features.mcpServersCount,
            subagents_configured: result.features.subagentsConfigured,
            skills_used: result.features.skillsUsed,
            mode: result.features.mode,
          }),

          // Configuration Patterns
          ...(result.config && {
            timeout_custom: result.config.timeoutCustom,
            max_steps_custom: result.config.maxStepsCustom,
            quiet_mode: result.config.quietMode,
            debug_mode: result.config.debugMode,
          }),

          // Error Patterns
          ...(result.errors && {
            doom_loop_triggered: result.errors.doomLoopTriggered,
            mcp_connection_failures: result.errors.mcpConnectionFailures,
          }),
        },
      });
    } catch {
      // Silently ignore capture errors
    }
  }

  /**
   * Capture a startup error event (auth or config errors before execution)
   */
  captureStartupError(error: StartupError): void {
    if (!this.enabled || !this.initialized || !this.client || !this.anonymousId) {
      return;
    }

    try {
      this.client.capture({
        distinctId: this.anonymousId,
        event: 'startup_error',
        properties: {
          $process_person_profile: false,

          // Version and environment
          version: VERSION,
          os: process.platform,
          arch: process.arch,
          node_version: process.version,
          is_ci: isCI(),
          is_docker: isDocker(),
          is_npx: isNpx(),
          is_local_dev: isLocalDev(),

          // Error details (anonymous)
          error_type: error.type,
          ...(error.provider && { provider: error.provider }),
          ...(error.field && { config_field: error.field }),
          ...(error.issue && { config_issue: error.issue }),
        },
      });
    } catch {
      // Silently ignore capture errors
    }
  }

  /**
   * Shutdown the telemetry client
   * Should be called before process exit to flush pending events
   */
  async shutdown(): Promise<void> {
    if (!this.client) return;

    try {
      await this.client.shutdown();
    } catch {
      // Ignore shutdown errors
    }
  }

  /**
   * Check if telemetry is enabled
   */
  isEnabled(): boolean {
    return this.enabled;
  }
}

// Singleton instance
export const telemetry = new TelemetryManager();

// Re-export types
export type { ExecutionResult, StartupError } from './types';
