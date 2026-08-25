/**
 * Telemetry module for anonymous usage tracking
 *
 * Collects anonymous usage data to help improve agentuse.
 * No personal information, prompts, code, or file paths are ever collected.
 *
 * Opt-out: Set AGENTUSE_TELEMETRY_DISABLED=true
 */

import { existsSync, readFileSync } from 'fs';
import { dirname, join } from 'path';
import { fileURLToPath } from 'url';
import type { PostHog } from 'posthog-node';
import {
  getOrCreateAnonymousIdentity,
  isFirstRun,
  markFirstExecutionComplete,
  markFirstRunComplete,
} from './id';
import type { ExecutionResult, StartupError, ServerStartConfig, ServerShutdownStats, AddCommandResult, TimeoutUnitError, WebUITelemetryEvent } from './types';
import type { ToolCallTrace } from '../plugin/types';
export { aggregateToolCalls, configuredFeatureUsage, countSteps, emptyToolCallMetrics } from './metrics.js';
export { classifyExecution, isCanonicalRemoteExample } from './classification.js';
export type { ExecutionClassification, ToolCallMetrics } from './types.js';

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
    // Check for .dockerenv file or cgroup
    return existsSync('/.dockerenv') ||
      (existsSync('/proc/1/cgroup') &&
        readFileSync('/proc/1/cgroup', 'utf8').includes('docker'));
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
    const packageRoot = join(dirname(fileURLToPath(import.meta.url)), '..');
    return existsSync(join(packageRoot, '.git'));
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
  // Match "api" as a whole word only; a substring test also caught "capital",
  // "unavailable", and file paths containing "api", mislabeling error_type.
  if (/\bapi\b/.test(message) || message.includes('rate limit') || message.includes('401') || message.includes('403')) {
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
  private identityPersisted: boolean = false;
  private identityMigrated: boolean = false;
  private installationCreatedAt: string | null = null;
  private firstExecutionPending: boolean = false;
  private firstExecutionWrite: Promise<void> | null = null;
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
  async init(version: string, options: { batchDelivery?: boolean } = {}): Promise<void> {
    if (this.initPromise) {
      return this.initPromise;
    }

    this.initPromise = this._init(version, options);
    return this.initPromise;
  }

  private async _init(version: string, options: { batchDelivery?: boolean }): Promise<void> {
    VERSION = version;

    if (!this.enabled) {
      this.initialized = true;
      return;
    }

    try {
      const identity = await getOrCreateAnonymousIdentity();
      this.anonymousId = identity.id;
      this.identityPersisted = identity.persisted;
      this.identityMigrated = identity.migrated;
      this.installationCreatedAt = identity.createdAt ?? null;
      this.firstExecutionPending = identity.persisted && identity.isFirstExecution;

      // Deferred: ~5MB that a telemetry-disabled process, and every serve
      // worker, would otherwise load for nothing.
      const { PostHog: PostHogClient } = await import('posthog-node');
      this.client = new PostHogClient(POSTHOG_API_KEY, {
        host: POSTHOG_HOST,
        // Short-lived CLI commands send immediately. The serve daemon queues
        // independent events and delivers them together through PostHog's
        // /batch endpoint. A conservative one-minute cadence keeps outbound
        // telemetry quiet while retaining each event's capture timestamp.
        flushAt: options.batchDelivery ? 100 : 1,
        flushInterval: options.batchDelivery ? 60_000 : 0,
        maxBatchSize: 100,
        // Suppress network error logs - telemetry failures shouldn't pollute output
        disableGeoip: true,
      });

      // Suppress PostHog error logging
      this.client.on('error', () => {
        // Silently ignore - telemetry errors are not important
      });

      // Lifecycle events use stable UUIDs and immutable timestamps. They are
      // deliberately retried on every launch: PostHog deduplicates successful
      // repeats, while an interrupted or failed send remains recoverable.
      if (identity.persisted && identity.createdAt && identity.installationEventId) {
        this.client.capture({
          distinctId: identity.id,
          event: 'installation_created',
          timestamp: new Date(identity.createdAt),
          uuid: identity.installationEventId,
          properties: {
            $process_person_profile: false,
            telemetry_schema_version: 2,
            version: VERSION,
            os: process.platform,
            arch: process.arch,
            node_version: process.version,
            is_ci: isCI(),
            is_docker: isDocker(),
            is_npx: isNpx(),
            is_local_dev: isLocalDev(),
            identity_persisted: true,
            installation_created_at: identity.createdAt,
          },
        });
      }
      if (identity.persisted && identity.firstExecutionAt && identity.firstExecutionAt !== 'legacy' && identity.activationEventId) {
        this.captureInstallationActivated(identity.firstExecutionAt, identity.activationEventId);
      }

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
    if (!this.enabled || !this.initialized || !this.client || !this.anonymousId) return;

    if (this.firstExecutionPending) {
      // Persist the cross-process activation claim before emitting its events.
      // If the process stops after this write, the stable lifecycle UUID is
      // retried on the next launch; if it stops before it, the identity remains
      // unclaimed and a later execution can safely try again.
      this.firstExecutionPending = false;
      this.firstExecutionWrite = markFirstExecutionComplete(this.anonymousId!).then(claim => {
        if (!claim) {
          this.firstExecutionPending = true;
          this.captureExecutionNow(result, false);
          return;
        }
        this.captureInstallationActivated(claim.firstExecutionAt, claim.activationEventId);
        this.captureExecutionNow(result, true);
      });
      return;
    }

    this.captureExecutionNow(result, false);
  }

  private captureExecutionNow(result: ExecutionResult, isFirstExecution: boolean): void {
    if (!this.enabled || !this.initialized || !this.client || !this.anonymousId) {
      return;
    }

    try {
      const executionOrigin = result.executionOrigin
        ?? (result.features?.mode === 'schedule'
          ? 'schedule'
          : result.features?.mode === 'cli'
            ? 'cli'
            : 'serve');
      this.client.capture({
        distinctId: this.anonymousId,
        event: 'agent_execution',
        properties: {
          // Ensure truly anonymous - no person profile
          $process_person_profile: false,
          telemetry_schema_version: 2,
          identity_persisted: this.identityPersisted,
          identity_migrated: this.identityMigrated,
          is_first_execution: isFirstExecution,
          execution_origin: executionOrigin,
          ...(result.reportedSurface && { reported_surface: result.reportedSurface }),
          ...(this.installationCreatedAt && { installation_created_at: this.installationCreatedAt }),

          // Privacy-safe activation context
          execution_class: result.classification.executionClass,
          agent_source: result.classification.agentSource,
          is_mock: result.classification.isMock,
          trigger: result.classification.trigger,

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
            tool_calls_skill: result.toolCalls.skill,
            mcp_used: result.toolCalls.mcp > 0,
            subagents_used: result.toolCalls.subagent > 0,
            skills_used: result.toolCalls.skill > 0,
          }),

          // LLM steps
          ...(result.steps !== undefined && { steps: result.steps }),

          // Performance & Reliability
          ...(result.finishReason && { finish_reason: result.finishReason }),
          ...(result.hasTextOutput !== undefined && { has_text_output: result.hasTextOutput }),
          ...(result.timeToFirstTokenMs !== undefined && { time_to_first_token_ms: result.timeToFirstTokenMs }),

          // Feature Adoption
          ...(result.features && {
            // Legacy names retained while saved insights migrate.
            mcp_servers_count: result.features.mcpServersCount,
            subagents_configured: result.features.subagentsConfigured,
            mcp_servers_configured_count: result.features.mcpServersCount,
            subagents_configured_count: result.features.subagentsConfigured,
            skills_configured_count: result.features.skillsConfigured,
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
      this.identityMigrated = false;
    } catch {
      // Silently ignore capture errors
    }
  }

  private captureInstallationActivated(firstExecutionAt: string, activationEventId: string): void {
    if (!this.client || !this.anonymousId) return;
    try {
      this.client.capture({
        distinctId: this.anonymousId,
        event: 'installation_activated',
        timestamp: new Date(firstExecutionAt),
        uuid: activationEventId,
        properties: {
          $process_person_profile: false,
          telemetry_schema_version: 2,
          identity_persisted: this.identityPersisted,
          first_execution_at: firstExecutionAt,
          ...(this.installationCreatedAt && { installation_created_at: this.installationCreatedAt }),
          version: VERSION,
          os: process.platform,
          arch: process.arch,
          node_version: process.version,
          is_ci: isCI(),
          is_docker: isDocker(),
          is_npx: isNpx(),
          is_local_dev: isLocalDev(),
        },
      });
    } catch {
      // Stable UUID + local state make this event retryable next launch.
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
   * Capture a rejected bare-number timeout (seconds-vs-milliseconds mixup).
   * Counts how many users hit the tools.bash.timeout unit break so the
   * migration cost of the 0.16 unit unification is measurable.
   */
  captureTimeoutUnitError(error: TimeoutUnitError): void {
    if (!this.enabled || !this.initialized || !this.client || !this.anonymousId) {
      return;
    }

    try {
      this.client.capture({
        distinctId: this.anonymousId,
        event: 'timeout_unit_error',
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

          // Rejection details (anonymous - a timeout magnitude only)
          surface: error.surface,
          config_field: error.field,
          value: error.value,
        },
      });
    } catch {
      // Silently ignore capture errors
    }
  }

  /**
   * Capture a server start event (for serve mode)
   */
  captureServerStart(config: ServerStartConfig): void {
    if (!this.enabled || !this.initialized || !this.client || !this.anonymousId) {
      return;
    }

    try {
      this.client.capture({
        distinctId: this.anonymousId,
        event: 'server_start',
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

          // Server configuration
          port: config.port,
          host: config.host,
          scheduled_agents: config.scheduledAgents,
          total_agents: config.totalAgents,
          auth_enabled: config.authEnabled,
        },
      });
    } catch {
      // Silently ignore capture errors
    }
  }

  /**
   * Capture a server shutdown event (for serve mode)
   */
  captureServerShutdown(stats: ServerShutdownStats): void {
    if (!this.enabled || !this.initialized || !this.client || !this.anonymousId) {
      return;
    }

    try {
      this.client.capture({
        distinctId: this.anonymousId,
        event: 'server_shutdown',
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

          // Server stats
          uptime_ms: stats.uptimeMs,
          total_executions: stats.totalExecutions,
          successful_executions: stats.successfulExecutions,
          failed_executions: stats.failedExecutions,
        },
      });
    } catch {
      // Silently ignore capture errors
    }
  }

  /** Capture a predefined Web UI intent reported through the local daemon. */
  captureWebUITelemetry(value: WebUITelemetryEvent): void {
    if (!this.enabled || !this.initialized || !this.client || !this.anonymousId) return;

    try {
      this.client.capture({
        distinctId: this.anonymousId,
        event: 'web_ui_page_viewed',
        properties: {
          $process_person_profile: false,
          telemetry_schema_version: 2,
          identity_persisted: this.identityPersisted,
          ...(this.installationCreatedAt && { installation_created_at: this.installationCreatedAt }),
          version: VERSION,
          os: process.platform,
          arch: process.arch,
          node_version: process.version,
          is_ci: isCI(),
          is_docker: isDocker(),
          is_npx: isNpx(),
          is_local_dev: isLocalDev(),
          page: value.page,
        },
      });
    } catch {
      // Telemetry is best-effort; never affect a serve response.
    }
  }

  /**
   * Capture an add command event (for agentuse add)
   */
  captureAddCommand(result: AddCommandResult): void {
    if (!this.enabled || !this.initialized || !this.client || !this.anonymousId) {
      return;
    }

    try {
      this.client.capture({
        distinctId: this.anonymousId,
        event: 'add_command',
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

          // Add command metrics
          source_type: result.sourceType,
          ...(result.source && { source: result.source }),
          ...(result.skillsInstalled?.length && { skills_installed: result.skillsInstalled }),
          ...(result.agentsInstalled?.length && { agents_installed: result.agentsInstalled }),
          mode: result.mode,
          force: result.force,
          duration_ms: result.durationMs,
          success: result.success,
          ...(result.errorType && { error_type: result.errorType }),
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
    if (this.firstExecutionWrite) {
      await this.firstExecutionWrite;
      this.firstExecutionWrite = null;
    }
    if (!this.client) return;

    try {
      // Use a short timeout to avoid blocking process exit
      await Promise.race([
        this.client.shutdown(),
        new Promise(resolve => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Ignore shutdown errors - telemetry is best-effort
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
export type { ExecutionResult, StartupError, ServerStartConfig, ServerShutdownStats, AddCommandResult } from './types';
