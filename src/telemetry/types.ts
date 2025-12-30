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
}

export interface FeatureUsage {
  /** Number of MCP servers configured */
  mcpServersCount: number;
  /** Number of subagents configured */
  subagentsConfigured: number;
  /** Whether skills were used */
  skillsUsed: boolean;
  /** Execution mode */
  mode: 'cli' | 'serve';
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
  /** Error category if failed */
  errorType?: 'timeout' | 'api_error' | 'tool_error' | 'user_abort' | 'unknown';
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
