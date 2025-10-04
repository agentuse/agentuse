/**
 * Configuration resolution utilities
 */

export const DEFAULT_TIMEOUT = 300; // 5 minutes in seconds
export const DEFAULT_MAX_STEPS = 100;

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
