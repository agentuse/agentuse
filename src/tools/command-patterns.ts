import type { BashConfig } from './types.js';
import { ToolConfigError } from './types.js';
import { resolveAllowedPath, type PathResolverContext } from './path-validator.js';

/** Resolve only runtime-owned path placeholders, never environment variables
 * or shell input. Both allowlists and approval patterns use this contract. */
export function resolveCommandPatterns(patterns: readonly string[], context: PathResolverContext): string[] {
  return patterns.map((pattern) => pattern.replace(/\$\{(root|agentDir|tmpDir)\}/g, (placeholder, name: string) => {
    if (name === 'agentDir' && !context.agentDir) {
      throw new ToolConfigError('Bash command pattern uses ${agentDir}, but no agent directory is available. Load the agent from a file.');
    }
    const value = resolveAllowedPath(placeholder, context);
    // Current matchers split patterns on whitespace and interpret * and ? as
    // wildcards. Never let a directory name add tokens or widen a grant.
    if (!/^[/a-zA-Z0-9_.:\\-]+$/.test(value)) {
      throw new ToolConfigError(`Cannot use ${placeholder} in a Bash command pattern: its path contains whitespace or pattern/shell metacharacters. Use a project-relative command pattern instead.`);
    }
    return value;
  }));
}

export function resolveBashPatterns(config: BashConfig, context: PathResolverContext): BashConfig {
  return {
    ...config,
    commands: resolveCommandPatterns(config.commands ?? [], context),
    ...(config.gated && { gated: resolveCommandPatterns(config.gated, context) }),
  };
}
