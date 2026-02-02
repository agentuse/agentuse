import { generateText } from 'ai';
import { createModel } from '../models';
import type { AgentCompleteEvent, ToolCallTrace } from '../plugin/types';
import type { Learning, LearningCategory } from './types';
import { logger } from '../utils/logger';
import { ANTHROPIC_IDENTITY_PROMPT, isAnthropicModel } from '../utils/anthropic';

/**
 * Format tool calls with inputs for evaluation
 * Truncate large inputs to avoid context bloat
 */
function formatToolCalls(traces: ToolCallTrace[] | undefined): string {
  if (!traces || traces.length === 0) return 'No tool calls';

  return traces.map(t => {
    const status = t.success ? '✓' : '✗';
    const inputStr = t.input
      ? `\n    Input: ${JSON.stringify(t.input).slice(0, 500)}${JSON.stringify(t.input).length > 500 ? '...' : ''}`
      : '';
    return `- [${status}] ${t.name} (${t.duration}ms)${inputStr}`;
  }).join('\n');
}

interface RawLearning {
  category: 'tip' | 'warning' | 'pattern' | 'tool-usage' | 'error-fix';
  title: string;
  instruction: string;
  confidence: number;
}

/**
 * Evaluate an agent execution and extract high-confidence learnings
 */
export async function evaluateExecution(
  event: AgentCompleteEvent,
  agentInstructions: string,
  agentModel: string,
  evaluateCriteria: true | string,
  existingLearnings: Learning[] = [],
): Promise<Learning[]> {
  const model = await createModel(agentModel);

  const customCriteria = typeof evaluateCriteria === 'string'
    ? `\n\nAdditional evaluation criteria:\n${evaluateCriteria}`
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

  const prompt = `You are evaluating an agent execution to extract learnings for future improvement.

## Agent Instructions
${truncatedInstructions}

## Execution Results
- Duration: ${event.result.duration.toFixed(2)}s
- Tool Calls: ${event.result.toolCalls}
- Finish Reason: ${event.result.finishReason || 'unknown'}

## Tool Calls (with inputs)
${formatToolCalls(event.result.toolCallTraces)}

## Console Output (includes tool outputs)
${consoleOutput || '(No console output)'}

## Agent Text Output
${event.result.text || '(No text output)'}
${customCriteria}
${existingLearnings.length > 0 ? `
## Existing Learnings (DO NOT DUPLICATE)
The following learnings already exist. Do NOT extract learnings that cover the same concepts:
${existingLearnings.map(l => `- [${l.category}] ${l.title}: ${l.instruction.slice(0, 150)}${l.instruction.length > 150 ? '...' : ''}`).join('\n')}
` : ''}

## Task
Extract actionable learnings that could improve future runs.
- Extract 0-3 learnings MAXIMUM. Prefer fewer, higher-quality learnings.
- If no valuable learnings exist, return an empty array []
- Only include learnings you're confident about (confidence ≥ 0.8)
- Each learning should be a clear, specific instruction
- Focus on what would actually help the agent do better
- Avoid generic or obvious learnings that wouldn't add value

Categories:
- tip: Positive guidance ("Do X for better results")
- warning: Things to avoid ("Don't do Y because...")
- pattern: Reusable approach ("When X happens, do Y")
- tool-usage: Tool-specific guidance
- error-fix: Error recovery patterns

Respond with ONLY a JSON array of learnings. No other text.
Example format:
[
  {"category": "tip", "title": "Short title", "instruction": "Detailed instruction", "confidence": 0.9}
]

If no learnings are applicable, respond with an empty array: []`;

  // Build messages with Claude Code system prompt for OAuth compatibility
  const messages: Array<{ role: 'system' | 'user'; content: string }> = [];

  // Add Claude Code identity prompt for Anthropic models (required for OAuth)
  if (isAnthropicModel(agentModel)) {
    messages.push({
      role: 'system',
      content: ANTHROPIC_IDENTITY_PROMPT
    });
  }

  messages.push({ role: 'user', content: prompt });

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const result = await generateText({
    model: model as any,
    messages,
    temperature: 0.2,
  });

  // Parse JSON from response
  let rawLearnings: RawLearning[] = [];
  try {
    const text = result.text.trim();
    // Handle markdown code blocks
    const jsonMatch = text.match(/```(?:json)?\s*([\s\S]*?)\s*```/) || [null, text];
    const jsonStr = jsonMatch[1] || text;
    rawLearnings = JSON.parse(jsonStr);
    if (!Array.isArray(rawLearnings)) {
      rawLearnings = [];
    }
  } catch (parseError) {
    logger.debug(`[Learning] Failed to parse response as JSON: ${result.text.slice(0, 200)}`);
    return [];
  }

  // Log raw learnings for debugging
  if (rawLearnings.length > 0) {
    logger.debug(`[Learning] Raw learnings: ${rawLearnings.map(l => `${l.title} (${l.confidence})`).join(', ')}`);
  }

  // Filter to high-confidence only
  const highConfidence = rawLearnings.filter(l => l.confidence >= 0.8);

  // Add metadata
  const now = new Date().toISOString();
  return highConfidence.map(l => ({
    ...l,
    category: l.category as LearningCategory,
    id: Math.random().toString(36).slice(2, 10),
    appliedCount: 0,
    extractedAt: now,
  }));
}
