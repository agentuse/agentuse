/**
 * Verify judge — evaluates a run's final output before it ships.
 * @experimental This feature is experimental and may change in future versions.
 *
 * Two evaluators:
 * - built-in: one `completeText` call scoring the output against criteria
 *   (defaults to the verifying agent's own model, so auth always works)
 * - judge agent: another .agentuse file run as an ephemeral evaluator with its
 *   own model/tools; its final text must end with a JSON verdict
 */

import { dirname, resolve } from 'path';
import { completeText } from '../complete-text.js';
import { ANTHROPIC_IDENTITY_PROMPT, isAnthropicModel } from '../utils/anthropic.js';
import { parseAgent } from '../parser.js';
import { connectMCP, type MCPServersConfig } from '../mcp.js';
import { executeAgentCore } from '../runner/execution.js';
import { processAgentStream } from '../runner/stream.js';
import { loadAgentTools } from '../runner/tools-loader.js';
import { buildSystemMessages } from '../runner/system-messages.js';
import { DoomLoopDetector } from '../tools/index.js';
import { resolveMaxSteps } from '../utils/config.js';
import { logger } from '../utils/logger.js';
import type { CanonicalVerifyConfig, VerifyVerdict } from './types.js';

/** Outcome of a judge invocation. `error` never blocks the output — the runner
 * ships it and surfaces the failure as a session marker instead. */
export type JudgeOutcome =
  | { status: 'verdict'; verdict: VerifyVerdict }
  | { status: 'error'; detail: string };

export interface JudgeInput {
  /** The task the agent was asked to do (instructions + user prompt). */
  task: string;
  /** The final output under evaluation. */
  output: string;
  /** 0-based verification attempt (0 = first output, N = after Nth redo). */
  attempt: number;
}

const GENERIC_CRITERIA =
  'The output fully accomplishes the task it was given, is complete and coherent, and contains no unsupported claims or placeholder content.';

// Input-side truncation guards: the judge needs enough to evaluate, not the
// whole context window. Head+tail keeps intro and conclusion visible.
const MAX_TASK_CHARS = 8_000;
const MAX_OUTPUT_CHARS = 32_000;

function truncateMiddle(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const half = Math.floor(maxChars / 2);
  return `${text.slice(0, half)}\n\n[... truncated ${text.length - maxChars} chars ...]\n\n${text.slice(-half)}`;
}

const VERDICT_FORMAT_INSTRUCTIONS = `## Verdict format (required)
Keep any reasoning before the verdict brief (under 150 words) — the verdict object must not be cut off.
End your response with a single JSON object on its own line:
{"pass": true, "critique": ""}
or
{"pass": false, "critique": "<what fails and what a passing output looks like>"}
When pass is false, the critique is required and must be concrete enough to act on in ONE revision: name what is wrong AND what passing looks like. Do not include any text after the JSON object.`;

function buildJudgePrompt(input: JudgeInput, criteria: string): string {
  return `You are verifying an AI agent's final output before it is delivered.

## Task the agent was given
${truncateMiddle(input.task, MAX_TASK_CHARS)}

## Agent's final output (attempt ${input.attempt + 1})
${input.output.trim() ? truncateMiddle(input.output, MAX_OUTPUT_CHARS) : '(the agent produced no final text output)'}

## Verification criteria
${criteria}

## Instructions
Judge whether the output satisfies ALL the criteria in the context of the task. Be strict but fair: pass output a demanding reviewer would accept, reject output they would send back.

${VERDICT_FORMAT_INSTRUCTIONS}`;
}

/**
 * Extract the JSON verdict from judge response text. Prefers the last
 * parseable object carrying a boolean `pass` (the judge is instructed to end
 * with it), falling back to a greedy whole-match for single-object replies.
 */
export function extractVerdict(text: string): VerifyVerdict | null {
  const candidates: string[] = [];
  const flat = text.match(/\{[^{}]*"pass"[^{}]*\}/g);
  if (flat) candidates.push(...flat.reverse());
  const greedy = text.match(/\{[\s\S]*\}/);
  if (greedy) candidates.push(greedy[0]);

  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as { pass?: unknown; critique?: unknown };
      if (typeof parsed.pass === 'boolean') {
        const critique = typeof parsed.critique === 'string' && parsed.critique.trim()
          ? parsed.critique.trim()
          : undefined;
        return { pass: parsed.pass, ...(critique && { critique }) };
      }
    } catch {
      // try the next candidate
    }
  }
  return null;
}

/** Built-in judge: one completeText call against the criteria. */
async function judgeBuiltin(
  input: JudgeInput,
  config: CanonicalVerifyConfig,
  agentModel: string
): Promise<JudgeOutcome> {
  const judgeModel = config.model ?? agentModel;
  const prompt = buildJudgePrompt(input, config.criteria ?? GENERIC_CRITERIA);

  // For Anthropic OAuth the Claude Code identity prompt must be the system
  // prompt; completeText streams so the ChatGPT Codex backend works too.
  const instructions = isAnthropicModel(judgeModel)
    ? ANTHROPIC_IDENTITY_PROMPT
    : 'You are a strict evaluator that judges agent output against criteria and ends your reply with a JSON verdict object.';

  const responseText = await completeText(judgeModel, {
    instructions,
    prompt,
    // Room for rubric-by-rubric reasoning before the trailing verdict object;
    // a too-small cap truncates the response before the JSON ever appears.
    maxOutputTokens: 2500,
  });

  const verdict = extractVerdict(responseText);
  if (!verdict) {
    return { status: 'error', detail: 'judge returned no parseable verdict JSON' };
  }
  if (!verdict.pass && !verdict.critique) {
    return { status: 'error', detail: 'judge failed the output without a critique' };
  }
  return { status: 'verdict', verdict };
}

/**
 * Judge agent: run another .agentuse file as an ephemeral evaluator. The judge
 * gets its own model/tools per its frontmatter; it runs without a session of
 * its own (its critique is persisted on the parent as the verify marker).
 * Approval gates cannot suspend here — a suspended judge is a judge error.
 */
async function judgeViaAgent(
  input: JudgeInput,
  judgePath: string,
  agentFilePath: string | undefined,
  projectContext: { projectRoot: string; stateRoot: string; cwd: string } | undefined,
  abortSignal: AbortSignal | undefined
): Promise<JudgeOutcome> {
  const resolvedPath = agentFilePath ? resolve(dirname(agentFilePath), judgePath) : resolve(judgePath);
  const judgeAgent = await parseAgent(resolvedPath);
  if (judgeAgent.config.verify) {
    logger.debug(`[Verify] Ignoring nested verify config on judge agent ${judgeAgent.name}`);
    delete judgeAgent.config.verify;
  }

  const judgeDir = dirname(resolvedPath);
  const mcpConnections = judgeAgent.config.mcpServers
    ? await connectMCP(judgeAgent.config.mcpServers as MCPServersConfig, false, judgeDir)
    : [];

  const loadedTools = await loadAgentTools({
    agent: judgeAgent,
    projectContext,
    agentDir: judgeDir,
    agentFilePath: resolvedPath,
    mcpConnections,
    logPrefix: '[Verify] ',
  });

  try {
    const systemMessagesResult = await buildSystemMessages({
      agent: judgeAgent,
      isSubAgent: true,
      agentFilePath: resolvedPath,
      projectRoot: projectContext?.projectRoot,
      stateRoot: projectContext?.stateRoot,
    });

    const judgeTask = `${buildJudgePrompt(input, 'Apply the evaluation standard defined in your own instructions.')}`;
    const userMessage = `${judgeAgent.instructions}\n\n${judgeTask}`;

    const result = await processAgentStream(
      executeAgentCore(judgeAgent, loadedTools.all, {
        userMessage,
        cacheableUserMessage: judgeAgent.instructions,
        systemMessages: systemMessagesResult.messages,
        maxSteps: resolveMaxSteps(undefined, judgeAgent.config.maxSteps),
        subAgentNames: new Set<string>(),
        ...(abortSignal && { abortSignal }),
      }),
      { collectToolCalls: true, logPrefix: '[Verify] ', doomLoopDetector: new DoomLoopDetector({ threshold: 3, action: 'error' }), quiet: true }
    );

    if (result.suspended) {
      return { status: 'error', detail: `judge agent ${judgeAgent.name} suspended on an approval gate; judges cannot suspend` };
    }

    const verdict = extractVerdict(result.text ?? '');
    if (!verdict) {
      return { status: 'error', detail: `judge agent ${judgeAgent.name} returned no parseable verdict JSON` };
    }
    if (!verdict.pass && !verdict.critique) {
      return { status: 'error', detail: `judge agent ${judgeAgent.name} failed the output without a critique` };
    }
    return { status: 'verdict', verdict };
  } finally {
    if (loadedTools.store) {
      await loadedTools.store.releaseLock();
    }
    for (const conn of mcpConnections) {
      try {
        await conn.client.close();
        if (conn.rawClient) await conn.rawClient.close();
      } catch {
        // best-effort close
      }
    }
  }
}

/** Run the configured judge over a final output. Never throws: any failure
 * comes back as `{ status: 'error' }` so verification degrades to shipping the
 * output with a visible marker rather than blocking the run. */
export async function judgeOutput(params: {
  input: JudgeInput;
  config: CanonicalVerifyConfig;
  agentModel: string;
  agentFilePath?: string | undefined;
  projectContext?: { projectRoot: string; stateRoot: string; cwd: string } | undefined;
  abortSignal?: AbortSignal | undefined;
}): Promise<JudgeOutcome> {
  const { input, config, agentModel, agentFilePath, projectContext, abortSignal } = params;
  try {
    if (config.judge) {
      return await judgeViaAgent(input, config.judge, agentFilePath, projectContext, abortSignal);
    }
    return await judgeBuiltin(input, config, agentModel);
  } catch (error) {
    return { status: 'error', detail: (error as Error).message };
  }
}
