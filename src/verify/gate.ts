/**
 * Verify gate placement — judge an `await_human` payload BEFORE the run
 * suspends to a human. A failed verdict short-circuits the suspension and
 * returns a rejection-with-comment tool result (the exact protocol a human
 * rejection uses), so the agent revises and re-gates. The judge can never
 * deadlock a run: after `maxRedos` rejections, on any judge error, and on
 * every pass, the gate suspends to the human as normal (fail-open).
 * @experimental This feature is experimental and may change in future versions.
 */

import type { Tool } from 'ai';
import { judgeOutput } from './judge.js';
import type { CanonicalVerifyConfig, VerifyPlacement } from './types.js';
import { logger } from '../utils/logger.js';
import type { SessionManager } from '../session/manager.js';
import type { Part, VerifyPart } from '../session/types.js';

/** Resolve which placements are active. Default: gate when the agent carries
 * an approval gate, output otherwise. */
export function resolveVerifyPlacements(
  config: CanonicalVerifyConfig,
  hasApprovalGate: boolean
): Set<Exclude<VerifyPlacement, 'both'>> {
  const at = config.at ?? (hasApprovalGate ? 'gate' : 'output');
  return new Set(at === 'both' ? (['gate', 'output'] as const) : ([at] as const));
}

/** Render the await_human payload into judge-readable text. Field order mirrors
 * what the human reviewer sees on the approval page. */
export function renderGatePayload(input: Record<string, unknown>): string {
  const sections: string[] = [];
  const str = (v: unknown): string | undefined =>
    typeof v === 'string' && v.trim() ? v.trim() : undefined;

  const prompt = str(input.prompt);
  if (prompt) sections.push(`## Approval request\n${prompt}`);

  const reference = input.reference as Record<string, unknown> | undefined;
  if (reference && typeof reference === 'object') {
    const lines = [
      str(reference.label) && `${str(reference.label)}:`,
      str(reference.author) && `Author: ${str(reference.author)}`,
      str(reference.title) && `Title: ${str(reference.title)}`,
      str(reference.url) && `URL: ${str(reference.url)}`,
      str(reference.excerpt) && `Excerpt: ${str(reference.excerpt)}`,
    ].filter(Boolean);
    if (lines.length > 0) sections.push(`## Target / original\n${lines.join('\n')}`);
  }

  const changes = input.changes as Array<{ label?: string; content?: string }> | undefined;
  if (Array.isArray(changes)) {
    const rendered = changes
      .map((c, i) => `### ${str(c?.label) ?? `Action ${i + 1}`}\n${str(c?.content) ?? ''}`)
      .join('\n\n');
    if (rendered.trim()) sections.push(`## On approval (the exact content under review)\n${rendered}`);
  }

  const draft = str(input.draft);
  if (draft) sections.push(`## Draft\n${draft}`);

  const summary = str(input.summary);
  if (summary) sections.push(`## Why this request\n${summary}`);

  const context = str(input.context);
  if (context) sections.push(`## Context\n${context}`);

  const risk = str(input.risk);
  if (risk) sections.push(`## Risk\n${risk}`);

  return sections.join('\n\n');
}

export interface GateVerifyOptions {
  config: CanonicalVerifyConfig;
  agentModel: string;
  /** The agent's task/instructions, given to the judge as context. */
  task: string;
  agentFilePath?: string | undefined;
  projectContext?: { projectRoot: string; stateRoot: string; cwd: string } | undefined;
  abortSignal?: AbortSignal | undefined;
  /** Session handles for persisting the gate judge verdict as a VerifyPart, so
   * a pre-review PASS is inspectable in `sessions show` (not just a log line),
   * matching the output redo-loop path. All four must be present or persistence
   * is skipped (best-effort — a missing session never blocks the gate). */
  sessionManager?: SessionManager | undefined;
  sessionID?: string | undefined;
  agentId?: string | undefined;
  messageID?: string | undefined;
}

/**
 * Wrap an await_human tool with a pre-suspension judge. The rejection counter
 * lives in the closure: it spans all judge-bounces within one stream segment
 * (no suspension happens between them) and resets on resume, which starts a
 * fresh human-directed revision cycle.
 */
export function withGateVerify<T extends Tool>(tool: T, options: GateVerifyOptions): T {
  const { config, agentModel, task, agentFilePath, projectContext, abortSignal } = options;
  const { sessionManager, sessionID, agentId, messageID } = options;
  const innerExecute = tool.execute;
  if (!innerExecute) return tool;
  let gateRejections = 0;

  const judgeName = config.judge ?? config.model ?? agentModel;
  // Persist the gate verdict as a VerifyPart so a PASS (and error) is inspectable
  // in the session, mirroring the output redo-loop (runner/verify-loop.ts).
  // Best-effort: a missing session handle or a write failure never blocks the gate.
  const recordVerifyPart = async (part: Omit<VerifyPart, 'id' | 'sessionID' | 'messageID'>) => {
    if (!sessionManager || !sessionID || !agentId || !messageID) return;
    try {
      await sessionManager.addPart(sessionID, agentId, messageID, part as Omit<Part, 'id' | 'sessionID' | 'messageID'>);
    } catch (error) {
      logger.debug(`[Verify] Failed to record gate verify marker: ${(error as Error).message}`);
    }
  };

  return {
    ...tool,
    execute: async (input: Record<string, unknown>, callOptions: unknown) => {
      const suspend = () => innerExecute(input as never, callOptions as never);

      if (config.maxRedos > 0 && gateRejections >= config.maxRedos) {
        logger.warn(
          `[Verify] Gate pre-review budget exhausted (${gateRejections} rejection${gateRejections === 1 ? '' : 's'}); escalating to the human reviewer with the critique unresolved`
        );
        return suspend();
      }

      const attempt = gateRejections;
      const outcome = await judgeOutput({
        input: { task, output: renderGatePayload(input), attempt },
        config,
        agentModel,
        agentFilePath,
        projectContext,
        abortSignal,
        ...(sessionManager && sessionID && agentId
          ? { parentSession: { sessionManager, sessionID, agentId } }
          : {}),
      });

      if (outcome.status === 'error') {
        logger.warn(`[Verify] Gate pre-review judge failed (${outcome.detail}); escalating to the human reviewer unjudged`);
        await recordVerifyPart({
          type: 'verify', verdict: 'error', attempt, maxRedos: config.maxRedos,
          critique: outcome.detail, judge: judgeName, time: { start: Date.now() },
        });
        return suspend();
      }

      if (outcome.verdict.pass) {
        logger.info('[Verify] Gate draft passed pre-review; requesting human approval');
        await recordVerifyPart({
          type: 'verify', verdict: 'pass', attempt, maxRedos: config.maxRedos,
          ...(outcome.verdict.critique && { critique: outcome.verdict.critique }),
          judge: judgeName, time: { start: Date.now() },
        });
        return suspend();
      }

      gateRejections++;
      const critique = outcome.verdict.critique ?? 'The draft did not pass pre-review.';
      await recordVerifyPart({
        type: 'verify', verdict: 'fail', attempt, maxRedos: config.maxRedos,
        critique, judge: judgeName, time: { start: Date.now() },
      });
      // Zero redos still judges the initial candidate. A failure has no
      // automated revision budget, so send that judged candidate to the human.
      if (config.maxRedos === 0) return suspend();
      logger.info(`[Verify] Gate draft rejected by pre-review (${gateRejections} of ${config.maxRedos}): ${critique.slice(0, 200)}`);
      // Mirror the human rejection-with-comment protocol so existing agent
      // instructions ("on reject, revise and re-gate") apply unchanged.
      return {
        status: 'rejected',
        comment: `[Automated pre-review — not the human reviewer] ${critique}\n\nRevise the draft to address this critique, then request approval again. Pre-review rejection ${gateRejections} of ${config.maxRedos}; after that the request goes to the human reviewer regardless. Do not perform any side-effectful action in the meantime.`,
        reviewer: { username: 'verify-judge' },
      };
    },
  } as T;
}
