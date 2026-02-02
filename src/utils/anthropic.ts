export const ANTHROPIC_IDENTITY_PROMPT = "You are Claude Code, Anthropic's official CLI for Claude.";

/**
 * Return true if model string targets an Anthropic provider.
 */
export function isAnthropicModel(model: string): boolean {
  return model.toLowerCase().includes('anthropic');
}

/**
 * Prepend the Anthropic identity system message when needed.
 */
export function addAnthropicIdentity(messages: Array<{ role: string; content: string }>, model: string): Array<{ role: string; content: string }> {
  if (!isAnthropicModel(model)) return messages;
  return [
    { role: 'system', content: ANTHROPIC_IDENTITY_PROMPT },
    ...messages,
  ];
}
