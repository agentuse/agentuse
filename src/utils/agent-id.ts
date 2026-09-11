import { relative } from 'path';
import { stripAgentExtension } from './agent-name';

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
    return stripAgentExtension(relative(projectRoot, agentFilePath));
  }
  return fallback;
}

/**
 * Matches the `.agentuse` suffix case-insensitively.
 *
 * Agent discovery accepts a file whose extension is in any case (see the
 * `toLowerCase().endsWith('.agentuse')` filter in agents/discover.ts), so every
 * route that derives a name or id from the path has to strip it the same way.
 * A case-sensitive strip left `AGENT.AGENTUSE` discoverable but unresolvable,
 * and the codebase had plain, `/i` and `/u` variants sitting side by side.
 */
export { AGENT_EXTENSION_PATTERN, hasAgentExtension, stripAgentExtension, agentBaseName } from './agent-name';
