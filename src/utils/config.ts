/**
 * Configuration resolution utilities
 */

export const DEFAULT_TIMEOUT = 300; // 5 minutes in seconds
export const DEFAULT_MAX_STEPS = 100;
export const DEFAULT_TOOL_TIMEOUT = 60; // 60 seconds for individual tool calls

/**
 * Resolve effective timeout based on precedence: CLI > Agent YAML > Default
 */
export function resolveTimeout(
  cliTimeout: number,
  wasExplicit: boolean,
  agentTimeout?: number
): number {
  if (wasExplicit) {
    return cliTimeout;
  }
  return agentTimeout ?? DEFAULT_TIMEOUT;
}

/**
 * Resolve effective max steps based on precedence: CLI > Agent YAML > Default
 */
export function resolveMaxSteps(
  cliMaxSteps?: number,
  agentMaxSteps?: number
): number {
  return cliMaxSteps ?? agentMaxSteps ?? DEFAULT_MAX_STEPS;
}

/**
 * Resolve effective tool timeout based on precedence: Server Config > Global Env > Default
 * @param serverTimeout Optional timeout from server configuration (in seconds)
 * @returns Timeout in seconds (0 means no timeout)
 */
export function resolveToolTimeout(serverTimeout?: number): number {
  // Server-specific timeout takes precedence
  if (serverTimeout !== undefined) {
    return serverTimeout;
  }

  // Check global environment variable
  const envTimeout = process.env.MCP_TOOL_TIMEOUT;
  if (envTimeout !== undefined) {
    const parsed = parseInt(envTimeout);
    if (!isNaN(parsed) && parsed >= 0) {
      return parsed;
    }
  }

  // Fall back to default
  return DEFAULT_TOOL_TIMEOUT;
}
