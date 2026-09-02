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
import {
  gatherHumanApprovalHistory,
  type HumanApprovalDecision,
} from '../runner/session-helper.js';
import { open, realpath, stat } from 'fs/promises';
import { resolve } from 'path';
import { isBlockedReviewPath, isPathInside } from '../utils/path-policy.js';

/** Resolve which placements are active. Default: gate when the agent carries
 * an approval gate, output otherwise. */
export function resolveVerifyPlacements(
  config: CanonicalVerifyConfig,
  hasApprovalGate: boolean
): Set<Exclude<VerifyPlacement, 'both'>> {
  const at = config.at ?? (hasApprovalGate ? 'gate' : 'output');
  return new Set(at === 'both' ? (['gate', 'output'] as const) : ([at] as const));
}

const MAX_EMBEDDED_ARTIFACT_BYTES = 12_000;
const MAX_TOTAL_ARTIFACT_BYTES = 24_000;

function renderHumanReviewHistory(decisions: HumanApprovalDecision[]): string | undefined {
  if (decisions.length === 0) return undefined;
  return decisions.map((decision, index) => {
    const metadata = [
      `Decision: ${decision.status}`,
      decision.choice && `Selected option: ${decision.choice}`,
      decision.reviewer && `Reviewer: ${decision.reviewer}`,
      decision.comment && `Reviewer comment: ${decision.comment}`,
    ].filter(Boolean).join('\n');
    return `### Human decision ${index + 1}\n${metadata}${decision.work ? `\n\nWork reviewed:\n${decision.work}` : ''}`;
  }).join('\n\n');
}

/**
 * A real reviewer comment hands the current revision cycle to the human. The
 * next gate should show that revision directly to them instead of spending
 * another judge call that can reinterpret or override their instruction.
 *
 * This is naturally one-cycle scoped: once that next gate resolves, its newer
 * human decision becomes the latest history entry. Machine pre-review bounces
 * never enter this history, so they cannot bypass their own retry.
 */
export function shouldDeferGateReviewToHuman(
  decisions: HumanApprovalDecision[],
): boolean {
  const latest = decisions[decisions.length - 1];
  return latest?.status === 'commented' && Boolean(latest.comment?.trim());
}

async function renderLocalArtifacts(
  paths: string[],
  projectRoot: string | undefined
): Promise<string | undefined> {
  if (paths.length === 0) return undefined;
  if (!projectRoot) {
    return paths.map((artifactPath) => `- ${artifactPath} (content unavailable: no project root)`).join('\n');
  }

  let remaining = MAX_TOTAL_ARTIFACT_BYTES;
  const realRoot = await realpath(projectRoot).catch(() => undefined);
  const rendered: string[] = [];

  for (const artifactPath of paths) {
    if (!realRoot || remaining <= 0) {
      rendered.push(`### ${artifactPath}\n[content not embedded: verification preview limit reached]`);
      continue;
    }
    try {
      const resolved = resolve(projectRoot, artifactPath);
      const real = await realpath(resolved);
      if (!isPathInside(realRoot, real) || isBlockedReviewPath(realRoot, real)) {
        throw new Error('path is outside the reviewable project surface');
      }
      const fileStat = await stat(real);
      if (!fileStat.isFile()) throw new Error('path is not a regular file');

      const bytesToRead = Math.min(fileStat.size, MAX_EMBEDDED_ARTIFACT_BYTES, remaining);
      const handle = await open(real, 'r');
      let content: Buffer;
      try {
        content = Buffer.alloc(bytesToRead);
        const result = await handle.read(content, 0, bytesToRead, 0);
        content = content.subarray(0, result.bytesRead);
      } finally {
        await handle.close();
      }

      let text: string;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(content);
      } catch {
        rendered.push(`### ${artifactPath}\n[${fileStat.size} byte binary artifact; content cannot be embedded in the text judge prompt]`);
        continue;
      }
      remaining -= content.length;
      const truncation = fileStat.size > content.length
        ? `\n\n[artifact truncated: showing ${content.length} of ${fileStat.size} bytes]`
        : '';
      rendered.push(`### ${artifactPath}\n${text}${truncation}`);
    } catch (error) {
      rendered.push(`### ${artifactPath}\n[content unavailable: ${(error as Error).message}]`);
    }
  }
  return rendered.join('\n\n');
}

/** Render the complete await_human review surface into judge-readable text.
 * Local UTF-8 artifacts are embedded with bounded previews when projectRoot is
 * available; binary/external artifacts remain explicit references. */
export async function renderGatePayload(
  input: Record<string, unknown>,
  projectRoot?: string
): Promise<string> {
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

  const options = input.options as Array<Record<string, unknown>> | undefined;
  const optionLabels = new Map<string, string>();
  if (Array.isArray(options)) {
    for (const option of options) {
      const id = str(option?.id);
      if (id) optionLabels.set(id, str(option?.label) ?? id);
    }
  }

  const changes = input.changes as Array<{ label?: string; content?: string; displayContent?: string; optionId?: string }> | undefined;
  if (Array.isArray(changes)) {
    const rendered = changes
      .map((c, i) => {
        const optionId = str(c?.optionId);
        const scope = optionId
          ? `\nReviewer choice: ${optionLabels.get(optionId) ?? optionId} [${optionId}]`
          : '';
        const content = str(c?.content) ?? '';
        const displayContent = str(c?.displayContent);
        const exactCommand = displayContent && displayContent !== content
          ? `\n\nExact command:\n${content}`
          : '';
        return `### ${str(c?.label) ?? `Action ${i + 1}`}${scope}\n${displayContent ?? content}${exactCommand}`;
      })
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

  if (Array.isArray(options)) {
    const rendered = options
      .map((option, index) => {
        const id = str(option?.id) ?? `option-${index + 1}`;
        const label = str(option?.label) ?? id;
        const description = str(option?.description);
        const recommended = option?.recommended === true ? ' (recommended)' : '';
        return `- ${label}${recommended} [${id}]${description ? `: ${description}` : ''}`;
      })
      .join('\n');
    if (rendered) sections.push(`## Reviewer choices\n${rendered}`);
  }

  const links = [
    str(input.artifact_url) && `Primary artifact: ${str(input.artifact_url)}`,
    str(input.draft_url) && `Draft artifact: ${str(input.draft_url)}`,
  ].filter((line): line is string => Boolean(line));
  if (links.length > 0) sections.push(`## External review artifacts\n${links.join('\n')}`);

  const artifactPaths = [
    str(input.artifact_path),
    ...(Array.isArray(input.artifact_paths) ? input.artifact_paths.map(str) : []),
  ].filter((artifactPath): artifactPath is string => Boolean(artifactPath));
  const localArtifacts = await renderLocalArtifacts([...new Set(artifactPaths)], projectRoot);
  if (localArtifacts) sections.push(`## Local review artifacts\n${localArtifacts}`);

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
 * Wrap an await_human tool with a pre-suspension judge. A gate immediately
 * following a real human Comment bypasses the judge so the requested revision
 * returns directly to that reviewer. Otherwise, the rejection counter lives in
 * the closure: it spans all judge-bounces within one stream segment (no
 * suspension happens between them) and resets on resume.
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
      const humanDecisions = sessionManager && sessionID && agentId
        ? await gatherHumanApprovalHistory(sessionManager, sessionID, agentId)
        : [];

      if (shouldDeferGateReviewToHuman(humanDecisions)) {
        logger.info('[Verify] Gate pre-review skipped after a human reviewer comment; returning the revision directly to the reviewer');
        return suspend();
      }

      if (config.maxRedos > 0 && gateRejections >= config.maxRedos) {
        logger.warn(
          `[Verify] Gate pre-review budget exhausted (${gateRejections} rejection${gateRejections === 1 ? '' : 's'}); escalating to the human reviewer with the critique unresolved`
        );
        return suspend();
      }

      const attempt = gateRejections;
      const renderedPayload = await renderGatePayload(input, projectContext?.projectRoot);
      const reviewHistory = renderHumanReviewHistory(humanDecisions);
      const outcome = await judgeOutput({
        input: {
          kind: 'gate',
          task,
          output: renderedPayload,
          attempt,
          ...(reviewHistory && { reviewHistory }),
        },
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
      // Keep the rejection-with-comment shape for compatibility, but mark the
      // source explicitly so agents and history readers never confuse this
      // machine bounce with a human decision.
      return {
        status: 'rejected',
        source: 'pre-review',
        comment: `[Automated pre-review — not the human reviewer] ${critique}\n\nRevise the draft to address this critique, then request approval again. Pre-review rejection ${gateRejections} of ${config.maxRedos}; after that the request goes to the human reviewer regardless. Do not perform any side-effectful action in the meantime.`,
        reviewer: { username: 'verify-judge' },
      };
    },
  } as T;
}
