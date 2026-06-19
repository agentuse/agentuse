/**
 * Promote a human reviewer's approval-gate comment into a durable learning.
 *
 * Whenever a reviewer leaves a comment at an `await_human` gate, that comment is
 * the highest-signal feedback the agent gets. In practice the comment arrives
 * through the revise loop (a `comment` decision that re-presents the same gate),
 * not bundled into the final bare `approve`, so we capture on any commented
 * decision. If the comment is a durable, agent-wide rule (not a one-off edit to
 * this run), capture it so future runs apply it. Run-specific edits are filtered
 * out.
 *
 * @experimental
 */
import { completeText } from '../complete-text';
import type { ParsedAgent } from '../parser';
import type { Learning, LearningCategory, LearningOutcome } from './types';
import { LearningStore } from './store';
import { logger } from '../utils/logger';
import { ANTHROPIC_IDENTITY_PROMPT, isAnthropicModel } from '../utils/anthropic';

interface ApprovalDecision {
  status?: string;
  comment?: string;
}

/**
 * Narrow an opaque resume tool result to an approval decision.
 */
function readApprovalDecision(toolResult: unknown): ApprovalDecision | undefined {
  if (!toolResult || typeof toolResult !== 'object') return undefined;
  const r = toolResult as Record<string, unknown>;
  const status = typeof r.status === 'string' ? r.status : undefined;
  const comment = typeof r.comment === 'string' && r.comment.trim().length > 0
    ? r.comment.trim()
    : undefined;
  return { ...(status && { status }), ...(comment && { comment }) };
}

/**
 * Guarded entry point for the resume chokepoints. Promotes a reviewer comment
 * only when the agent has capture enabled and the decision carries a comment
 * (revise feedback or an approval note, whatever the status). Never throws:
 * capturing a learning must not fail a run.
 *
 * Returns a {@link LearningOutcome} when a capture was attempted (so the caller
 * can surface a session-log marker), or `undefined` when there was nothing to
 * promote (no comment, or capture disabled) and no marker is warranted.
 */
export async function maybePromoteApprovalComment(options: {
  agent: ParsedAgent;
  agentFilePath: string | undefined;
  toolResult: unknown;
}): Promise<LearningOutcome | undefined> {
  const { agent, agentFilePath } = options;
  if (!agentFilePath || !agent.config.learning?.capture) return undefined;

  const decision = readApprovalDecision(options.toolResult);
  if (!decision?.comment) return undefined;

  try {
    const learning = await promoteApprovalComment({
      comment: decision.comment,
      agentInstructions: agent.instructions,
      agentModel: agent.config.model,
      agentFilePath,
      learningFile: agent.config.learning.file,
    });
    return learning
      ? { status: 'captured', source: 'approval', count: 1, titles: [learning.title] }
      : { status: 'none', source: 'approval', count: 0, titles: [] };
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    logger.debug(`[Learning] Approval-comment capture failed: ${detail}`);
    return { status: 'failed', source: 'approval', count: 0, titles: [], detail };
  }
}

interface RawPromotion {
  applies: boolean;
  category?: LearningCategory;
  title?: string;
  instruction?: string;
}

/**
 * Run the generalizability filter on a single approval comment and, when it is
 * a durable agent-wide rule, add it to the learning store as an approval-sourced
 * learning. No-op when the comment is judged run-specific.
 */
export async function promoteApprovalComment(options: {
  comment: string;
  agentInstructions: string;
  agentModel: string;
  agentFilePath: string;
  learningFile?: string | undefined;
}): Promise<Learning | undefined> {
  const { comment, agentInstructions, agentModel, agentFilePath, learningFile } = options;

  const truncatedInstructions = agentInstructions.length > 3000
    ? agentInstructions.slice(0, 3000) + '\n...(truncated)'
    : agentInstructions;

  const prompt = `A human reviewer left a comment on this agent's work at an approval gate. Your job: decide whether the comment is a DURABLE, AGENT-WIDE rule worth applying to every future run, or a ONE-OFF correction specific to this run.

## Agent Instructions
${truncatedInstructions}

## Reviewer's Approval Comment
${comment}

## Decision Criteria
- APPLIES (durable): a general guideline, preference, or constraint that should shape every future run. Examples: "always cite a source before publishing", "keep the subject line under 50 chars", "never include pricing without the disclaimer".
- DOES NOT APPLY (one-off): a correction tied to this specific run's content, data, or context. Examples: "fix the typo in paragraph 2", "change the date to Tuesday", "this number is wrong".

Be conservative: only mark applies=true when the comment clearly generalizes. When in doubt, applies=false.

If it applies, write the learning as a clear, specific instruction for the agent (not a restatement of the comment), and pick the best category:
- tip: positive guidance ("Do X for better results")
- warning: things to avoid ("Don't do Y because...")
- pattern: reusable approach ("When X happens, do Y")
- tool-usage: tool-specific guidance
- error-fix: error recovery patterns

Respond with ONLY a JSON object, no other text:
{"applies": true, "category": "tip", "title": "Short title", "instruction": "Detailed instruction"}
or
{"applies": false}`;

  // Use completeText (streaming) so this works on the ChatGPT Codex backend,
  // which rejects the non-streaming generateText() path. For Anthropic OAuth the
  // Claude Code identity prompt must be the system prompt; other providers get a
  // short role (which also becomes Codex's required `instructions`).
  const system = isAnthropicModel(agentModel)
    ? ANTHROPIC_IDENTITY_PROMPT
    : 'You decide whether a reviewer comment is a durable agent-wide rule and reply with a JSON object only.';

  const responseText = await completeText(agentModel, {
    system,
    prompt,
  });

  let parsed: RawPromotion;
  try {
    const text = responseText.trim();
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    parsed = JSON.parse(jsonMatch[1] || text);
  } catch {
    logger.debug(`[Learning] Failed to parse approval promotion response: ${responseText.slice(0, 200)}`);
    return undefined;
  }

  if (!parsed?.applies || !parsed.category || !parsed.title || !parsed.instruction) {
    logger.debug('[Learning] Approval comment judged run-specific; not captured');
    return undefined;
  }

  const learning: Learning = {
    id: Math.random().toString(36).slice(2, 10),
    category: parsed.category,
    title: parsed.title,
    instruction: parsed.instruction,
    confidence: 0.95, // human-sourced, high trust
    appliedCount: 0,
    extractedAt: new Date().toISOString(),
    source: 'approval',
  };

  const store = LearningStore.fromAgentFile(agentFilePath, learningFile);
  await store.add([learning]);
  logger.info(`[Learning] Captured approval comment → ${store.filePath}`);
  return learning;
}
