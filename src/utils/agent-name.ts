/**
 * Dependency-free helpers for the `.agentuse` file extension. Kept separate from
 * agent-id.ts (which imports node's `path`) so the browser bundle can share them.
 */
export const AGENT_EXTENSION_PATTERN = /\.agentuse$/iu;

/** Does the path end in `.agentuse`, in any letter case? */
export function hasAgentExtension(agentPath: string): boolean {
  return AGENT_EXTENSION_PATTERN.test(agentPath);
}

/** Strip a trailing `.agentuse` extension (case-insensitive). */
export function stripAgentExtension(agentPath: string): string {
  return agentPath.replace(AGENT_EXTENSION_PATTERN, '');
}

/** The final path segment with its `.agentuse` extension removed. Accepts either separator. */
export function agentBaseName(agentPath: string): string {
  const segments = agentPath.split(/[\\/]/u);
  return stripAgentExtension(segments[segments.length - 1] ?? agentPath);
}
