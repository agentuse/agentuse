/**
 * Telemetry types for anonymous usage tracking
 */

export interface ToolCallMetrics {
  /** Total tool calls */
  total: number;
  /** Builtin tool calls (bash, filesystem, etc.) */
  builtin: number;
  /** MCP server tool calls */
  mcp: number;
  /** Subagent invocations */
  subagent: number;
  /** Skill discovery/read invocations */
  skill: number;
}

export interface FeatureUsage {
  /** Number of MCP servers configured */
  mcpServersCount: number;
  /** Number of subagents configured */
  subagentsConfigured: number;
  /** Number of skills explicitly configured for preloading */
  skillsConfigured: number;
  /** Execution mode */
  mode: 'cli' | 'schedule' | 'webhook';
}

export type ExecutionClass = 'example' | 'user_agent' | 'test' | 'health_check';
export type AgentSource = 'local' | 'remote' | 'bundled' | 'installed' | 'unknown';
export type ExecutionTrigger = 'manual' | 'scheduled' | 'api';

/** Privacy-safe execution context. Never includes names, paths, URLs, or content. */
export interface ExecutionClassification {
  executionClass: ExecutionClass;
  agentSource: AgentSource;
  isMock: boolean;
  trigger: ExecutionTrigger;
}

export interface ConfigPatterns {
  /** Whether a custom timeout was set */
  timeoutCustom: boolean;
  /** Whether custom max steps was set */
  maxStepsCustom: boolean;
  /** Whether quiet mode is enabled */
  quietMode: boolean;
  /** Whether debug mode is enabled */
  debugMode: boolean;
}

export interface ErrorPatterns {
  /** Whether doom loop detection was triggered */
  doomLoopTriggered: boolean;
  /** Number of MCP connection failures */
  mcpConnectionFailures: number;
}

export interface StartupError {
  /** Error type: 'auth' for authentication errors, 'config' for configuration errors */
  type: 'auth' | 'config';
  /** Provider that failed (for auth errors) */
  provider?: string;
  /** Config field that failed (for config errors) */
  field?: string;
  /** Zod error code (for config errors): "invalid_type", "unrecognized_keys", etc. */
  issue?: string;
}

export interface TimeoutUnitError {
  /** Where the bad value arrived: agent config frontmatter or a model tool call */
  surface: 'config' | 'tool_call';
  /** Field involved (e.g. 'tools.bash.timeout') */
  field: string;
  /** The rejected bare-number value (a timeout magnitude; not sensitive) */
  value: number;
}

export interface ExecutionResult {
  /** Provider identifier (e.g., "anthropic", "openai", "openrouter") */
  provider: string;
  /** Model name (e.g., "claude-sonnet-4-5", "gpt-4o") */
  modelName: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Input token count */
  inputTokens: number;
  /** Output token count */
  outputTokens: number;
  /** Whether execution completed successfully */
  success: boolean;
  /** Context used to build trustworthy activation/adoption cohorts */
  classification: ExecutionClassification;
  /** Runtime that executed the agent; determined inside AgentUse. */
  executionOrigin?: 'cli' | 'schedule' | 'serve';
  /** Caller-reported serve surface. Best-effort, not an authentication claim. */
  reportedSurface?: 'web_ui' | 'mac_app' | 'api';
  /** Error category if failed */
  errorType?: 'timeout' | 'api_error' | 'tool_error' | 'user_abort' | 'incomplete' | 'unknown';
  /** Tool call breakdown by type */
  toolCalls?: ToolCallMetrics;
  /** Number of LLM steps/iterations */
  steps?: number;

  // Performance & Reliability
  /** Finish reason from LLM */
  finishReason?: string;
  /** Whether agent produced text output */
  hasTextOutput?: boolean;
  /** Time to first token in milliseconds */
  timeToFirstTokenMs?: number;

  // Feature Adoption
  features?: FeatureUsage;

  // Configuration Patterns
  config?: ConfigPatterns;

  // Error Patterns
  errors?: ErrorPatterns;
}

export interface TelemetryEvent {
  /** Anonymous user identifier (UUID) */
  distinctId: string;
  /** Event name */
  event: string;
  /** Event properties */
  properties: Record<string, unknown>;
}

export interface TelemetryConfig {
  /** PostHog API key */
  apiKey: string;
  /** PostHog host */
  host: string;
  /** Whether telemetry is enabled */
  enabled: boolean;
}

export interface ServerStartConfig {
  /** Server port */
  port: number;
  /** Server host */
  host: string;
  /** Number of scheduled agents */
  scheduledAgents: number;
  /** Total number of agents discovered */
  totalAgents: number;
  /** Whether API key auth is enabled */
  authEnabled: boolean;
}

export interface ServerShutdownStats {
  /** Server uptime in milliseconds */
  uptimeMs: number;
  /** Total number of executions */
  totalExecutions: number;
  /** Number of successful executions */
  successfulExecutions: number;
  /** Number of failed executions */
  failedExecutions: number;
}

export type WebUIClientSurface = 'web' | 'mac_app' | 'mac_setup';

export type OnboardingRoute = 'web' | 'desktop';

export type OnboardingStep =
  | 'desktop_setup'
  | 'project_created'
  | 'sample_run_completed'
  | 'agent_prompt_copied'
  | 'agent_detected'
  | 'agent_opened';

export type WebUITelemetryEvent =
  | {
      event: 'page_viewed';
      /** Privacy-safe top-level SPA page category. */
      page: 'home' | 'agents' | 'schedules' | 'sessions' | 'approvals' | 'stores' | 'settings' | 'learnings' | 'other';
      /** Container displaying the shared Web UI. */
      clientSurface: WebUIClientSurface;
    }
  | {
      event: 'desktop_app_launched';
      clientSurface: 'mac_app';
      launchMode: 'interactive' | 'login_item_hidden';
      onboardingComplete: boolean;
      loginItemEnabled: boolean;
    }
  | {
      event: 'onboarding_started' | 'onboarding_completed';
      onboardingRoute: OnboardingRoute;
      clientSurface: WebUIClientSurface;
      durationMs?: number;
      agentCount?: number;
      detectionMethod?: 'poll' | 'manual_check' | 'native_create';
    }
  | {
      event: 'onboarding_step_completed' | 'onboarding_step_failed';
      onboardingRoute: OnboardingRoute;
      clientSurface: WebUIClientSurface;
      step: OnboardingStep;
      durationMs?: number;
      errorCode?:
        | 'project_create_failed'
        | 'sample_run_failed'
        | 'provider_status_failed'
        | 'agent_check_failed'
        | 'cli_launcher_add_failed'
        | 'desktop_setup_failed';
      launchAtLoginEnabled?: boolean;
      cliLauncherStatus?: 'already_available' | 'added' | 'skipped' | 'conflict';
      providerReadiness?: 'ready' | 'not_ready' | 'unknown';
      agentCount?: number;
      detectionMethod?: 'poll' | 'manual_check' | 'native_create';
    };

export interface AddCommandResult {
  /** Source type: 'github', 'git', 'local', or 'skill' */
  sourceType: 'github' | 'git' | 'local' | 'skill';
  /** Source identifier (user/repo for GitHub, hostname for git, omitted for local) */
  source?: string;
  /** Names of skills installed (only for non-local sources) */
  skillsInstalled?: string[];
  /** Names of agents installed (only for non-local sources) */
  agentsInstalled?: string[];
  /** Selection mode: 'interactive', 'all', 'explicit', or 'list' */
  mode: 'interactive' | 'all' | 'explicit' | 'list';
  /** Whether --force flag was used */
  force: boolean;
  /** Duration in milliseconds */
  durationMs: number;
  /** Whether the command completed successfully */
  success: boolean;
  /** Error type if failed */
  errorType?: 'clone_failed' | 'validation_failed' | 'cancelled' | 'unknown';
}
