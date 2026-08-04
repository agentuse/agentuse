/**
 * Verify redo loop — judge the run's final output, and on a failed verdict
 * inject the critique as a synthetic user turn and let the agent redo the
 * output in the same session, up to `verify.maxRedos`.
 * @experimental This feature is experimental and may change in future versions.
 */

import type { ModelMessage } from 'ai';
import type { ParsedAgent } from '../parser.js';
import type { SessionManager } from '../session/manager.js';
import type { Part, SessionInfo, VerifyPart } from '../session/types.js';
import { rehydrateMessages } from '../session/rehydrate.js';
import { addLanguageModelUsage } from '../session/usage.js';
import { judgeOutput } from '../verify/judge.js';
import type { CanonicalVerifyConfig } from '../verify/types.js';
import { logger } from '../utils/logger.js';
import type { processAgentStream } from './stream.js';
import { composeFinalOutput } from '../tools/report-outcome.js';
import type { RunOutcome } from '../tools/report-outcome.js';

type StreamResult = Awaited<ReturnType<typeof processAgentStream>>;

export interface VerifyLoopOutcome {
  /** Final stream result (last attempt, with usage merged across attempts). */
  result: StreamResult;
  /** Final verdict for SessionInfo.verification; undefined when a redo
   * suspended on an approval gate (verification resolves after resume). */
  verification?: SessionInfo['verification'];
}

/** Sum usage/tool metrics across attempts so the session tally counts every
 * attempt, while text/finish state comes from the last one. */
function mergeResults(previous: StreamResult, next: StreamResult): StreamResult {
  const usage = next.usage
    ? addLanguageModelUsage(previous.usage, next.usage)
    : previous.usage;

  return {
    ...next,
    ...(usage && { usage }),
    toolCalls: [...(previous.toolCalls ?? []), ...(next.toolCalls ?? [])],
    subAgentTokens: (previous.subAgentTokens ?? 0) + (next.subAgentTokens ?? 0),
    toolCallTraces: [...(previous.toolCallTraces ?? []), ...(next.toolCallTraces ?? [])],
    finishReasons: [...(previous.finishReasons ?? []), ...(next.finishReasons ?? [])],
    parts: [...previous.parts, ...next.parts],
  };
}

export function buildRedoPrompt(params: {
  critique: string;
  config: CanonicalVerifyConfig;
  /** 1-based redo number (the attempt this prompt is asking for is redo N). */
  redoNumber: number;
}): string {
  const { critique, config, redoNumber } = params;
  const judgeLabel = config.judge
    ? `Judged by: ${config.judge}`
    : config.criteria
      ? `Criteria: ${config.criteria}`
      : 'Criteria: the output must fully accomplish the task, be complete and coherent, and contain no unsupported claims.';
  const totalAttempts = config.maxRedos + 1;
  const isFinal = redoNumber >= config.maxRedos;

  return `Your output was checked against this run's verification criteria and rejected.

${judgeLabel}
Attempt: ${redoNumber + 1} of ${totalAttempts}${isFinal ? ' (final attempt)' : ''}

Reviewer's critique:
${critique}

Produce a revised final output that addresses the critique. Do not argue with or respond to the review; respond with the revised output. Work already completed this session stands — do not repeat side-effectful actions. You may use tools if the critique requires new information.`;
}

/**
 * Run the verify/redo loop over a completed (non-suspended) stream result.
 * Judge failures never block the output: they record an `error` marker and the
 * output ships unverified.
 */
export async function runVerifyLoop(params: {
  agent: ParsedAgent;
  config: CanonicalVerifyConfig;
  /** The original task (instructions + user prompt) for judge context. */
  task: string;
  initialResult: StreamResult;
  sessionManager: SessionManager;
  sessionID: string;
  agentId: string;
  messageID: string;
  /** Re-run the agent loop on an updated message history (built by the caller
   * so core/stream options stay in one place). */
  executeRedo: (messages: ModelMessage[], redoUserMessage: string) => Promise<StreamResult>;
  agentFilePath?: string | undefined;
  projectContext?: { projectRoot: string; stateRoot: string; cwd: string } | undefined;
  abortSignal?: AbortSignal | undefined;
  quiet?: boolean;
  /**
   * Live outcome slot. An agent that delivers via `report_complete` streams no
   * prose, so judging `result.text` alone would judge an empty string. Read per
   * attempt because a redo can call the tool again with a better answer.
   */
  runOutcome?: RunOutcome | undefined;
}): Promise<VerifyLoopOutcome> {
  const {
    agent, config, task, initialResult, sessionManager, sessionID, agentId,
    messageID, executeRedo, agentFilePath, projectContext, abortSignal, quiet, runOutcome
  } = params;

  const judgeName = config.judge ?? config.model ?? agent.config.model;
  let merged = initialResult;
  let latest = initialResult;
  let redoCount = 0;

  const recordVerifyPart = async (part: Omit<VerifyPart, 'id' | 'sessionID' | 'messageID'>) => {
    try {
      await sessionManager.addPart(sessionID, agentId, messageID, part as Omit<Part, 'id' | 'sessionID' | 'messageID'>);
    } catch (error) {
      logger.debug(`[Verify] Failed to record verify marker: ${(error as Error).message}`);
    }
  };

  for (let attempt = 0; ; attempt++) {
    if (!quiet) logger.info(`[Verify] Judging output (attempt ${attempt + 1} of ${config.maxRedos + 1})...`);
    const outcome = await judgeOutput({
      input: { kind: 'output', task, output: composeFinalOutput(runOutcome?.complete, latest.text ?? ''), attempt },
      config,
      agentModel: agent.config.model,
      agentFilePath,
      projectContext,
      abortSignal,
      parentSession: { sessionManager, sessionID, agentId },
    });
    const now = Date.now();

    if (outcome.status === 'error') {
      logger.warn(`[Verify] Judge failed (${outcome.detail}); output ships unverified`);
      await recordVerifyPart({
        type: 'verify', verdict: 'error', attempt, maxRedos: config.maxRedos,
        critique: outcome.detail, judge: judgeName, time: { start: now },
      });
      return {
        result: merged,
        verification: { status: 'error', redoCount, critique: outcome.detail, time: now },
      };
    }

    const { verdict } = outcome;
    await recordVerifyPart({
      type: 'verify', verdict: verdict.pass ? 'pass' : 'fail', attempt, maxRedos: config.maxRedos,
      ...(verdict.critique && { critique: verdict.critique }), judge: judgeName, time: { start: now },
    });

    if (verdict.pass) {
      if (!quiet) logger.info(`[Verify] Output passed verification${redoCount > 0 ? ` after ${redoCount} redo(s)` : ''}`);
      return { result: merged, verification: { status: 'passed', redoCount, time: now } };
    }

    const critique = verdict.critique ?? 'The output did not pass verification.';
    if (redoCount >= config.maxRedos) {
      logger.warn(`[Verify] Output failed verification after ${redoCount} redo(s); shipping last attempt`);
      return {
        result: merged,
        verification: { status: 'failed', redoCount, critique, time: now },
      };
    }

    // Redo: inject the critique as a synthetic user turn (visible in the
    // session log) and continue the loop on the rehydrated history.
    redoCount++;
    if (!quiet) logger.info(`[Verify] Output rejected; redoing (${redoCount} of ${config.maxRedos})`);
    const redoPrompt = buildRedoPrompt({ critique, config, redoNumber: redoCount });

    // Rehydrate BEFORE persisting the synthetic prompt part, or the prompt
    // would appear twice in the model-facing history.
    const messages = await rehydrateMessages(sessionManager, sessionID, agentId);
    messages.push({ role: 'user', content: redoPrompt } as ModelMessage);

    try {
      await sessionManager.addPart(sessionID, agentId, messageID, {
        type: 'text', role: 'user', synthetic: true, text: redoPrompt,
        time: { start: Date.now(), end: Date.now() },
      } as Omit<Part, 'id' | 'sessionID' | 'messageID'>);
    } catch (error) {
      logger.debug(`[Verify] Failed to record redo prompt: ${(error as Error).message}`);
    }

    latest = await executeRedo(messages, redoPrompt);
    merged = mergeResults(merged, latest);

    // A redo hit an approval gate: bail out and let the caller's suspended
    // path take over. Verification resolves on the post-resume run.
    if (latest.suspended) {
      return { result: merged };
    }
  }
}
