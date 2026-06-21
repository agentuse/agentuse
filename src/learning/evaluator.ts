import { completeText } from '../complete-text';
import type { AgentCompleteEvent, ToolCallTrace } from '../plugin/types';
import type { ApprovalReview, Learning, LearningCategory, LearningSource } from './types';
import { logger } from '../utils/logger';
import { ANTHROPIC_IDENTITY_PROMPT, isAnthropicModel } from '../utils/anthropic';

/**
 * Stringify a tool input/output value for the evaluator, truncated to keep the
 * prompt bounded. Objects are JSON-encoded; strings pass through as-is so a tool
 * that already returns text isn't double-quoted.
 */
function formatTraceValue(value: unknown, limit: number): string {
  const str = typeof value === 'string' ? value : JSON.stringify(value);
  if (!str) return '';
  return str.length > limit ? `${str.slice(0, limit)}...` : str;
}

/**
 * Format tool calls with inputs AND outputs for evaluation. The output is what
 * makes a learning concrete ("when tool X returns Y, do Z"), so we surface it
 * alongside the input rather than relying on the raw console dump. Both are
 * truncated to avoid context bloat.
 */
function formatToolCalls(traces: ToolCallTrace[] | undefined): string {
  if (!traces || traces.length === 0) return 'No tool calls';

  return traces.map(t => {
    const status = t.success ? '✓' : '✗';
    const inputStr = t.input !== undefined
      ? `\n    Input: ${formatTraceValue(t.input, 500)}`
      : '';
    const outputStr = t.output !== undefined
      ? `\n    Output: ${formatTraceValue(t.output, 800)}`
      : '';
    return `- [${status}] ${t.name} (${t.duration}ms)${inputStr}${outputStr}`;
  }).join('\n');
}

interface RawLearning {
  category: 'tip' | 'warning' | 'pattern' | 'tool-usage' | 'error-fix';
  title: string;
  instruction: string;
  confidence: number;
  source?: 'auto' | 'approval';
}

/**
 * Render reviewer feedback (resolved approval-gate comments + the work shown at
 * each gate) for the prompt. Indents the work so the model can tell comment from
 * artifact. Empty string when the run had no commented gates.
 */
function formatReviews(reviews: ApprovalReview[]): string {
  if (reviews.length === 0) return '';
  const blocks = reviews.map((r, idx) => {
    const work = r.work
      ? `\n   Work the reviewer was looking at:\n${r.work.split('\n').map(line => `   | ${line}`).join('\n')}`
      : '';
    return `${idx + 1}. Reviewer comment: ${r.comment}${work}`;
  });
  return blocks.join('\n\n');
}

/**
 * Evaluate a completed run and extract high-signal learnings from BOTH the
 * execution itself and any reviewer feedback left at approval gates, in a single
 * pass. Execution-derived learnings are tagged source="auto"; learnings that
 * capture the durable principle behind a reviewer comment are tagged
 * source="approval" (higher trust, ranked first when applied).
 */
export async function evaluateExecution(
  event: AgentCompleteEvent,
  agentInstructions: string,
  agentModel: string,
  criteria: string | undefined,
  existingLearnings: Learning[] = [],
  reviews: ApprovalReview[] = [],
): Promise<Learning[]> {
  const customCriteria = criteria
    ? `\n\nAdditional evaluation criteria:\n${criteria}`
    : '';

  // Truncate console output to avoid context bloat
  // Keep first 2000 and last 1000 chars for better context
  let consoleOutput = event.consoleOutput;
  if (consoleOutput.length > 5000) {
    const first = consoleOutput.slice(0, 2000);
    const last = consoleOutput.slice(-1000);
    consoleOutput = `${first}\n\n...(${consoleOutput.length - 3000} chars truncated)...\n\n${last}`;
  }

  // Truncate agent instructions if too long
  const truncatedInstructions = agentInstructions.length > 3000
    ? agentInstructions.slice(0, 3000) + '\n...(truncated)'
    : agentInstructions;

  const hasReviews = reviews.length > 0;
  const reviewerSection = hasReviews
    ? `

## Reviewer Feedback (highest-signal — a human reviewed this run)
${formatReviews(reviews)}`
    : '';

  const prompt = `You are evaluating a completed agent run to extract learnings for future runs. Two sources of signal: the execution itself, and any human reviewer feedback left at approval gates.

## Agent Instructions
${truncatedInstructions}

## Execution Results
- Duration: ${event.result.duration.toFixed(2)}s
- Tool Calls: ${event.result.toolCalls}
- Finish Reason: ${event.result.finishReason || 'unknown'}

## Tool Calls (with inputs and outputs)
${formatToolCalls(event.result.toolCallTraces)}

## Console Output (logs and additional output)
${consoleOutput || '(No console output)'}

## Agent Text Output
${event.result.text || '(No text output)'}${reviewerSection}
${customCriteria}
${existingLearnings.length > 0 ? `
## Existing Learnings (DO NOT DUPLICATE)
The following learnings already exist. Do NOT extract learnings that cover the same concepts:
${existingLearnings.map(l => `- [${l.category}] ${l.title}: ${l.instruction.slice(0, 150)}${l.instruction.length > 150 ? '...' : ''}`).join('\n')}
` : ''}

## Task
Extract actionable learnings that would improve future runs. Each learning is tagged with a "source":

- source "approval" — the durable principle behind a REVIEWER COMMENT above. Reviewer comments are the highest-signal feedback this agent gets; treat them as authoritative. Comments often point at the work ("this is too long", "cite a source here", "tone is off"): use the work shown to understand what they mean, then extract the GENERAL rule behind it. A comment about this run's specific content STILL counts if a reusable rule sits behind it (e.g. "this intro is too salesy" → "Keep intros factual; avoid promotional language"). ONLY skip a comment that is a pure one-off edit with nothing generalizable ("fix the typo in paragraph 2", "change the date to Tuesday").
- source "auto" — a learning from the EXECUTION. Ground it in the ACTUAL tool outputs and agent output above (an empty result, an error shape, a format a tool returned), not just which tools were called.

Rules:
- Extract 0-5 learnings MAXIMUM. Prefer fewer, higher-quality learnings. Capture every durable reviewer principle, but be sparing with "auto" learnings.
- If nothing is worth keeping, return an empty array []
- For "auto" learnings, only include ones you're confident about (confidence ≥ 0.8). For "approval" learnings, set confidence to 0.95.
- Each learning must be a clear, specific, output-grounded instruction (not a restatement of the comment).
- Avoid generic or obvious learnings that wouldn't add value.

Categories:
- tip: Positive guidance ("Do X for better results")
- warning: Things to avoid ("Don't do Y because...")
- pattern: Reusable approach ("When X happens, do Y")
- tool-usage: Tool-specific guidance
- error-fix: Error recovery patterns

Respond with ONLY a JSON array of learnings. No other text.
Example format:
[
  {"source": "approval", "category": "warning", "title": "Short title", "instruction": "Detailed instruction", "confidence": 0.95},
  {"source": "auto", "category": "tip", "title": "Short title", "instruction": "Detailed instruction", "confidence": 0.9}
]

If no learnings are applicable, respond with an empty array: []`;

  // Use completeText (streaming) so this works on the ChatGPT Codex backend,
  // which rejects the non-streaming generateText() path and silently 400s the
  // moment a Codex-authed user triggers learning. For Anthropic OAuth the Claude
  // Code identity prompt must be the system prompt; other providers get a short
  // evaluator role (which also becomes Codex's required `instructions`).
  const system = isAnthropicModel(agentModel)
    ? ANTHROPIC_IDENTITY_PROMPT
    : 'You extract concise, high-signal learnings from an agent run and its reviewer feedback, and reply with a JSON array only.';

  const responseText = await completeText(agentModel, {
    system,
    prompt,
  });

  // Parse JSON from response
  let rawLearnings: RawLearning[] = [];
  try {
    const text = responseText.trim();
    // Handle markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    const jsonStr = jsonMatch[1] || text;
    rawLearnings = JSON.parse(jsonStr);
    if (!Array.isArray(rawLearnings)) {
      rawLearnings = [];
    }
  } catch (parseError) {
    logger.debug(`[Learning] Failed to parse response as JSON: ${responseText.slice(0, 200)}`);
    return [];
  }

  // Log raw learnings for debugging
  if (rawLearnings.length > 0) {
    logger.debug(`[Learning] Raw learnings: ${rawLearnings.map(l => `${l.title} (${l.source ?? 'auto'}, ${l.confidence})`).join(', ')}`);
  }

  const now = new Date().toISOString();
  const learnings: Learning[] = [];
  for (const l of rawLearnings) {
    if (!l?.title || !l?.instruction || !l?.category) continue;
    // The model can only claim "approval" provenance when a reviewer actually
    // commented; otherwise everything is execution-derived. Human-sourced
    // learnings are trusted at a fixed high confidence and bypass the auto
    // confidence floor; execution learnings keep the ≥0.8 filter.
    const source: LearningSource = hasReviews && l.source === 'approval' ? 'approval' : 'auto';
    if (source === 'auto' && !(l.confidence >= 0.8)) continue;
    learnings.push({
      category: l.category as LearningCategory,
      title: l.title,
      instruction: l.instruction,
      confidence: source === 'approval' ? 0.95 : l.confidence,
      id: Math.random().toString(36).slice(2, 10),
      appliedCount: 0,
      extractedAt: now,
      source,
    });
  }
  return learnings;
}
