import { generateText } from 'ai';
import { createModel } from '../../models.js';
import type { OutputValidation } from '../types.js';

export interface CompletionEvalResult {
  valid: boolean;
  details: string;
}

/**
 * Evaluate output with "contains" validation
 * Checks if output contains all required values
 */
function evaluateContains(
  output: string,
  values: string[]
): CompletionEvalResult {
  const lowerOutput = output.toLowerCase();
  const missing = values.filter(
    (v) => !lowerOutput.includes(v.toLowerCase())
  );

  if (missing.length === 0) {
    return {
      valid: true,
      details: `Output contains all ${values.length} required values`,
    };
  }

  return {
    valid: false,
    details: `Missing values: ${missing.join(', ')}`,
  };
}

/**
 * Evaluate output with regex pattern
 */
function evaluateRegex(
  output: string,
  pattern: string
): CompletionEvalResult {
  try {
    const regex = new RegExp(pattern, 'is'); // case-insensitive, dotall
    const match = regex.test(output);

    return {
      valid: match,
      details: match
        ? `Output matches pattern: ${pattern}`
        : `Output does not match pattern: ${pattern}`,
    };
  } catch (error) {
    return {
      valid: false,
      details: `Invalid regex pattern: ${pattern}`,
    };
  }
}

/**
 * Evaluate output using LLM as judge
 * Uses a fast model to evaluate against criteria
 */
async function evaluateLLMJudge(
  output: string,
  criteria: string,
  model?: string
): Promise<CompletionEvalResult> {
  // Default to a fast model; support provider:model format
  const judgeModelString = model ?? 'openai:gpt-5.2-mini';

  const userPrompt = `You are evaluating an AI agent's output against specific criteria.

## Agent Output:
${output}

## Evaluation Criteria:
${criteria}

## Instructions:
Evaluate whether the agent's output satisfies ALL the criteria listed above.
Respond with a JSON object containing:
- "pass": boolean (true if ALL criteria are met, false otherwise)
- "reasoning": string (brief explanation of your evaluation)

Respond ONLY with the JSON object, no other text.`;

  try {
    const judgeModel = await createModel(judgeModelString);

    // For Anthropic models, we need the Claude Code system prompt for OAuth credentials
    const isAnthropic = judgeModelString.includes('anthropic');

    const result = await generateText({
      model: judgeModel,
      ...(isAnthropic && {
        system: "You are Claude Code, Anthropic's official CLI for Claude.",
      }),
      prompt: userPrompt,
      temperature: 0,
      maxOutputTokens: 500,
    });

    // Parse the JSON response
    const jsonMatch = result.text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return {
        valid: false,
        details: 'LLM judge returned invalid response format',
      };
    }

    const evaluation = JSON.parse(jsonMatch[0]) as {
      pass: boolean;
      reasoning: string;
    };

    return {
      valid: evaluation.pass,
      details: evaluation.reasoning,
    };
  } catch (error) {
    return {
      valid: false,
      details: `LLM judge error: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

/**
 * Evaluate output against validation rules
 */
export async function evaluateCompletion(
  output: string,
  validation: OutputValidation
): Promise<CompletionEvalResult> {
  switch (validation.type) {
    case 'contains':
      return evaluateContains(output, validation.values);

    case 'regex':
      return evaluateRegex(output, validation.pattern);

    case 'llm-judge':
      return evaluateLLMJudge(output, validation.criteria, validation.model);

    default:
      return {
        valid: false,
        details: `Unknown validation type: ${(validation as { type: string }).type}`,
      };
  }
}
