import { createHash } from 'crypto';
import { resolve } from 'path';
import { SessionManager } from '../session/index.js';
import type { ActiveContextUsage } from '../session';
import type { SessionTokenUsage } from './types.js';

export function approvalProjectionKey(projectRoot: string): string {
  const projectHash = createHash('sha256').update(resolve(projectRoot)).digest('hex').slice(0, 20);
  return `.index/approvals.${projectHash}.v1`;
}

export function valueAsRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

export function formatApprovalLogValue(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  return typeof value === 'string'
    ? value
    : JSON.stringify(value, null, 2);
}

export function sessionErrorFields(session: { status?: string; error?: { code?: string; message?: string; cause?: string; subject?: string; causeSource?: string } }) {
  if (!session.error) return {};
  // Resuming or continuing a failed run flips the status back to running but
  // leaves the old error on the record (it's kept as history for the session
  // log). Only report it while the failure is still the session's current
  // state, or every list row would keep showing a stale "failed" line under a
  // run that is working again.
  if (session.status !== undefined && session.status !== 'error') return {};
  return {
    ...(session.error.cause && { errorCause: session.error.cause }),
    ...(session.error.subject && { errorSubject: session.error.subject }),
    ...(session.error.causeSource && { errorCauseSource: session.error.causeSource }),
    ...(typeof session.error.code === 'string' && session.error.code ? { errorCode: session.error.code } : {}),
    ...(typeof session.error.message === 'string' && session.error.message ? { errorMessage: session.error.message } : {})
  };
}

// Reviewer's "reviewed, wave it off" stamp on an ended failed run; surfaced
// so needs-attention lists drop the row and the UI hides the Discard action.
// reviewedAt rides along: the reviewer opened the run's page, so "results
// you haven't seen" surfaces drop it the same way.
export function dismissedAtField(session: { dismissedAt?: number; reviewedAt?: number }) {
  return {
    ...(typeof session.dismissedAt === 'number' ? { dismissedAt: session.dismissedAt } : {}),
    ...(typeof session.reviewedAt === 'number' ? { reviewedAt: session.reviewedAt } : {}),
  };
}

// Showcase mode: mock runs stay fully functional (cheap, no real side effects)
// but AGENTUSE_HIDE_MOCK=1 suppresses the mock flag in serve payloads so a demo
// does not read as fake. Storage keeps session.mock intact; only the API/UI view
// is affected.
export function mockField(session: { mock?: boolean }) {
  return session.mock && process.env.AGENTUSE_HIDE_MOCK !== '1' ? { mock: true as const } : {};
}

export function aggregateSessionTokenUsage(
  messages: Array<{ assistant?: { tokens?: { input?: number; output?: number; cache?: { read?: number } }; context?: ActiveContextUsage } }>,
  contextOverride?: ActiveContextUsage
): SessionTokenUsage | undefined {
  if (messages.length === 0) return undefined;
  const usage = messages.reduce<SessionTokenUsage>((total, message) => {
    const tokens = message.assistant?.tokens;
    return {
      input: total.input + (typeof tokens?.input === 'number' ? tokens.input : 0),
      cachedInput: total.cachedInput + (typeof tokens?.cache?.read === 'number' ? tokens.cache.read : 0),
      output: total.output + (typeof tokens?.output === 'number' ? tokens.output : 0),
      ...(message.assistant?.context
        ? { context: message.assistant.context }
        : total.context
          ? { context: total.context }
          : {}),
    };
  }, { input: 0, cachedInput: 0, output: 0 });
  if (contextOverride) {
    usage.context = contextOverride;
  }
  return usage.input + usage.cachedInput + usage.output > 0 || usage.context ? usage : undefined;
}

export async function buildContinuationPrompt(
  sessionManager: InstanceType<typeof SessionManager>,
  sessionId: string,
  agentId: string,
  session: { id: string; status: string },
  prompt?: string
): Promise<string> {
  const previous = await sessionManager.getLastAssistantText(sessionId, agentId);
  return [
    `Continue from previous AgentUse session ${session.id}.`,
    `Previous session status: ${session.status}.`,
    previous ? `Previous final assistant output:\n${previous}` : undefined,
    prompt?.trim()
      ? `New instruction:\n${prompt.trim()}`
      : 'New instruction:\nContinue from where the previous session left off.'
  ].filter(Boolean).join('\n\n');
}

export function formatTokenCount(n: number): string {
  if (n >= 1000) return `${(n / 1000).toFixed(n >= 10000 ? 0 : 1)}k`;
  return String(n);
}
