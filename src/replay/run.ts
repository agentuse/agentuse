import { createHash } from 'crypto';
import { readFile } from 'fs/promises';
import { atomicWriteFile } from '../utils/atomic-write';
import { join } from 'path';
import type { ParsedAgent } from '../parser';
import type { SessionManager } from '../session';
import { computeAgentId } from '../utils/agent-id';
import { resolveMaxSteps } from '../utils/config';
import { toErrorMessage } from '../utils/error-message';
import { buildFreshInstructions } from '../runner/instructions';
import { buildSystemMessages } from '../runner/system-messages';
import { createSessionAndMessage } from '../runner/session-helper';
import { executeAgentCore } from '../runner/execution';
import { processAgentStream } from '../runner/stream';
import { loadReplayRecording, snapshotReplayReferences, ReplayDispatcher, type ReplayStop, type ReplayTrace } from './recording';
import { version } from '../../package.json';

export interface ReplayResult {
  success: boolean;
  status: 'proposal' | 'completed' | 'incomplete' | 'mismatch' | 'error';
  sourceSessionId: string;
  sessionId: string;
  model: string;
  sourceModel: string;
  instructionsSha256: string;
  agentSha256: string;
  referenceFiles: Array<{ path: string; sha256: string }>;
  original: { proposal?: unknown; text: string };
  current: { proposal?: unknown; output?: unknown; text: string };
  calls: ReplayTrace[];
  error?: string;
  reportPath: string;
}

/** A fresh model run, not a resume. It intentionally never calls the live tool
 * loader, plugins' lifecycle hooks, verify, channels, or learning capture. */
export async function runReplay(options: {
  agent: ParsedAgent;
  agentFilePath: string;
  sourceSessionId: string;
  sessionManager: SessionManager;
  projectContext: { projectRoot: string; stateRoot: string; cwd: string };
  timeoutSeconds: number;
  maxSteps?: number | undefined;
  abortSignal?: AbortSignal;
}): Promise<ReplayResult> {
  const { agent, agentFilePath, sessionManager, projectContext } = options;
  options.abortSignal?.throwIfAborted();
  const agentSha256 = createHash('sha256').update(await readFile(agentFilePath)).digest('hex');
  const recording = await loadReplayRecording(sessionManager, options.sourceSessionId);
  const references = await snapshotReplayReferences(agent, projectContext.projectRoot, agentFilePath);
  const { instructions } = await buildFreshInstructions({ agent, agentFilePath, projectContext, recordLearningUsage: false });
  const { messages: systemMessages } = await buildSystemMessages({
    agent, agentFilePath, projectRoot: projectContext.projectRoot, stateRoot: projectContext.stateRoot,
    now: new Date(recording.createdAt),
    codeModeEnabled: false,
  });
  const referencePaths = references.map(r => r.path);
  systemMessages.push({ role: 'system', content: `This is a recorded-input replay of a real run from ${new Date(recording.createdAt).toISOString()}. Use that date for relative time. The original task prompt follows your CURRENT instructions. Tool schemas and external results are frozen from the source run. All calls are replay-only: no external operation, command, store mutation, or child agent executes. Call the tools you need normally. A call without a matching recording stops the test; do not invent its result. Explicit read-only reference files are snapshotted from the current workspace: ${JSON.stringify(referencePaths)}. Draft normally and submit your first proposal with await_human; the test captures it before verification or human approval and stops. If no approval is needed, finish normally. No publishing permission is granted. The original draft and human verdict are withheld.` });
  const userMessage = recording.userPrompt ? `${instructions}\n\n${recording.userPrompt}` : instructions;
  const dispatcher = new ReplayDispatcher(recording, references, projectContext.projectRoot);
  const tools = dispatcher.tools();
  const maxSteps = resolveMaxSteps(options.maxSteps, agent.config.maxSteps);
  const agentId = computeAgentId(agentFilePath, projectContext.stateRoot, agent.name);
  options.abortSignal?.throwIfAborted();
  const { sessionID, messageID } = await createSessionAndMessage({
    sessionManager, agent, agentFilePath, systemMessages: systemMessages.map(m => m.content),
    task: instructions, ...(recording.userPrompt && { userPrompt: recording.userPrompt }),
    projectContext, version, mock: true,
    config: { maxSteps, timeout: options.timeoutSeconds, replaySourceSessionId: recording.sessionId },
  });
  const reportPath = join(await sessionManager.getSessionDirectory(sessionID, agentId), 'replay.json');
  const controller = new AbortController();
  const signal = options.abortSignal ? AbortSignal.any([controller.signal, options.abortSignal]) : controller.signal;
  const timeout = setTimeout(() => controller.abort(new Error(`Replay timed out after ${options.timeoutSeconds}s`)), options.timeoutSeconds * 1000);
  let text = '';
  let failure: string | undefined;
  let finishReason: string | undefined;
  try {
    await sessionManager.writeToolsSnapshot(sessionID, agentId, recording.tools);
    signal.throwIfAborted();
    const result = await processAgentStream(executeAgentCore(agent, tools, {
      userMessage, systemMessages, maxSteps, abortSignal: signal,
      replay: { stopped: () => dispatcher.stop !== undefined },
      sessionManager, sessionID, agentId, messageID,
    }), { sessionManager, sessionID, agentId, messageID, quiet: true });
    text = result.text;
    finishReason = result.finishReason;
    signal.throwIfAborted();
  } catch (error) {
    failure = toErrorMessage(error);
  } finally {
    clearTimeout(timeout);
  }
  const stop: ReplayStop | undefined = dispatcher.stop;
  const status: ReplayResult['status'] = failure ? 'error'
    : stop?.kind === 'missing' ? 'mismatch'
    : stop?.kind === 'proposal' ? 'proposal'
    : stop?.kind === 'incomplete' ? 'incomplete'
    : stop?.kind === 'complete' || (finishReason === 'stop' && text.trim()) ? 'completed' : 'error';
  const error = failure ?? (stop?.kind === 'missing' ? stop.reason
    : status === 'error' ? 'Replay ended without a proposal or final output.' : undefined);
  const report: ReplayResult = {
    success: status === 'proposal' || status === 'completed', status,
    sourceSessionId: recording.sessionId, sessionId: sessionID,
    model: agent.config.model, sourceModel: recording.model,
    instructionsSha256: createHash('sha256').update(instructions).digest('hex'),
    agentSha256,
    referenceFiles: references.map(({ path, sha256 }) => ({ path, sha256 })),
    original: recording.original,
    current: { text, ...(stop?.kind === 'proposal' && { proposal: stop.proposal }),
      ...((stop?.kind === 'complete' || stop?.kind === 'incomplete') && { output: stop.output }) },
    calls: dispatcher.trace, ...(error && { error }), reportPath,
  };
  try {
    await atomicWriteFile(reportPath, JSON.stringify(report, null, 2), { mode: 0o600 });
  } catch (error) {
    await sessionManager.updateSession(sessionID, agentId, { status: 'error', error: {
      code: 'REPLAY_REPORT_ERROR', message: toErrorMessage(error), time: Date.now(),
    } });
    throw error;
  }
  await sessionManager.updateSession(sessionID, agentId, {
    status: report.success ? 'completed' : 'error',
    ...(!report.success && { error: { code: status === 'mismatch' ? 'REPLAY_INPUT_MISSING' : status === 'incomplete' ? 'INCOMPLETE' : 'REPLAY_ERROR', message: error ?? 'Agent reported incomplete', time: Date.now() } }),
  });
  return report;
}

function proposalText(value: unknown): string {
  if (!value || typeof value !== 'object') return value === undefined ? '(none)' : JSON.stringify(value, null, 2);
  const payload = value as Record<string, unknown>;
  if (Array.isArray(payload.changes)) return payload.changes.map((change) => {
    const item = change as Record<string, unknown>;
    return `${item.label ?? 'Proposal'}\n${item.displayContent ?? item.content ?? ''}`;
  }).join('\n\n');
  return typeof payload.draft === 'string' ? payload.draft : JSON.stringify(value, null, 2);
}

export function formatReplayResult(result: ReplayResult): string {
  const missing = result.calls.find(c => c.source === 'missing');
  return [
    `Replay ${result.status}: ${result.sourceSessionId} -> ${result.sessionId}`,
    'No live tool operations, automated review, or human approval were performed.',
    ...(missing ? [`Unmatched call: ${missing.tool}\n${JSON.stringify(missing.input, null, 2)}`] : []),
    ...(result.error ? [result.error] : []),
    '\nOriginal proposal/output:', proposalText(result.original.proposal ?? result.original.text),
    '\nNew proposal/output:', proposalText(result.current.proposal ?? result.current.output ?? result.current.text),
    `\nFull comparison and input provenance: ${result.reportPath}`,
  ].join('\n');
}
