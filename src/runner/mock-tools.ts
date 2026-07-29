import type { Tool } from 'ai';
import { completeText } from '../complete-text';
import { isEffectful } from './approval-lease';
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

/** Whether `--mock` / `--mock-gated` / `AGENTUSE_MOCK_MODE` is active. */
export function isMockMode(): boolean {
  return envFlag(process.env.AGENTUSE_MOCK_MODE);
}

/**
 * What mock mode covers. `all` (default, `--mock`) mocks every tool's execute.
 * `gated` (`--mock-gated`, env `AGENTUSE_MOCK_SCOPE=gated`) mocks ONLY bash
 * commands matching the agent's human-authored `tools.bash.gated` patterns
 * (the effectful/irreversible subset the author already fenced off), plus the
 * approval gate; every other tool runs for real, so the run grounds itself in
 * real project state instead of inventing it.
 */
export function mockScope(): 'all' | 'gated' {
  return process.env.AGENTUSE_MOCK_SCOPE === 'gated' ? 'gated' : 'all';
}

/**
 * Model used to generate mock outputs, from the required `--mock-model` /
 * `AGENTUSE_MOCK_MODEL`. The CLI validates this up front; this runtime guard
 * covers any env-only path (e.g. a subprocess that set `AGENTUSE_MOCK_MODE`
 * directly). We deliberately do NOT fall back to the agent's own model: that
 * ran mock onto the agent's premium, rate-limited token and produced the opaque
 * 429s this mode is meant to avoid. The user must name a model they can reach.
 */
export function resolveMockModel(): string {
  const model = process.env.AGENTUSE_MOCK_MODEL;
  if (!model) {
    throw new Error(
      'Mock mode is active but no mock model is set. Pass --mock-model <model> (or set AGENTUSE_MOCK_MODEL). ' +
        'Mock generates every tool result via this model, so use the lowest-end model you can reach ' +
        '(e.g. anthropic:claude-haiku-4-5 or openai:gpt-5.4-nano).',
    );
  }
  return model;
}

/** A deterministic reviewer decision for mocked approval gates. */
export type MockApprovalDecision =
  | { kind: 'approve' }
  | { kind: 'reject' }
  | { kind: 'comment'; comment: string };

/**
 * Parse `--mock-approval` / `AGENTUSE_MOCK_APPROVAL` into a deterministic gate
 * decision, or undefined when unset. Deliberately NOT an LLM: unattended runs
 * need the same branch every time (an improvised approval that occasionally
 * fabricates a rejection flakes the whole run), and judging the QUALITY of a
 * gate request belongs to the outer loop (session log review, the verify
 * judge), not to the mock. `1`/`true` are the legacy boolean spelling and mean
 * approve.
 */
export function resolveMockApprovalDecision(): MockApprovalDecision | undefined {
  const raw = (process.env.AGENTUSE_MOCK_APPROVAL ?? '').trim();
  if (!raw) return undefined;
  const lower = raw.toLowerCase();
  if (['1', 'true', 'approve', 'approved'].includes(lower)) return { kind: 'approve' };
  if (lower === 'reject' || lower === 'rejected') return { kind: 'reject' };
  if (lower === 'comment' || lower.startsWith('comment:')) {
    const text = raw.slice(raw.indexOf(':') + 1).trim();
    return {
      kind: 'comment',
      comment: lower === 'comment' || !text ? 'Mock reviewer comment: revise and re-gate.' : text,
    };
  }
  throw new Error(
    `Invalid --mock-approval value "${raw}". Use approve (default), reject, or comment:<text>.`,
  );
}

/**
 * The decision payload a mocked `await_human` returns, shaped exactly like a
 * real reviewer decision (`{status, comment?, choice?}`) so the model branches
 * the same way it would in production. Approve on a pick gate carries `choice`
 * (the recommended option, else the first): serve enforces approve⇒choice on
 * gates with options, so the mock must too.
 */
export function mockGateDecisionResult(input: unknown): {
  status: 'approved' | 'rejected' | 'commented';
  comment?: string;
  choice?: string;
} {
  const decision = resolveMockApprovalDecision();
  if (!decision) {
    throw new Error('mockGateDecisionResult requires AGENTUSE_MOCK_APPROVAL to be set');
  }
  if (decision.kind === 'reject') return { status: 'rejected' };
  if (decision.kind === 'comment') return { status: 'commented', comment: decision.comment };
  const options = input && typeof input === 'object'
    ? (input as { options?: Array<{ id?: unknown; recommended?: unknown }> }).options
    : undefined;
  const picked = Array.isArray(options)
    ? (options.find((o) => o && typeof o === 'object' && o.recommended === true) ?? options[0])
    : undefined;
  const choice = picked && typeof picked.id === 'string' ? picked.id : undefined;
  return { status: 'approved', ...(choice ? { choice } : {}) };
}

/**
 * Swap a (re)built `await_human` tool for its deterministic mocked-decision
 * counterpart when mocked approval is active; identity otherwise. Needed
 * anywhere the gate is constructed AFTER the tool-merge mock chokepoint (the
 * sub-agent path rebuilds it to bind the child session id), which would
 * otherwise silently restore the real suspending gate under `--mock-approval`.
 * The decision's durable side effects (lease grant, gate seal) are applied by
 * the execution loop's toolApproval barrier, which owns the stores; this
 * wrapper only returns the payload the model sees.
 */
export function maybeMockAwaitHuman(tool: Tool): Tool {
  if (!isMockMode() || !resolveMockApprovalDecision()) return tool;
  return withMockedGateExecute(tool);
}

/** Unconditionally swap the gate's execute for the deterministic decision. */
function withMockedGateExecute(tool: Tool): Tool {
  return {
    ...tool,
    execute: async (input: unknown) => {
      const result = mockGateDecisionResult(input);
      logger.debug(`[Mock] await_human -> deterministic ${result.status} (--mock-approval)`);
      return result;
    },
  };
}

/**
 * Tool names skipped by LLM mocking. The approval/human gate (`await_human`)
 * stays real by default so a test can verify the agent actually suspends for
 * approval before a risky step — the tools it guards are already harmless under
 * mock mode, so only its behavior matters. `--mock-approval` /
 * `AGENTUSE_MOCK_APPROVAL` opts into resolving it deterministically instead
 * (see {@link resolveMockApprovalDecision}) for fully-unattended runs.
 */
export function mockExclusions(): Set<string> {
  const exclusions = resolveMockApprovalDecision()
    ? new Set<string>()
    : new Set<string>(['await_human']);
  // AGENTUSE_MOCK_EXCLUDE: comma-separated tool names whose real execute is kept
  // under --mock. Meant for side-effect-free tools (e.g. tools__filesystem_read)
  // so mock runs ground themselves in real project data instead of inventing it.
  for (const name of (process.env.AGENTUSE_MOCK_EXCLUDE ?? '').split(',')) {
    const trimmed = name.trim();
    if (trimmed) exclusions.add(trimmed);
  }
  return exclusions;
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

/** Build the LLM-backed mock execute for one tool. */
function llmMockExecute(name: string, tool: Tool, mockModel: string) {
  const description = typeof (tool as any).description === 'string' ? (tool as any).description : '';
  return async (...args: unknown[]) => {
    const input = args[0];
    const execOptions = args[1] as { abortSignal?: AbortSignal } | undefined;
    const text = await completeText(mockModel, {
      instructions: MOCK_SYSTEM_PROMPT,
      prompt: buildMockPrompt(name, description, input),
      ...(execOptions?.abortSignal && { abortSignal: execOptions.abortSignal }),
    });
    logger.debug(`[Mock] ${name} -> LLM-generated result`);
    return parseMockResult(text);
  };
}

/**
 * Replace every tool's `execute` with an LLM-backed mock. Returns a new tool map
 * (no mutation, mirroring `limitModelFacingToolOutputs`). Tools without an
 * `execute`, and any tool whose name is in `exclude`, are passed through
 * unchanged.
 */
export function wrapToolsWithLLMMock(
  tools: Record<string, Tool>,
  opts?: { exclude?: Set<string> },
): Record<string, Tool> {
  const exclude = opts?.exclude ?? mockExclusions();
  const mockModel = resolveMockModel();

  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const originalExecute = (tool as any).execute;
      if (typeof originalExecute !== 'function' || exclude.has(name)) {
        return [name, tool];
      }

      // Not excluded means a decision is configured: resolve the gate
      // deterministically instead of letting the LLM improvise a reviewer.
      if (name === 'await_human') {
        return [name, withMockedGateExecute(tool)];
      }

      return [name, { ...tool, execute: llmMockExecute(name, tool, mockModel) }];
    }),
  ) as Record<string, Tool>;
}

/**
 * Gated-scope mock (`--mock-gated`): mock ONLY bash commands matching the
 * agent's `tools.bash.gated` patterns; every other tool, including non-gated
 * bash, keeps its real execute. The approval gate resolves deterministically
 * (the CLI defaults the decision to approve for this scope), so gated flows
 * complete unattended while the rest of the run works against real state.
 *
 * Fidelity note: the toolApproval barrier still governs dispatch. A gated
 * command issued WITHOUT an approved gate is denied pre-dispatch with the
 * re-gate redirect, exactly as in production. This wrapper only decides what
 * happens after a covered command is allowed through: fabricate its result
 * instead of executing it.
 */
export function wrapToolsWithGatedMock(
  tools: Record<string, Tool>,
  gatedPatterns: string[],
): Record<string, Tool> {
  const mockModel = resolveMockModel();

  return Object.fromEntries(
    Object.entries(tools).map(([name, tool]) => {
      const originalExecute = (tool as any).execute;
      if (typeof originalExecute !== 'function') return [name, tool];

      if (name === 'await_human' && resolveMockApprovalDecision()) {
        return [name, withMockedGateExecute(tool)];
      }

      if (name === 'tools__bash' && gatedPatterns.length > 0) {
        const mocked = llmMockExecute(name, tool, mockModel);
        return [
          name,
          {
            ...tool,
            execute: async (...args: unknown[]) => {
              const input = args[0] as { command?: unknown } | undefined;
              const command = typeof input?.command === 'string' ? input.command : '';
              if (command && isEffectful(command, gatedPatterns)) {
                logger.debug(`[Mock] gated bash command mocked (not executed): ${command}`);
                return mocked(...args);
              }
              return (originalExecute as (...a: unknown[]) => unknown)(...args);
            },
          },
        ];
      }

      return [name, tool];
    }),
  ) as Record<string, Tool>;
}
