import type { AgentConfig } from '../parser';

/**
 * Represents an environment variable reference found in the agent config
 */
export interface EnvVarReference {
  name: string;           // e.g., "API_TOKEN"
  source: string;         // e.g., "mcpServers.api_server"
  type: 'inline' | 'required' | 'allowed';
  required: boolean;
}

/**
 * Result of environment variable validation
 */
export interface EnvValidationResult {
  valid: boolean;
  missingRequired: EnvVarReference[];
  missingOptional: EnvVarReference[];
}

/**
 * Regex to match ${env:VAR_NAME} syntax
 */
const ENV_VAR_PATTERN = /\$\{env:(\w+)\}/g;

/**
 * Deep scan an object for ${env:VAR_NAME} patterns
 */
function extractInlineEnvVars(obj: unknown, path: string, refs: EnvVarReference[]): void {
  if (typeof obj === 'string') {
    let match;
    while ((match = ENV_VAR_PATTERN.exec(obj)) !== null) {
      refs.push({
        name: match[1],
        source: path,
        type: 'inline',
        required: true // inline references are treated as required
      });
    }
    // Reset regex lastIndex for next string
    ENV_VAR_PATTERN.lastIndex = 0;
  } else if (Array.isArray(obj)) {
    obj.forEach((item, index) => {
      extractInlineEnvVars(item, `${path}[${index}]`, refs);
    });
  } else if (obj !== null && typeof obj === 'object') {
    for (const [key, value] of Object.entries(obj)) {
      extractInlineEnvVars(value, path ? `${path}.${key}` : key, refs);
    }
  }
}

/**
 * Extract all environment variable references from an agent config
 */
export function extractEnvVarReferences(config: AgentConfig): EnvVarReference[] {
  const refs: EnvVarReference[] = [];

  // Extract from MCP servers
  if (config.mcpServers) {
    for (const [serverName, serverConfig] of Object.entries(config.mcpServers)) {
      const source = `mcpServers.${serverName}`;

      // Extract inline ${env:VAR_NAME} references
      extractInlineEnvVars(serverConfig, source, refs);

      // Extract requiredEnvVars
      if ('requiredEnvVars' in serverConfig && serverConfig.requiredEnvVars) {
        for (const varName of serverConfig.requiredEnvVars) {
          refs.push({
            name: varName,
            source,
            type: 'required',
            required: true
          });
        }
      }

      // Extract allowedEnvVars
      if ('allowedEnvVars' in serverConfig && serverConfig.allowedEnvVars) {
        for (const varName of serverConfig.allowedEnvVars) {
          refs.push({
            name: varName,
            source,
            type: 'allowed',
            required: false
          });
        }
      }
    }
  }

  return refs;
}

/**
 * Validate environment variables against current process.env
 */
export function validateEnvVars(refs: EnvVarReference[]): EnvValidationResult {
  const missingRequired: EnvVarReference[] = [];
  const missingOptional: EnvVarReference[] = [];
  const seen = new Set<string>();

  for (const ref of refs) {
    // Deduplicate by name (same var might be referenced multiple times)
    const key = `${ref.name}:${ref.required}`;
    if (seen.has(key)) continue;
    seen.add(key);

    if (process.env[ref.name] === undefined) {
      if (ref.required) {
        missingRequired.push(ref);
      } else {
        missingOptional.push(ref);
      }
    }
  }

  return {
    valid: missingRequired.length === 0,
    missingRequired,
    missingOptional
  };
}

/**
 * Format validation result as a user-friendly message
 */
export function formatEnvValidationError(result: EnvValidationResult): string {
  const lines: string[] = [];

  if (result.missingRequired.length > 0) {
    lines.push('Missing required environment variables:');
    lines.push('');

    // Group by source (MCP server)
    const bySource = new Map<string, EnvVarReference[]>();
    for (const ref of result.missingRequired) {
      const existing = bySource.get(ref.source) || [];
      existing.push(ref);
      bySource.set(ref.source, existing);
    }

    for (const [source, refs] of bySource) {
      lines.push(`  ${source}:`);
      for (const ref of refs) {
        const typeLabel = ref.type === 'inline' ? 'in config value' : `in ${ref.type}EnvVars`;
        lines.push(`    - ${ref.name} (${typeLabel})`);
      }
    }

    lines.push('');
    lines.push('Please set these in your .env file or export them in your shell.');
  }

  if (result.missingOptional.length > 0) {
    if (lines.length > 0) lines.push('');
    lines.push('Optional environment variables not set:');
    lines.push('');

    // Group by source
    const bySource = new Map<string, EnvVarReference[]>();
    for (const ref of result.missingOptional) {
      const existing = bySource.get(ref.source) || [];
      existing.push(ref);
      bySource.set(ref.source, existing);
    }

    for (const [source, refs] of bySource) {
      lines.push(`  ${source}:`);
      for (const ref of refs) {
        lines.push(`    - ${ref.name}`);
      }
    }
  }

  return lines.join('\n');
}

/**
 * Validate all environment variables for an agent config
 * Returns validation result with all missing variables
 */
export function validateAgentEnvVars(config: AgentConfig): EnvValidationResult {
  const refs = extractEnvVarReferences(config);
  return validateEnvVars(refs);
}
