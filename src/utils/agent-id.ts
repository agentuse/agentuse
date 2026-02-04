import { relative } from 'path';

/**
 * Compute agent ID from file path
 *
 * Agent ID is a file-path-based identifier used for:
 * - Session directory naming
 * - Store directory naming
 * - Learning file naming
 *
 * @param agentFilePath Full path to the .agentuse file
 * @param projectRoot Project root directory
 * @param fallback Fallback value if agentFilePath or projectRoot is not available (typically agent.name)
 * @returns Agent ID (e.g., "social/quotes/1-quotes-create") or fallback
 *
 * @example
 * // Full path: /root/social/quotes/1-quotes-create.agentuse
 * // Project root: /root
 * // Result: "social/quotes/1-quotes-create"
 * computeAgentId('/root/social/quotes/1-quotes-create.agentuse', '/root', 'fallback')
 */
export function computeAgentId(
  agentFilePath: string | undefined,
  projectRoot: string | undefined,
  fallback: string
): string {
  if (agentFilePath && projectRoot) {
    return relative(projectRoot, agentFilePath).replace(/\.agentuse$/, '');
  }
  return fallback;
}
