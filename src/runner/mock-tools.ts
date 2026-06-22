import type { Tool } from 'ai';
import type { ParsedAgent } from '../parser';
import { completeText } from '../complete-text';
import { logger } from '../utils/logger';

/**
 * LLM-mocked tool execution for testing agents without external side effects.
 *
 * When mock mode is active, every tool's `execute` is replaced with a call to
 * an LLM that fabricates a realistic result from the tool's name, description,
 * and the actual call arguments. The agent runs for real (real model, real
 * reasoning, real sub-agent orchestration); only tool *execution* is faked, so
 * no bash/filesystem/MCP/store side effects ever run.
 *
 * Wired in at the single tool-merge chokepoint in {@link ./tools-loader.ts},
 * which is hit by both the main agent and every sub-agent, so coverage is
 * automatic at every nesting level.
 */

function envFlag(value: string | undefined): boolean {
  return value === '1' || value === 'true';
}

/** Whether `--mock` / `AGENTUSE_MOCK_MODE` is active. */
export function isMockMode(): boolean {
  return envFlag(process.env.AGENTUSE_MOCK_MODE);
}

/** Model used to generate mock outputs: `AGENTUSE_MOCK_MODEL` override, else the agent's model. */
export function resolveMockModel(agentModel: string): string {
  return process.env.AGENTUSE_MOCK_MODEL || agentModel;
}

/**
 * Tool names skipped by LLM mocking. The approval/human gate (`await_human`)
 * stays real by default so a test can verify the agent actually suspends for
 * approval before a risky step — the tools it guards are already harmless under
 * mock mode, so only its behavior matters. `--mock-approval` /
 * `AGENTUSE_MOCK_APPROVAL` opts into mocking it too for fully-unattended runs.
 */
export function mockExclusions(): Set<string> {
  return envFlag(process.env.AGENTUSE_MOCK_APPROVAL)
    ? new Set<string>()
    : new Set<string>(['await_human']);
}

const MOCK_SYSTEM_PROMPT = [
  'You are a tool-call simulator for an agent test harness.',
  "Given a tool's name, description, and the arguments it was called with, return a single realistic result that this tool would plausibly return on success.",
  'Return ONLY the raw result value: valid JSON if the tool would return structured data, otherwise plain text.',
  'Do NOT wrap it in markdown code fences, and do NOT add any explanation, preamble, or commentary.',
  'Keep it concise but realistic and consistent with the given arguments.',
].join(' ');

function buildMockPrompt(toolName: string, description: string, input: unknown): string {
  const lines = [`Tool name: ${toolName}`];
  if (description) lines.push(`Tool description: ${description}`);
  let argsJson: string;
  try {
    argsJson = JSON.stringify(input ?? {}, null, 2);
  } catch {
    argsJson = String(input);
  }
  lines.push('Arguments (JSON):', argsJson, '', "Produce the tool's result now.");
  return lines.join('\n');
}

function stripCodeFence(text: string): string {
  const t = text.trim();
  const fenced = t.match(/^```(?:[a-zA-Z0-9_-]+)?\n([\s\S]*?)\n```$/);
  return fenced ? fenced[1].trim() : t;
}

/** Return parsed JSON when the model produced structured data, otherwise the raw text. */
function parseMockResult(text: string): unknown {
  const cleaned = stripCodeFence(text);
  if (!cleaned) return '';
  try {
    return JSON.parse(cleaned);
  } catch {
    return cleaned;
  }
}

/**
 * Replace every tool's `execute` with an LLM-backed mock. Returns a new tool map
 * (no mutation, mirroring `limitModelFacingToolOutputs`). Tools without an
 * `execute`, and any tool whose name is in `exclude`, are passed through
 * unchanged.
 */
export function wrapToolsWithLLMMock(
  tools: Record<string, Tool>,
  agent: ParsedAgent,
  opts?: { exclude?: Set<string> },
): Record<string, Tool> {
  const exclude = opts?.exclude ?? mockExclusions();
  const mockModel = resolveMockModel(agent.config.model);

  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const originalExecute = (tool as any).execute;
      if (typeof originalExecute !== 'function' || exclude.has(name)) {
        return [name, tool];
      }

      const description = typeof (tool as any).description === 'string' ? (tool as any).description : '';

      return [
        name,
        {
          ...tool,
          execute: async (...args: unknown[]) => {
            const input = args[0];
            const execOptions = args[1] as { abortSignal?: AbortSignal } | undefined;
            const text = await completeText(mockModel, {
              system: MOCK_SYSTEM_PROMPT,
              prompt: buildMockPrompt(name, description, input),
              ...(execOptions?.abortSignal && { abortSignal: execOptions.abortSignal }),
            });
            logger.debug(`[Mock] ${name} -> LLM-generated result`);
            return parseMockResult(text);
          },
        },
      ];
    }),
  ) as Record<string, Tool>;
}
