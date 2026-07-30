import type { Tool } from 'ai';
import { isEffectful } from './approval-lease.js';
import { isSuspendSignal } from './suspend.js';

const RUNTIME_REVIEWER = { username: 'agentuse-runtime' };

function changeContents(input: Record<string, unknown>): string[] {
  if (!Array.isArray(input.changes)) return [];
  return input.changes.flatMap((entry) => {
    if (!entry || typeof entry !== 'object') return [];
    const content = (entry as Record<string, unknown>).content;
    return typeof content === 'string' && content.trim() ? [content.trim()] : [];
  });
}

function scopedChangeContents(input: Record<string, unknown>): Map<string, string[]> {
  const scoped = new Map<string, string[]>();
  if (!Array.isArray(input.changes)) return scoped;
  for (const entry of input.changes) {
    if (!entry || typeof entry !== 'object') continue;
    const record = entry as Record<string, unknown>;
    const optionId = typeof record.optionId === 'string' ? record.optionId.trim() : '';
    const content = typeof record.content === 'string' ? record.content.trim() : '';
    if (!optionId || !content) continue;
    scoped.set(optionId, [...(scoped.get(optionId) ?? []), content]);
  }
  return scoped;
}

/**
 * A non-empty changes[] on an agent with gated commands is an authorization
 * plan. At least one entry must name a complete gated command; otherwise a
 * human approval would grant no executable authority and the run would ask
 * again after the command is denied.
 *
 * Empty changes remain valid for final-answer gates and pick gates that do not
 * yet describe an executable action.
 */
export function validateEffectfulGatePlan(
  input: Record<string, unknown>,
  effectPatterns: string[],
): string | undefined {
  if (effectPatterns.length === 0) return undefined;
  const contents = changeContents(input);
  if (contents.length === 0) return undefined;
  if (!contents.some((content) => isEffectful(content, effectPatterns))) {
    return 'This approval request lists actions in changes[], but none is a complete command covered by this agent\'s tools.bash.gated patterns. The approval would authorize no gated command. Put the exact complete shell command in changes[].content, or omit changes[] when this gate is not authorizing an action.';
  }

  const options = Array.isArray(input.options) ? input.options : [];
  const scoped = scopedChangeContents(input);
  if (options.length > 0 && scoped.size > 0) {
    const missing = options.flatMap((option) => {
      if (!option || typeof option !== 'object') return [];
      const id = (option as Record<string, unknown>).id;
      if (typeof id !== 'string' || !id.trim()) return [];
      const commands = scoped.get(id.trim()) ?? [];
      return commands.some((command) => isEffectful(command, effectPatterns))
        ? []
        : [id.trim()];
    });
    if (missing.length > 0) {
      return `This option-selection approval would leave these choices without a gated command: ${missing.join(', ')}. Add one complete gated command to changes[] for each option and bind it with the matching optionId.`;
    }
  }
  return undefined;
}

/** Append one exact command to a plain pending gate, without creating a second
 * authorization when the agent already included the command verbatim. Pick
 * gates are intentionally excluded: an automatically attached unconditional
 * command would bypass the reviewer\'s option selection. */
export function attachCommandToPendingGate(
  input: Record<string, unknown>,
  command: string,
): boolean {
  if (!command.trim()) return false;
  if (Array.isArray(input.options) && input.options.length > 0) return false;

  const changes = Array.isArray(input.changes) ? input.changes : [];
  const alreadyPresent = changes.some((entry) => (
    entry
    && typeof entry === 'object'
    && typeof (entry as Record<string, unknown>).content === 'string'
    && (entry as Record<string, unknown>).content === command
  ));
  if (alreadyPresent) return false;

  changes.push({ label: 'Exact gated command', content: command });
  input.changes = changes;
  return true;
}

export function withGatePlanPreflight<T extends Tool>(
  tool: T,
  options: {
    effectPatterns: string[];
    onInlineResolution?: (result: unknown) => void;
  },
): T {
  const innerExecute = tool.execute;
  if (!innerExecute) return tool;

  return {
    ...tool,
    execute: async (input: Record<string, unknown>, callOptions: unknown) => {
      const failure = validateEffectfulGatePlan(input, options.effectPatterns);
      if (failure) {
        const result = {
          status: 'rejected',
          source: 'gate-preflight',
          comment: `[AgentUse gate preflight — not the human reviewer] ${failure}`,
          reviewer: RUNTIME_REVIEWER,
        };
        options.onInlineResolution?.(result);
        return result;
      }

      try {
        const result = await innerExecute(input as never, callOptions as never);
        // A real gate throws SuspendSignal. Any returned value is an inline
        // machine decision (verify bounce, mock decision, or tool result), so
        // stream-scoped gate/barrier state must be cleared before the next step.
        options.onInlineResolution?.(result);
        return result;
      } catch (error) {
        if (!isSuspendSignal(error)) options.onInlineResolution?.(error);
        throw error;
      }
    },
  } as T;
}
