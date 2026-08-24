import type { ParsedAgent } from '../parser';
import type { SessionManager } from '../session';
import type { ErrorPartSource, LogPart, LogPartLevel, Part, SessionTrigger, ToolPart } from '../session/types';
import type { ApprovalReview, LearningOutcome } from '../learning/types';
import { computeAgentId } from '../utils/agent-id';
import { resolveModelProvider } from '../utils/model-utils';
import { isMockMode } from './mock-tools';
import { logger, withoutLogSink, type LogRecord } from '../utils/logger';
import type { RunModelOverride } from '../utils/model-alias';

export interface SessionContext {
  /** cwd-derived project root: drives env, plugins, sandbox, store parent. */
  projectRoot: string;
  /** Agent-file-derived state root: drives session storage and agentId. */
  stateRoot: string;
  cwd: string;
}

export interface SessionConfigOptions {
  timeout?: number;
  maxSteps?: number;
  mcpServers?: string[];
  subagents?: Array<{ path: string; name?: string }>;
  modelOverride?: RunModelOverride;
}

export interface CreateSessionParams {
  sessionManager: SessionManager;
  agent: ParsedAgent;
  agentFilePath?: string;
  systemMessages: string[];
  task: string;
  userPrompt?: string;
  projectContext: SessionContext;
  version: string;
  config?: SessionConfigOptions;
  isSubAgent?: boolean;
  parentSessionID?: string;
  trigger?: SessionTrigger;
  /** Pre-assign the session id instead of generating one (serve detached run). */
  sessionId?: string;
}

/**
 * Create a session and initial message together to keep SessionManager usage consistent.
 */
export async function createSessionAndMessage(params: CreateSessionParams): Promise<{ sessionID: string; messageID: string }> {
  const {
    sessionManager,
    agent,
    agentFilePath,
    systemMessages,
    task,
    userPrompt,
    projectContext,
    version,
    config = {},
    isSubAgent = false,
    parentSessionID,
    trigger,
    sessionId,
  } = params;

  // Extract agent ID from file path (relative to stateRoot, the agent's own
  // project) so the ID is stable regardless of which cwd ran the agent.
  const agentId = computeAgentId(agentFilePath, projectContext.stateRoot, agent.name);

  const sessionID = await sessionManager.createSession({
    ...(sessionId ? { id: sessionId } : {}),
    ...(parentSessionID ? { parentSessionID } : {}),
    ...(trigger ? { trigger } : {}),
    agent: {
      id: agentId,
      name: agent.name,
      ...(agent.description && { description: agent.description }),
      ...(agentFilePath && { filePath: agentFilePath }),
      isSubAgent,
    },
    model: agent.config.model,
    version,
    ...(isMockMode() && { mock: true }),
    config: {
      ...(config.timeout !== undefined && { timeout: config.timeout }),
      ...(config.maxSteps !== undefined && { maxSteps: config.maxSteps }),
      ...(config.mcpServers && { mcpServers: config.mcpServers }),
      ...(config.subagents && { subagents: config.subagents }),
      ...(config.modelOverride && { modelOverride: config.modelOverride }),
    },
    project: {
      // Record stateRoot so serve discovery (which scans by project root)
      // finds this session under the agent's home, not the cwd the user
      // happened to be in.
      root: projectContext.stateRoot,
      cwd: projectContext.cwd,
    },
  });

  const messageID = await sessionManager.createMessage(sessionID, agentId, {
    user: {
      prompt: {
        task,
        ...(userPrompt && { user: userPrompt }),
      },
    },
    assistant: {
      system: systemMessages,
      modelID: agent.config.model,
      providerID: resolveModelProvider(agent.config.model),
      mode: 'build',
      path: { cwd: projectContext.cwd, root: projectContext.projectRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });

  return { sessionID, messageID };
}

/** Default ceiling on log parts persisted per session. Each part is its own
 * JSON file AND the live session-status poll re-reads every part each tick while
 * a run is active, so this bounds both disk sprawl and per-tick read cost. A few
 * hundred lines is plenty for a diagnostic stream; raise via env if needed. */
const DEFAULT_SESSION_LOG_LIMIT = 300;

function resolveSessionLogLimit(): number {
  const raw = process.env.AGENTUSE_SESSION_LOG_LIMIT;
  if (raw) {
    const parsed = parseInt(raw, 10);
    if (Number.isFinite(parsed) && parsed > 0) return parsed;
  }
  return DEFAULT_SESSION_LOG_LIMIT;
}

const KNOWN_LOG_LEVELS: ReadonlySet<LogPartLevel> = new Set(['debug', 'info', 'warn', 'error', 'system']);

/** A log part rendered for the session view: validated level + split title/body. */
export interface LogPartView {
  level: LogPartLevel;
  title: string;
  message?: string;
}

/**
 * Map a persisted `log` part to its session-view shape. Single-line messages
 * become the title alone; multi-line messages keep the first line as the title
 * and the remainder as content. `level` is validated against the known set
 * because it flows into a `log-level-${level}` CSS class on the client. Pure and
 * shared by the serve web log (index.ts) and unit-tested directly.
 */
export function describeLogPart(part: { level?: unknown; message?: unknown }): LogPartView {
  const level: LogPartLevel = KNOWN_LOG_LEVELS.has(part.level as LogPartLevel)
    ? (part.level as LogPartLevel)
    : 'info';
  const text = (typeof part.message === 'string' ? part.message : '').replace(/\s+$/, '');
  const newline = text.indexOf('\n');
  const title = newline === -1 ? text : text.slice(0, newline);
  const rest = newline === -1 ? undefined : text.slice(newline + 1);
  return { level, title: title || level, ...(rest ? { message: rest } : {}) };
}

export interface SessionLogSink {
  /** Pass to `runWithLogSink` to capture the run's operational logs. */
  capture: (record: LogRecord) => void;
  /** Drain any buffered records to disk. Call before the run/session ends. */
  flush: () => Promise<void>;
}

/**
 * Build a sink that mirrors a run's operational logs (logger.debug/info/warn/
 * error/system) into the session as `log` parts, so the CLI's diagnostic stream
 * shows up in `agentuse sessions` and the serve web session view. Records are
 * buffered and drained by a single async loop (natural batching under load),
 * persistence runs detached from capture so a failed write can't feed itself,
 * and the total is capped: past the cap a single truncation marker is written
 * and further lines are dropped. Entirely best-effort: writes that fail are
 * swallowed and never affect the run.
 */
export function createSessionLogSink(
  sessionManager: SessionManager,
  sessionID: string,
  agentId: string,
  messageID: string,
  options?: { limit?: number },
): SessionLogSink {
  const limit = options?.limit ?? resolveSessionLogLimit();
  let pending: LogRecord[] = [];
  let drainPromise: Promise<void> | null = null;
  let persistedCount = 0;
  let truncationNoted = false;

  const addLogPart = async (level: LogPartLevel, message: string, time: number, toolId?: string): Promise<void> => {
    // `satisfies` shape-checks the log part; the cast is required because
    // addPart's `Omit<Part, ...>` collapses the discriminated union to its
    // shared keys (the learning/error markers cast the same way).
    const partData = {
      type: 'log',
      level,
      message,
      ...(toolId && { toolId }),
      time: { start: time },
    } satisfies Omit<LogPart, 'id' | 'sessionID' | 'messageID'>;
    await sessionManager.addPart(sessionID, agentId, messageID, partData as Omit<Part, 'id' | 'sessionID' | 'messageID'>);
  };

  const persist = (records: LogRecord[]): Promise<void> =>
    // Detach the sink: addPart's best-effort failure path logs via logger.debug,
    // which would otherwise be re-captured here and grow unboundedly.
    withoutLogSink(async () => {
      for (const record of records) {
        if (persistedCount >= limit) {
          if (!truncationNoted) {
            truncationNoted = true;
            try {
              await addLogPart('warn', `Session log capture truncated after ${limit} entries.`, record.time);
            } catch { /* best-effort */ }
          }
          return;
        }
        try {
          await addLogPart(record.level, record.message, record.time, record.toolId);
          persistedCount += 1;
        } catch { /* best-effort: drop this line */ }
      }
    });

  // A single in-flight drain processes pending in FIFO batches; concurrent
  // callers share the same promise so capture order is preserved.
  const drain = (): Promise<void> => {
    if (drainPromise) return drainPromise;
    drainPromise = (async () => {
      try {
        while (pending.length > 0) {
          const batch = pending;
          pending = [];
          await persist(batch);
        }
      } finally {
        drainPromise = null;
      }
    })();
    return drainPromise;
  };

  return {
    capture: (record) => {
      // Stop buffering once the cap is reached (one truncation marker still flushes).
      if (persistedCount >= limit && truncationNoted) return;
      pending.push(record);
      void drain();
    },
    flush: async () => {
      // Await the active drain; records can arrive while it runs, so loop until
      // both the in-flight drain and the buffer are fully settled.
      while (drainPromise || pending.length > 0) {
        await drain();
      }
    },
  };
}

/**
 * Persist the corrections a run started with, so the session log says what was
 * applied and — the part that was previously invisible — what the cap left out.
 *
 * Recorded here rather than logged from the injection site because injection
 * happens inside `prepareAgentExecution`, which returns before the per-run log
 * sink is attached: anything it writes goes to stderr and nowhere else.
 *
 * Silent when nothing was applied. A run with no corrections has nothing to
 * report, and a row saying so on every run of every agent that has never been
 * corrected is noise in the one place that should be signal.
 *
 * Best-effort: a failed write never affects the run.
 */
export async function recordCorrectionsMarker(
  sessionManager: SessionManager,
  sessionID: string,
  agentId: string,
  messageID: string,
  applied: number,
  active: number,
  cap: number,
): Promise<void> {
  if (applied <= 0) return;
  try {
    await sessionManager.addPart(sessionID, agentId, messageID, {
      type: 'corrections',
      applied,
      active,
      cap,
      time: { start: Date.now() },
    } as Omit<Part, 'id' | 'sessionID' | 'messageID'>);
  } catch (error) {
    logger.debug(`Failed to persist corrections marker: ${(error as Error).message}`);
  }
}

/**
 * Persist a learning marker part so the result of a capture attempt is visible
 * in the session log (CLI, `agentuse sessions`, and the serve web view). Mirrors
 * the compaction marker. Best-effort: a failed write never affects the run.
 */
export async function recordLearningMarker(
  sessionManager: SessionManager,
  sessionID: string,
  agentId: string,
  messageID: string,
  outcome: LearningOutcome,
): Promise<void> {
  try {
    await sessionManager.addPart(sessionID, agentId, messageID, {
      type: 'learning',
      status: outcome.status,
      source: outcome.source,
      count: outcome.count,
      ...(outcome.titles.length > 0 && { titles: outcome.titles }),
      ...(outcome.detail && { detail: outcome.detail }),
      time: { start: Date.now() },
    } as Omit<Part, 'id' | 'sessionID' | 'messageID'>);
  } catch (error) {
    logger.debug(`Failed to persist learning marker: ${(error as Error).message}`);
  }
}

/**
 * Persist a learning marker when the assistant message id is not directly in
 * scope (the approval-comment promotion paths). Attaches to the session's most
 * recent message. Best-effort; never throws.
 */
export async function recordLearningMarkerForLatestMessage(
  sessionManager: SessionManager,
  sessionID: string,
  agentId: string,
  outcome: LearningOutcome,
): Promise<void> {
  try {
    const messages = await sessionManager.getSessionMessages(sessionID, agentId);
    const latest = messages[messages.length - 1];
    if (!latest) return;
    await recordLearningMarker(sessionManager, sessionID, agentId, latest.id, outcome);
  } catch (error) {
    logger.debug(`Failed to persist approval learning marker: ${(error as Error).message}`);
  }
}

/**
 * The reviewer feedback behind a run: every resolved approval gate that carried
 * a comment, paired with the work shown at that gate. Empty when the run had no
 * commented gates (a plain un-gated run, or bare approvals). Best-effort —
 * capture must degrade gracefully when a session is sparse.
 */
export interface ApprovalContext {
  reviews: ApprovalReview[];
  /**
   * Gates a human actually resolved this run, commented or not.
   *
   * `reviews` alone cannot distinguish "a reviewer approved without saying
   * anything" from "nobody reviewed this at all", and the difference is the
   * whole signal: the first is a vote of confidence in every rule that was in
   * force, the second is no evidence whatsoever.
   */
  humanGates: number;
}

/** One durable human decision supplied to gate pre-review. Machine bounces are
 * excluded so a judge never treats its own earlier critique as human policy. */
export interface HumanApprovalDecision {
  status: 'approved' | 'commented' | 'rejected';
  choice?: string;
  comment?: string;
  reviewer?: string;
  work?: string;
}

/** Truncate a value for the approval-context prompt without breaking on objects. */
function approvalText(value: unknown, limit: number): string | undefined {
  const str = typeof value === 'string' ? value.trim() : '';
  if (!str) return undefined;
  return str.length > limit ? `${str.slice(0, limit)}...(truncated)` : str;
}

/**
 * Render the await_human gate input (what the reviewer read) into a compact
 * Markdown block. Pulls the human-facing, text-bearing fields only; URLs and
 * artifact paths are dropped since the model can't follow them.
 */
export function formatReviewedWork(input: unknown): string | undefined {
  if (!input || typeof input !== 'object') return undefined;
  const i = input as Record<string, unknown>;
  const sections: string[] = [];
  const add = (label: string, value: unknown, limit: number) => {
    const text = approvalText(value, limit);
    if (text) sections.push(`${label}: ${text}`);
  };
  add('Question', i.prompt, 500);
  const reference = i.reference && typeof i.reference === 'object' ? i.reference as Record<string, unknown> : {};
  add(`Original (${typeof reference.label === 'string' && reference.label ? reference.label : 'in reply to'})`, reference.excerpt, 1000);
  const optionLabels = new Map<string, string>();
  if (Array.isArray(i.options)) {
    for (const option of i.options) {
      const rec = option && typeof option === 'object' ? option as Record<string, unknown> : {};
      if (typeof rec.id !== 'string' || !rec.id.trim()) continue;
      optionLabels.set(
        rec.id.trim(),
        typeof rec.label === 'string' && rec.label.trim() ? rec.label.trim() : rec.id.trim(),
      );
    }
  }
  if (Array.isArray(i.changes)) {
    i.changes.forEach((entry, index) => {
      const rec = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      const label = typeof rec.label === 'string' && rec.label ? rec.label : `Change ${index + 1}`;
      const optionId = typeof rec.optionId === 'string' && rec.optionId.trim() ? rec.optionId.trim() : undefined;
      const scopedLabel = optionId
        ? `${label} (choice: ${optionLabels.get(optionId) ?? optionId} [${optionId}])`
        : label;
      const displayContent = typeof rec.displayContent === 'string' && rec.displayContent.trim()
        ? rec.displayContent
        : undefined;
      add(scopedLabel, displayContent ?? rec.content, 2000);
      if (displayContent) add(`${scopedLabel} — exact command`, rec.content, 2000);
    });
  }
  add('Summary', i.summary, 1500);
  add('Draft', i.draft, 4000);
  add('Context', i.context, 1500);
  add('Risk', i.risk, 1000);
  return sections.length > 0 ? sections.join('\n\n') : undefined;
}

/**
 * Whether a resolved gate's output records a decision by a HUMAN.
 *
 * Several non-human writers resolve `await_human` parts with the same shape: the
 * pre-review judge, gate preflight, and the runtime itself. Anywhere a person's
 * judgement is what carries weight, those have to be excluded. Two callers need
 * it: the approval history shown to the judge, and learning capture, where a
 * comment is stored as a confidence-0.95 reviewer correction that outranks
 * everything the agent concluded on its own. Without this filter the runtime's
 * own diagnostics and the judge's critiques were saved as human corrections.
 */
export function isHumanGateDecision(output: unknown): boolean {
  if (!output || typeof output !== 'object') return false;
  const record = output as Record<string, unknown>;
  const source = typeof record.source === 'string' ? record.source : undefined;
  const reviewerRecord = record.reviewer && typeof record.reviewer === 'object'
    ? record.reviewer as Record<string, unknown>
    : {};
  const reviewer = typeof reviewerRecord.username === 'string'
    ? reviewerRecord.username
    : typeof reviewerRecord.name === 'string'
      ? reviewerRecord.name
      : undefined;
  return !(
    source === 'pre-review'
    || source === 'gate-preflight'
    || reviewer === 'verify-judge'
    || reviewer === 'agentuse-runtime'
  );
}

function normalizedHumanDecision(output: unknown): Omit<HumanApprovalDecision, 'work'> | undefined {
  if (!isHumanGateDecision(output)) return undefined;
  const record = output as Record<string, unknown>;
  const reviewerRecord = record.reviewer && typeof record.reviewer === 'object'
    ? record.reviewer as Record<string, unknown>
    : {};
  const reviewer = typeof reviewerRecord.username === 'string'
    ? reviewerRecord.username
    : typeof reviewerRecord.name === 'string'
      ? reviewerRecord.name
      : undefined;

  const rawStatus = typeof record.status === 'string' ? record.status.toLowerCase() : '';
  const status = rawStatus === 'approve' || rawStatus === 'approved'
    ? 'approved'
    : rawStatus === 'comment' || rawStatus === 'commented'
      ? 'commented'
      : rawStatus === 'reject' || rawStatus === 'rejected'
        ? 'rejected'
        : undefined;
  if (!status) return undefined;
  const choice = typeof record.choice === 'string' && record.choice.trim()
    ? record.choice.trim()
    : undefined;
  const comment = typeof record.comment === 'string' && record.comment.trim()
    ? record.comment.trim()
    : undefined;
  return {
    status,
    ...(choice && { choice }),
    ...(comment && { comment }),
    ...(reviewer && { reviewer }),
  };
}

/** Gather the latest completed human gate decisions for the same session. The
 * gate currently being judged is still running, so it is naturally excluded. */
export async function gatherHumanApprovalHistory(
  sessionManager: SessionManager,
  sessionID: string,
  agentId: string,
  options: { limit?: number } = {},
): Promise<HumanApprovalDecision[]> {
  try {
    const decisions: HumanApprovalDecision[] = [];
    const messages = await sessionManager.getSessionMessages(sessionID, agentId);
    for (const message of messages) {
      const parts = await sessionManager.getMessageParts(sessionID, agentId, message.id);
      for (const part of parts) {
        if (part.type !== 'tool' || part.tool !== 'await_human') continue;
        const gate = part as ToolPart;
        if (gate.state.status !== 'completed') continue;
        const decision = normalizedHumanDecision(gate.state.output);
        if (!decision) continue;
        const work = formatReviewedWork(gate.state.input);
        decisions.push({ ...decision, ...(work && { work }) });
      }
    }
    return decisions.slice(-Math.max(1, options.limit ?? 8));
  } catch (error) {
    logger.debug(`Failed to gather human approval history: ${(error as Error).message}`);
    return [];
  }
}

/** Pull a non-empty reviewer comment out of a resolved gate's decision output. */
function readGateComment(output: unknown): string | undefined {
  if (!output || typeof output !== 'object') return undefined;
  const comment = (output as Record<string, unknown>).comment;
  return typeof comment === 'string' && comment.trim().length > 0 ? comment.trim() : undefined;
}

/**
 * Gather every reviewer comment across a run's resolved approval gates, each
 * paired with the work shown at that gate, so the learning evaluator can ground
 * a deictic comment ("this is too long") in the actual output instead of judging
 * it in a vacuum. When the lifecycle supplies a message id, scans only that
 * run's message: a revise loop keeps all its gates there, while comments from
 * prior continuations must not be captured again.
 *
 * Best-effort: returns `{ reviews: [] }` on any failure. Capturing learnings
 * must never break a run.
 */
export async function gatherApprovalContext(
  sessionManager: SessionManager,
  sessionID: string,
  agentId: string,
  messageId?: string,
): Promise<ApprovalContext> {
  try {
    const messages = await sessionManager.getSessionMessages(sessionID, agentId);
    const inRun = messageId ? messages.filter((message) => message.id === messageId) : messages;
    const reviews: ApprovalReview[] = [];
    let humanGates = 0;
    for (const message of inRun) {
      const parts = await sessionManager.getMessageParts(sessionID, agentId, message.id);
      for (const part of parts) {
        if (part.type !== 'tool' || part.tool !== 'await_human') continue;
        const gate = part as ToolPart;
        if (gate.state.status !== 'completed') continue;
        // Only a human's comment may become an "approval" learning. The judge,
        // gate preflight and the runtime all resolve gates with this same shape,
        // and their comments were being captured as confidence-0.95 human
        // corrections that then outrank the agent's own conclusions.
        if (!isHumanGateDecision(gate.state.output)) continue;
        humanGates++;
        const comment = readGateComment(gate.state.output);
        if (!comment) continue;
        const work = formatReviewedWork(gate.state.input);
        reviews.push({ comment, ...(work && { work }) });
      }
    }
    return { reviews, humanGates };
  } catch (error) {
    logger.debug(`Failed to gather approval context: ${(error as Error).message}`);
    return { reviews: [], humanGates: 0 };
  }
}

export interface ErrorMarkerInfo {
  source: ErrorPartSource;
  message: string;
  code?: string | undefined;
  detail?: string | undefined;
  statusCode?: number | undefined;
}

/**
 * Render an error marker into a one-line title + message for the session log.
 * Shared by the CLI session view and the serve web log. Prefers the provider
 * response body (the actual cause) over the generic error message.
 */
export function describeErrorPart(info: {
  source: ErrorPartSource;
  code?: string | undefined;
  message: string;
  detail?: string | undefined;
  statusCode?: number | undefined;
}): { title: string; message: string } {
  const title = info.source === 'compaction'
    ? 'Context compaction failed'
    : info.code
      ? `Run error (${info.code})`
      : 'Run error';
  const statusPrefix = typeof info.statusCode === 'number' ? `HTTP ${info.statusCode}: ` : '';
  const body = info.detail && info.detail.trim().length > 0 ? info.detail : info.message;
  return { title, message: `${statusPrefix}${body}` };
}

/**
 * Persist an error marker part so a model/AI-SDK failure is visible in the
 * session log (with the provider's response body, not just "Bad Request").
 * Mirrors the compaction/learning markers. Best-effort: never throws.
 */
export async function recordErrorMarker(
  sessionManager: SessionManager,
  sessionID: string,
  agentId: string,
  messageID: string,
  info: ErrorMarkerInfo,
): Promise<void> {
  try {
    await sessionManager.addPart(sessionID, agentId, messageID, {
      type: 'error',
      source: info.source,
      message: info.message,
      ...(info.code && { code: info.code }),
      ...(info.detail && { detail: info.detail }),
      ...(typeof info.statusCode === 'number' && { statusCode: info.statusCode }),
      time: { start: Date.now() },
    } as Omit<Part, 'id' | 'sessionID' | 'messageID'>);
  } catch (error) {
    logger.debug(`Failed to persist error marker: ${(error as Error).message}`);
  }
}

/**
 * Persist an error marker when the assistant message id is not directly in
 * scope (the top-level run catch). Attaches to the session's most recent
 * message. Best-effort; never throws.
 */
export async function recordErrorMarkerForLatestMessage(
  sessionManager: SessionManager,
  sessionID: string,
  agentId: string,
  info: ErrorMarkerInfo,
): Promise<void> {
  try {
    const messages = await sessionManager.getSessionMessages(sessionID, agentId);
    const latest = messages[messages.length - 1];
    if (!latest) return;
    await recordErrorMarker(sessionManager, sessionID, agentId, latest.id, info);
  } catch (error) {
    logger.debug(`Failed to persist run error marker: ${(error as Error).message}`);
  }
}
