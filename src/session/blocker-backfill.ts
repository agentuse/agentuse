import { detectRuntimeBlockers, resolveBlocker } from '../runner/blocker-evidence';
import type { ToolCallTrace } from '../plugin/types';
import { readOutcomeCall } from '../tools/report-outcome';
import type { Blocker, BlockerKind } from './blocker';
import type { SessionManager, SessionListSummary } from './manager';
import type { ToolPart } from './types';

/**
 * Give failed runs from before blockers existed the same grouping key new runs
 * get, and clear failures too old to act on.
 *
 * Evidence is tried from most to least certain, and each blocker records which
 * one it came from:
 *   1. runtime  — a failed tool call in the run (or a sub-agent) printed
 *                 `command not found` / `No module named` about the thing the
 *                 run's own reason names.
 *   2. approval — a gate in the run was rejected and the agent did not report
 *                 any other failure.
 *   3. inferred — keyword rules over the agent's free-text reason. The least
 *                 certain, and labelled so on every surface.
 * Only fields are added: status, code and the original message are never
 * rewritten, so clearing `cause`/`subject`/`causeSource` undoes a run.
 */

export interface BackfillOptions {
  /** Failures last touched within this many days get a blocker; older ones are dismissed. */
  days: number;
  dryRun: boolean;
  now?: number;
}

export interface BackfillEntry {
  sessionId: string;
  agentId: string;
  action: 'blocker' | 'dismiss';
  blocker?: Blocker;
}

const DAY_MS = 24 * 60 * 60 * 1000;

function tracesFromParts(parts: readonly ToolPart[]): ToolCallTrace[] {
  return parts
    .filter((part) => part.state.status === 'error')
    .map((part) => ({
      name: part.tool,
      type: 'tool' as const,
      startTime: 0,
      duration: 0,
      success: false,
      output: part.state.status === 'error' ? part.state.error : undefined,
    }));
}

function outputStatus(part: ToolPart): string | undefined {
  if (part.state.status !== 'completed') return undefined;
  const output = part.state.output;
  if (output && typeof output === 'object' && typeof (output as { status?: unknown }).status === 'string') {
    return (output as { status: string }).status;
  }
  if (typeof output === 'string') {
    try {
      const parsed = JSON.parse(output) as { status?: unknown };
      return typeof parsed.status === 'string' ? parsed.status : undefined;
    } catch {
      return undefined;
    }
  }
  return undefined;
}

/** A rejected gate in the run, unless the agent said something else also failed. */
function approvalBlocker(parts: readonly ToolPart[]): Blocker | undefined {
  const rejected = parts.find((part) => part.tool === 'await_human' && outputStatus(part) === 'reject');
  if (!rejected) return undefined;
  const ownVerdict = parts
    .filter((part) => part.parentCallID === undefined && part.state.status === 'completed')
    .map((part) => readOutcomeCall(part.tool, part.state.input))
    .filter((call) => call?.status === 'incomplete')
    .at(-1);
  if (ownVerdict?.rejectionOnly === false) return undefined;
  const prompt = rejected.state.status === 'completed' ? (rejected.state.input as { prompt?: unknown })?.prompt : undefined;
  const subject = typeof prompt === 'string' && prompt.trim() ? prompt.trim().slice(0, 80) : 'approval';
  return { kind: 'rejected_by_human', subject, source: 'approval' };
}

const FILE = /`?([\w./-]+\.(?:ya?ml|json|md|mdx|csv|txt|toml))`?/i;
const DOMAIN = /\b([a-z0-9-]+\.(?:com|net|org|io|ai|co))\b/i;
const SITE = /\b(quora|instagram|linkedin|substack|reddit|facebook|threads|youtube|tiktok|x)\b/i;
const QUOTED_TOOL = /`([a-z][\w.+-]*)`/gi;

function site(message: string): string | undefined {
  const domain = DOMAIN.exec(message)?.[1];
  if (domain) return domain.toLowerCase();
  const name = SITE.exec(message)?.[1]?.toLowerCase();
  return name === 'x' ? 'x.com' : name && `${name}.com`;
}

/**
 * Best guess at a blocker from the agent's own words. Only a backfill uses
 * this; new runs declare their blocker. Returns `other` with the agent as the
 * subject when nothing matches, so the run still groups with its own repeats.
 */
export function inferBlocker(message: string, agentId: string): Blocker {
  const inferred = (kind: BlockerKind, subject: string): Blocker => ({ kind, subject, source: 'inferred' });
  const text = message.replace(/\s+/g, ' ');

  if (/\brejected\b/i.test(text)) return inferred('rejected_by_human', 'approval');
  if (/\b(waiting|waited|awaiting)\b[^.]{0,60}\b(approval|pick|review|decision|human)\b|\bpending approval\b|\bblocked at (human )?approval\b|\bslots? (are |is )?(taken|full)\b/i.test(text)) {
    return inferred('waiting_on_human', 'approval');
  }
  const file = FILE.exec(text)?.[1];
  if (file && /\b(cut off|truncated|missing|malformed|corrupt|restore|broken|cannot be parsed)\b/i.test(text)) {
    return inferred('bad_input', file);
  }
  if (/\b(boto3|no module|module named|pip install|python package|dependency)\b/i.test(text)) {
    const pkg = /\b(boto3)\b/i.exec(text)?.[1] ?? /module named '?([\w.]+)/i.exec(text)?.[1];
    if (pkg) return inferred('missing_package', pkg.split('.')[0]!.toLowerCase());
  }
  if (/\b(unavailable|not installed|not on path|cannot find|can't find|missing|not found)\b/i.test(text)) {
    for (const match of text.matchAll(QUOTED_TOOL)) {
      const tool = match[1]!;
      if (!tool.includes('/') && !FILE.test(tool)) return inferred('missing_tool', tool.toLowerCase());
    }
  }
  if (/\b(cloudflare|bot check|security check|captcha|logged out|log(ged)? in|sign(ed)? in|rate limit|too many requests|forbidden|denied|403)\b/i.test(text)) {
    return inferred('no_access', site(text) ?? 'login');
  }
  if (/\bHTTP 5\d\d\b|\bserver error\b|\bunreachable\b|\boutage\b/i.test(text)) {
    return inferred('service_down', site(text) ?? 'service');
  }
  return inferred('other', agentId);
}

/** The blocker for one older incomplete run, from the strongest evidence it has. */
export function classifyStoredRun(message: string, agentId: string, parts: readonly ToolPart[]): Blocker {
  const runtime = resolveBlocker(undefined, message, detectRuntimeBlockers(tracesFromParts(parts)));
  return runtime ?? approvalBlocker(parts) ?? inferBlocker(message, agentId);
}

function isOpenFailure(summary: SessionListSummary): boolean {
  return summary.status === 'error'
    && summary.dismissedAt === undefined
    && summary.error?.code !== 'USER_STOPPED';
}

/** Backfill one project's sessions. Reads the store; writes only when not a dry run. */
export async function backfillBlockers(sessionManager: SessionManager, options: BackfillOptions): Promise<BackfillEntry[]> {
  const now = options.now ?? Date.now();
  const cutoff = now - options.days * DAY_MS;
  const summaries = await sessionManager.listSessionSummaries({ includeSubagents: false });
  const entries: BackfillEntry[] = [];
  for (const summary of summaries) {
    if (!isOpenFailure(summary)) continue;
    const base = { sessionId: summary.sessionId, agentId: summary.agent.id };
    if (summary.updatedAt < cutoff) {
      if (options.dryRun || await sessionManager.stampEndedFailure(summary.path, summary.updatedAt, () => ({ dismissedAt: now }))) {
        entries.push({ ...base, action: 'dismiss' });
      }
      continue;
    }
    // Only agent-declared failures get a blocker; a crash or timeout already
    // carries the runtime's own cause, and a run that has one is left alone.
    if (summary.error?.code !== 'INCOMPLETE' || summary.error.cause) continue;
    const message = summary.error.message ?? '';
    const blocker = classifyStoredRun(message, summary.agent.id, await sessionManager.listToolPartsAtPath(summary.path));
    if (!options.dryRun) {
      const stamped = await sessionManager.stampEndedFailure(summary.path, summary.updatedAt, (session) => (
        session.error
          ? { error: { ...session.error, cause: blocker.kind, subject: blocker.subject, causeSource: blocker.source } }
          : {}
      ));
      if (!stamped) continue;
    }
    entries.push({ ...base, action: 'blocker', blocker });
  }
  return entries;
}
