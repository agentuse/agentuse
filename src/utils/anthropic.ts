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

/**
 * The system prompt for a helper LLM call — learning extraction, tidy-up, the
 * verify judge, benchmark scoring — given the role that call plays.
 *
 * Every one of those sites used to choose BETWEEN the identity and the role:
 * on an Anthropic model the role was dropped entirely, so the extractor was
 * told nothing about extracting and the judge nothing about judging. Only
 * non-Anthropic providers ever saw the role, and no agent in a Claude-authed
 * fleet is one.
 *
 * The role cannot simply be appended to the identity. Anthropic OAuth accepts
 * that line only as an exact, standalone system block; concatenating anything
 * onto it is rejected as a 429 whose body reads `rate_limit_error` with the
 * message "Error", which is indistinguishable from real throttling until you
 * notice the identity alone succeeds on either side of it. Measured against
 * `\n\n`, `\n` and a single space — all three fail, all three reproducibly.
 *
 * So the role rides as a SECOND system block, which is what the agent loop has
 * always done (addAnthropicIdentity above prepends the identity to the agent's
 * own system messages, and execution.ts sends the array with
 * `allowSystemInMessages`). This is the same shape, for one-shot calls.
 */
export interface HelperSystemPrompt {
  instructions: string;
  extraSystem?: string | undefined;
}

export function helperSystemPrompt(model: string, role: string): HelperSystemPrompt {
  if (!isAnthropicModel(model)) return { instructions: role };
  return { instructions: ANTHROPIC_IDENTITY_PROMPT, extraSystem: role };
}
