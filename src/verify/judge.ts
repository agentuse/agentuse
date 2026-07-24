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
import { tool } from 'ai';
import { z } from 'zod';
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
import { logger, runWithLogSink } from '../utils/logger.js';
import { SessionManager } from '../session/manager.js';
import { createSessionAndMessage, createSessionLogSink, type SessionLogSink } from '../runner/session-helper.js';
import { computeAgentId } from '../utils/agent-id.js';
import { usageToAssistantTokens } from '../session/usage.js';
import type { CanonicalVerifyConfig, VerifyVerdict } from './types.js';

/** Parent-session handles so a judge agent can run as an inspectable child
 * session (appears under the parent's childSessions) instead of a discarded
 * ephemeral run. Optional everywhere: absent → the judge runs sessionless as
 * before, so verification never depends on session plumbing being present. */
export interface JudgeParentSession {
  sessionManager: SessionManager;
  sessionID: string;
  agentId: string;
}

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

// Built-in judge (single completeText call, no tools): the verdict is trailing
// JSON scraped by extractVerdict. generateObject/generateText can't replace this
// - the Codex OAuth backend rejects non-streaming calls (see complete-text.ts).
const VERDICT_FORMAT_INSTRUCTIONS = `## Verdict format (required)
Keep any reasoning before the verdict brief (under 150 words) — the verdict object must not be cut off.
End your response with a single JSON object on its own line:
{"pass": true, "critique": "<one line: the sharpest objection you tested and why it held, so a reader sees what was actually checked>"}
or
{"pass": false, "critique": "<what fails and what a passing output looks like>"}
The critique is required in BOTH cases (it is the record of what the judge did, shown on the pass/fail marker). On a pass, give the single thing that made it clear the bar (the strongest risk you checked and why it's fine), not empty praise. On a fail, it must be concrete enough to act on in ONE revision: name what is wrong AND what passing looks like. Do not include any text after the JSON object.`;

// Agent judge (runs a tool-capable loop): the verdict is a structured
// submit_verdict tool call, not scraped from prose. Reasoning stays as text
// (persisted in the judge's own session); the verdict can't be truncated or
// mis-parsed because it's validated tool args in their own message.
const SUBMIT_VERDICT_INSTRUCTIONS = `## Verdict (required)
Reason briefly first (name which criteria or attacks the output survived or failed), then record your decision by calling the \`submit_verdict\` tool exactly once. That tool call IS your verdict — do not also write a JSON object in your text.
- \`pass\`: true if a demanding reviewer would accept the output as-is; false if they would send it back.
- \`critique\`: one line, required either way. On a pass, the single sharpest risk you checked and why it's fine (not empty praise). On a fail, what is wrong AND what a passing output looks like, concrete enough to act on in one revision.`;

function buildJudgePrompt(input: JudgeInput, criteria: string, outputInstructions: string): string {
  return `You are verifying an AI agent's final output before it is delivered.

## Task the agent was given
${truncateMiddle(input.task, MAX_TASK_CHARS)}

## Agent's final output (attempt ${input.attempt + 1})
${input.output.trim() ? truncateMiddle(input.output, MAX_OUTPUT_CHARS) : '(the agent produced no final text output)'}

## Verification criteria
${criteria}

## Instructions
Judge whether the output satisfies ALL the criteria in the context of the task. Be strict but fair: pass output a demanding reviewer would accept, reject output they would send back.

${outputInstructions}`;
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
  agentModel: string,
  abortSignal: AbortSignal | undefined
): Promise<JudgeOutcome> {
  const judgeModel = config.model ?? agentModel;
  const prompt = buildJudgePrompt(input, config.criteria ?? GENERIC_CRITERIA, VERDICT_FORMAT_INSTRUCTIONS);

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
    ...(abortSignal && { abortSignal }),
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
  abortSignal: AbortSignal | undefined,
  parentSession: JudgeParentSession | undefined
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

    const judgeTask = `${buildJudgePrompt(input, 'Apply the evaluation standard defined in your own instructions.', SUBMIT_VERDICT_INSTRUCTIONS)}`;
    const userMessage = `${judgeAgent.instructions}\n\n${judgeTask}`;

    // The verdict is a structured tool call, not scraped prose: the judge
    // reasons in text (persisted in its session) then calls submit_verdict.
    // Captured here via closure so we get the schema-validated args directly.
    let submittedVerdict: VerifyVerdict | undefined;
    const submitVerdictTool = tool({
      description: 'Record your final verdict and end the review. Call this exactly once, after your reasoning. This tool call IS your verdict — do not also write a JSON object in your text.',
      inputSchema: z.object({
        pass: z.boolean().describe('true if a demanding reviewer would accept the output as-is; false if they would send it back'),
        critique: z.string().describe('One line, required either way. On a pass: the single sharpest risk you checked and why it held (not empty praise). On a fail: what is wrong AND what a passing output looks like, concrete enough to act on in one revision.'),
      }),
      execute: async ({ pass, critique }: { pass: boolean; critique: string }) => {
        const trimmed = typeof critique === 'string' && critique.trim() ? critique.trim() : undefined;
        submittedVerdict = { pass, ...(trimmed && { critique: trimmed }) };
        return { recorded: true, pass };
      },
    });
    const judgeTools = { ...loadedTools.all, submit_verdict: submitVerdictTool };

    // Run the judge as an inspectable child session under the parent, so its
    // full reasoning + tool calls (which exemplar/voice files it actually read)
    // are viewable via childSessions - not just the one-line verdict marker.
    // Best-effort: any session-setup failure falls back to a sessionless run so
    // verification never breaks on session plumbing.
    let judgeSessionManager: SessionManager | undefined;
    let judgeSessionID: string | undefined;
    let judgeAgentId: string | undefined;
    let judgeMsgID: string | undefined;
    let logSink: SessionLogSink | undefined;
    if (parentSession && projectContext) {
      try {
        judgeSessionManager = new SessionManager();
        const parentFullPath = parentSession.sessionManager.getFullPath();
        if (parentFullPath) judgeSessionManager.setParentPath(parentFullPath);
        judgeAgentId = computeAgentId(resolvedPath, projectContext.stateRoot, judgeAgent.name);
        const created = await createSessionAndMessage({
          sessionManager: judgeSessionManager,
          agent: judgeAgent,
          agentFilePath: resolvedPath,
          systemMessages: systemMessagesResult.messages.map(m => m.content),
          task: judgeAgent.instructions,
          userPrompt: judgeTask,
          projectContext,
          version: process.env.npm_package_version || 'unknown',
          config: {
            ...(judgeAgent.config.timeout !== undefined && { timeout: judgeAgent.config.timeout }),
            maxSteps: resolveMaxSteps(undefined, judgeAgent.config.maxSteps),
          },
          isSubAgent: true,
          parentSessionID: parentSession.sessionID,
        });
        judgeSessionID = created.sessionID;
        judgeMsgID = created.messageID;
        logSink = createSessionLogSink(judgeSessionManager, judgeSessionID, judgeAgentId, judgeMsgID);
      } catch (error) {
        logger.debug(`[Verify] Judge session setup failed; running sessionless: ${(error as Error).message}`);
        judgeSessionManager = undefined; judgeSessionID = undefined; judgeAgentId = undefined; judgeMsgID = undefined; logSink = undefined;
      }
    }

    const runJudge = () => processAgentStream(
      executeAgentCore(judgeAgent, judgeTools, {
        userMessage,
        cacheableUserMessage: judgeAgent.instructions,
        systemMessages: systemMessagesResult.messages,
        maxSteps: resolveMaxSteps(undefined, judgeAgent.config.maxSteps),
        subAgentNames: new Set<string>(),
        ...(abortSignal && { abortSignal }),
        ...(judgeSessionManager && { sessionManager: judgeSessionManager }),
        ...(judgeSessionID && { sessionID: judgeSessionID }),
        ...(judgeAgentId && { agentId: judgeAgentId }),
        ...(judgeMsgID && { messageID: judgeMsgID }),
      }),
      {
        collectToolCalls: true, logPrefix: '[Verify] ',
        doomLoopDetector: new DoomLoopDetector({ threshold: 3, action: 'error' }), quiet: true,
        ...(judgeSessionManager && { sessionManager: judgeSessionManager }),
        ...(judgeSessionID && { sessionID: judgeSessionID }),
        ...(judgeAgentId && { agentId: judgeAgentId }),
        ...(judgeMsgID && { messageID: judgeMsgID }),
      }
    );

    let result: Awaited<ReturnType<typeof runJudge>> | undefined;
    let terminalOutcome: 'completed' | { code: string; message: string } = {
      code: 'JUDGE_ERROR',
      message: 'judge execution ended before producing a terminal outcome',
    };

    // Finalize the judge's child session (best-effort) so it never lingers as
    // "running". This is called only from the lifecycle finally below.
    const finalizeJudgeSession = async (
      outcome: 'completed' | { code: string; message: string }
    ): Promise<void> => {
      if (!judgeSessionManager || !judgeSessionID || !judgeAgentId) return;
      try {
        if (judgeMsgID && result?.usage) {
          await judgeSessionManager.updateMessage(judgeSessionID, judgeAgentId, judgeMsgID, {
            time: { completed: Date.now() },
            assistant: {
              tokens: usageToAssistantTokens(result.usage),
              ...(result.contextUsage && { context: result.contextUsage }),
            },
          });
        }
        if (outcome === 'completed') await judgeSessionManager.setSessionCompleted(judgeSessionID, judgeAgentId);
        else await judgeSessionManager.setSessionError(judgeSessionID, judgeAgentId, outcome);
      } catch (error) {
        logger.debug(`[Verify] Failed to finalize judge session: ${(error as Error).message}`);
      }
    };

    try {
      result = logSink ? await runWithLogSink(logSink.capture, runJudge) : await runJudge();

      if (result.suspended) {
        terminalOutcome = { code: 'JUDGE_SUSPENDED', message: 'judge suspended on an approval gate' };
        return { status: 'error', detail: `judge agent ${judgeAgent.name} suspended on an approval gate; judges cannot suspend` };
      }

      // Prefer the structured submit_verdict tool call; fall back to scraping a
      // trailing JSON object from the text for a judge that answered in prose.
      const verdict = submittedVerdict ?? extractVerdict(result.text ?? '');
      if (!verdict) {
        terminalOutcome = { code: 'JUDGE_NO_VERDICT', message: 'judge did not call submit_verdict or return a parseable verdict' };
        return { status: 'error', detail: `judge agent ${judgeAgent.name} did not call submit_verdict or return a parseable verdict` };
      }
      if (!verdict.pass && !verdict.critique) {
        terminalOutcome = { code: 'JUDGE_NO_CRITIQUE', message: 'judge failed the output without a critique' };
        return { status: 'error', detail: `judge agent ${judgeAgent.name} failed the output without a critique` };
      }
      terminalOutcome = 'completed';
      return { status: 'verdict', verdict };
    } catch (error) {
      const cancelled = abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError');
      terminalOutcome = {
        code: cancelled ? 'JUDGE_CANCELLED' : 'JUDGE_ERROR',
        message: cancelled
          ? 'judge execution was cancelled'
          : `judge execution failed: ${error instanceof Error ? error.message : String(error)}`,
      };
      throw error;
    } finally {
      try {
        if (logSink) await logSink.flush();
      } finally {
        await finalizeJudgeSession(terminalOutcome);
      }
    }
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
  /** Parent session so a judge agent runs as an inspectable child session.
   * Omitted → sessionless judge (built-in judge ignores this entirely). */
  parentSession?: JudgeParentSession | undefined;
}): Promise<JudgeOutcome> {
  const { input, config, agentModel, agentFilePath, projectContext, abortSignal, parentSession } = params;
  try {
    if (config.judge) {
      return await judgeViaAgent(input, config.judge, agentFilePath, projectContext, abortSignal, parentSession);
    }
    return await judgeBuiltin(input, config, agentModel, abortSignal);
  } catch (error) {
    if (abortSignal?.aborted || (error instanceof Error && error.name === 'AbortError')) {
      const abortError = error instanceof Error ? error : new Error('Verification cancelled');
      abortError.name = 'AbortError';
      throw abortError;
    }
    return { status: 'error', detail: (error as Error).message };
  }
}
