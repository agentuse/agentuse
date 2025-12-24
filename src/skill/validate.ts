import type { ToolsConfig } from '../tools/types.js';
import type { ToolValidationResult } from './types.js';

/**
 * Tool pattern aliases
 */
const TOOL_ALIASES: Record<string, string> = {
  'Read': 'tools__filesystem_read',
  'Write': 'tools__filesystem_write',
  'Edit': 'tools__filesystem_edit',
};

/**
 * Parse a Bash pattern like "Bash(git:*)" or "Bash(python3:*)"
 * Returns the command name or null if not a bash pattern
 */
function parseBashPattern(pattern: string): string | null {
  const match = pattern.match(/^Bash\(([^:]+):\*\)$/);
  return match ? match[1] : null;
}

/**
 * Check if a single tool pattern is satisfied by the agent's tools config
 */
function validateToolPattern(
  pattern: string,
  toolsConfig: ToolsConfig | undefined
): ToolValidationResult {
  // Resolve aliases
  const resolvedPattern = TOOL_ALIASES[pattern] || pattern;

  // Check for plain "Bash" pattern (requires any bash config)
  if (resolvedPattern === 'Bash') {
    if (!toolsConfig?.bash?.commands || toolsConfig.bash.commands.length === 0) {
      return {
        pattern,
        satisfied: false,
        reason: 'Bash tool not configured for this agent',
      };
    }
    return { pattern, satisfied: true };
  }

  // Check for Bash patterns like "Bash(git:*)"
  const bashCommand = parseBashPattern(resolvedPattern);
  if (bashCommand) {
    if (!toolsConfig?.bash?.commands) {
      return {
        pattern,
        satisfied: false,
        reason: 'Bash tool not configured',
      };
    }

    const hasCommand = toolsConfig.bash.commands.some(
      cmd => cmd === bashCommand || cmd.startsWith(`${bashCommand} `)
    );

    if (!hasCommand) {
      return {
        pattern,
        satisfied: false,
        reason: `Bash command "${bashCommand}" not in allowed commands`,
      };
    }

    return { pattern, satisfied: true };
  }

  // Check for filesystem tools
  if (resolvedPattern === 'tools__filesystem_read') {
    const hasRead = toolsConfig?.filesystem?.some(c => c.permissions.includes('read'));
    return {
      pattern,
      satisfied: !!hasRead,
      reason: hasRead ? undefined : 'Filesystem read permission not configured',
    };
  }

  if (resolvedPattern === 'tools__filesystem_write') {
    const hasWrite = toolsConfig?.filesystem?.some(c => c.permissions.includes('write'));
    return {
      pattern,
      satisfied: !!hasWrite,
      reason: hasWrite ? undefined : 'Filesystem write permission not configured',
    };
  }

  if (resolvedPattern === 'tools__filesystem_edit') {
    const hasEdit = toolsConfig?.filesystem?.some(c => c.permissions.includes('edit'));
    return {
      pattern,
      satisfied: !!hasEdit,
      reason: hasEdit ? undefined : 'Filesystem edit permission not configured',
    };
  }

  // Unknown pattern - assume satisfied (don't block on unknown patterns)
  return { pattern, satisfied: true };
}

/**
 * Validate all allowed-tools patterns against agent's tools config
 * Returns array of unsatisfied patterns with reasons
 */
export function validateAllowedTools(
  allowedTools: string[] | undefined,
  toolsConfig: ToolsConfig | undefined
): ToolValidationResult[] {
  if (!allowedTools || allowedTools.length === 0) {
    return [];
  }

  return allowedTools
    .map(pattern => validateToolPattern(pattern, toolsConfig))
    .filter(result => !result.satisfied);
}

/**
 * Format unsatisfied tools as warning message
 */
export function formatToolsWarning(unsatisfied: ToolValidationResult[]): string | null {
  if (unsatisfied.length === 0) return null;

  const details = unsatisfied.map(r => `- ${r.pattern}: ${r.reason}`).join('\n');
  const hasBash = unsatisfied.some(r => r.pattern === 'Bash' || r.pattern.startsWith('Bash('));

  const lines = [
    '> ⚠️ **WARNING: Required tools not available**',
    '>',
    '> This skill requires tools that are not configured for this agent:',
    details.split('\n').map(line => `> ${line}`).join('\n'),
    '>',
    '> The agent cannot execute these operations without the required tools.',
  ];

  if (hasBash) {
    lines.push(
      '> To enable bash, add to your agent YAML:',
      '> ```yaml',
      '> tools:',
      '>   bash:',
      '>     commands:',
      '>       - "python3 *"',
      '>       - "date"',
      '> ```',
    );
  }

  return lines.join('\n');
}
