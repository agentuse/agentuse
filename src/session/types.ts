import { z } from 'zod';
import type { ModelFallbackPolicy, RunModelOverride } from '../utils/model-alias';

// Deep partial type for updates
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

// Session Info Schema
export type SessionStatus = 'running' | 'completed' | 'error' | 'suspended';

// How a run was triggered. Drives filtering on the /sessions operator surface.
// 'manual' is the default for CLI direct runs, subagents, and the HTTP run
// endpoint when no origin is specified; serve sets 'scheduled' / 'api' / 'slack'
// where it knows the origin.
export type SessionTrigger = 'scheduled' | 'manual' | 'slack' | 'api';

export interface SessionInfo {
  id: string;                        // ULID
  parentSessionID?: string;          // For subagent sessions - links to parent agent session
  status: SessionStatus;             // Session completion status
  trigger: SessionTrigger;           // How this run was triggered (defaults to 'manual')

  // Agent metadata
  agent: {
    id: string;                      // Agent ID (relative path without extension, e.g., "social/quotes/1-quotes-create")
    name: string;                    // Agent display name from YAML
    filePath?: string;               // Path to .agentuse file (if local)
    description?: string;            // Agent description from YAML
    isSubAgent: boolean;             // True if this is a subagent execution
  };

  // Model and version
  model: string;                     // Full model identifier (e.g., "anthropic:claude-sonnet-4-0")
  version: string;                   // agentuse version
  mock?: boolean;                    // True when run under --mock (tool outputs are LLM-generated)

  // Configuration (from agent YAML)
  config: {
    timeout?: number;                // Timeout in seconds
    maxSteps?: number;               // Max steps configured
    mcpServers?: string[];           // MCP server names (keys from mcpServers object)
    subagents?: Array<{              // Subagent definitions
      path: string;
      name?: string;
    }>;
    /** Explicit run-wide model override; absent for ordinary agent config. */
    modelOverride?: RunModelOverride;
    /** Ordered fallback policy captured at session creation for durable resume. */
    modelFallback?: ModelFallbackPolicy;
  };

  // Project context
  project: {
    root: string;                    // Project root directory (from findProjectRoot)
    cwd: string;                     // Working directory when agent started
  };

  // Timing
  time: {
    created: number;                 // Unix timestamp (ms)
    updated: number;                 // Unix timestamp (ms)
  };

  // Process currently executing this run (single-machine storage). Stamped at
  // create and on every flip back to 'running', so the orphan sweep can skip a
  // 'running' session whose owning process (a terminal `agentuse run`, another
  // daemon) is still alive. Absent on sessions written by older versions.
  owner?: {
    pid: number;
    procStartedAt?: string;          // start-time token guarding recycled PIDs
  };

  // Error (for failures before LLM calls - auth, MCP, etc.)
  // Standard error codes:
  //   - AUTH_ERROR: Authentication failure (missing/invalid API key)
  //   - MCP_ERROR: MCP server connection failure
  //   - CONFIG_ERROR: Agent configuration error
  //   - TIMEOUT: Agent execution timed out
  //   - USER_INTERRUPT: User interrupted execution (Ctrl+C or SIGTERM)
  //   - WORKER_INTERRUPTED: serve worker died mid-run/mid-resume (daemon restart or
  //                         crash), leaving the session stuck 'running' with no live
  //                         process; reconciled on the next worker (re)spawn so the
  //                         reopen-gate recovery path becomes reachable
  //   - EXECUTION_ERROR: General execution error
  //   - INCOMPLETE: The agent itself declared the run incomplete via the
  //                 report_incomplete tool — it finished cleanly but did not
  //                 achieve its objective (e.g. blocked on a dead login).
  //                 Rendered as its own "incomplete" label, not a crash.
  error?: {
    message: string;
    code: string;
    time: number;                    // Unix timestamp (ms)
    // Provider/API call detail, when the failure came from an LLM API call.
    // Captured so a generic message like "Bad Request" is actually diagnosable.
    statusCode?: number;             // HTTP status from the provider (e.g. 400)
    url?: string;                    // Endpoint that rejected the request
    detail?: string;                 // Provider response body (truncated)
  };

  // Reviewer acknowledgment of an ended failed run: set when the reviewer
  // discards it (web Discard button / `sessions stop` on an ended session).
  // Clears the run from needs-attention surfaces without rewriting the true
  // outcome in status/error.
  dismissedAt?: number;

  // Outcome of the verify feature's final judgment on this run. `failed` means
  // the output shipped despite exhausting redos (or the judge itself erroring)
  // — a needs-attention signal, not a crash. Absent when verify is off.
  verification?: {
    status: 'passed' | 'failed' | 'error';
    redoCount: number;                 // redos actually performed this run
    critique?: string;                 // last failing critique / judge error detail
    time: number;                      // Unix timestamp (ms) of the final verdict
  };

  /** Runtime-authored metadata for observability surfaces. Unlike agent
   * configuration, this describes why this particular session exists. Fields
   * are optional so historical sessions remain fully readable. */
  observability?: {
    role?: 'verify-judge';
    /** Zero-based verify attempt (0 = first candidate output). */
    attempt?: number;
    /** Total candidate outputs allowed, including the first attempt. */
    maxAttempts?: number;
  };

  // Durable channel anchors. These let resume/follow-up paths update the same
  // external thread even when they run in a different serve worker.
  channels?: {
    slack?: Array<{
      channel: string;               // Slack channel/conversation id
      ts: string;                    // Root message timestamp for this session
      channelId?: string;            // Configured channel id, when distinct/known
      events: Array<'approval' | 'completion' | 'failure'>;
    }>;
  };
}

export interface ActiveContextUsage {
  activeTokens: number;
  contextLimit?: number;
  usagePercentage: number;
  compacted: boolean;
  compactions: number;
  updatedAt: number;
}

export interface ContextSnapshot {
  version: 1;
  updatedAt: number;
  messageID?: string;
  messages: unknown[];
  usage: ActiveContextUsage;
}

// Message Schema (contains both user input and assistant response in one exchange)
export interface Message {
  id: string;                        // Message exchange ID
  sessionID: string;
  time: {
    created: number;                 // When user sent message
    completed?: number;              // When assistant finished
  };

  // User input
  user: {
    prompt: {
      task: string;                  // From .agentuse markdown body
      user?: string;                 // From CLI args (optional)
    };
  };

  // Assistant response
  assistant: {
    system: string[];                // System prompts used
    modelID: string;
    providerID: string;
    mode: string;                    // 'build', 'plan', etc.
    path: {
      cwd: string;
      root: string;
    };
    cost: number;
    tokens: {
      input: number;
      output: number;
      reasoning: number;
      cache: {
        read: number;
        write: number;
      };
    };
    error?: {
      message: string;
      type?: string;
      stack?: string;
    };
    context?: ActiveContextUsage;
    summary?: boolean;
  };
}

// Zod validation schema for Message
export const MessageSchema = z.object({
  id: z.string(),
  sessionID: z.string(),
  time: z.object({
    created: z.number(),
    completed: z.number().optional(),
  }),
  user: z.object({
    prompt: z.object({
      task: z.string(),
      user: z.string().optional(),
    }),
  }),
  assistant: z.object({
    system: z.array(z.string()),
    modelID: z.string(),
    providerID: z.string(),
    mode: z.string(),
    path: z.object({
      cwd: z.string(),
      root: z.string(),
    }),
    cost: z.number(),
    tokens: z.object({
      input: z.number(),
      output: z.number(),
      reasoning: z.number(),
      cache: z.object({
        read: z.number(),
        write: z.number(),
      }),
    }),
    error: z.object({
      message: z.string(),
      type: z.string().optional(),
      stack: z.string().optional(),
    }).optional(),
    context: z.object({
      activeTokens: z.number(),
      contextLimit: z.number().optional(),
      usagePercentage: z.number(),
      compacted: z.boolean(),
      compactions: z.number(),
      updatedAt: z.number(),
    }).optional(),
    summary: z.boolean().optional(),
  }),
});

// Part Base - all parts include these fields
export interface PartBase {
  id: string;        // Part ID (ULID)
  sessionID: string; // Session this part belongs to
  messageID: string; // Message this part belongs to
  /**
   * This part belongs to an attempt that was rewound (see reopenSuspendedGate):
   * it stays in the durable log so the human can read what the failed attempt
   * did, but `rehydrateMessages` excludes it from the model-facing history so
   * the retry replays from the gate rather than from the abandoned tail.
   */
  superseded?: boolean;
}

// Tool State - discriminated union for type safety
export type ToolStatePending = {
  status: 'pending';
  input?: unknown;
  metadata?: Record<string, unknown>;
  suspendedAt?: number;
  resumePayload?: {
    // 'await_human': a real human gate (the leaf's await_human tool part).
    // 'subagent_wait': a parent's subagent__* step parked on a delegated child's
    // gate — no human-facing fields, just childSessionID for the cascade descent.
    kind: 'await_human' | 'subagent_wait';
    prompt?: string;
    channel?: string;
    approvalUrl?: string;
    expiresAt?: number;
    resumeToken?: string;
    channelMessage?: {
      type: 'slack-message';
      ts?: string;
      actionTs?: string;
      channel?: string;
      url?: string;
    };
    /** await_human only: gate-time snapshots of referenced media (session/gate-artifacts). */
    artifactSnapshots?: Array<{ path: string; hash: string; ext: string; bytes: number }>;
    // subagent_wait only: the suspended child gate this step is parked on.
    childSessionID?: string;
    childAgentName?: string;
  };
};

export type ToolStateRunning = {
  status: 'running';
  input: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
  };
};

export type ToolOutputArtifactRef = {
  kind: 'tool-output';
  path: string;
  absolutePath: string;
  bytes: number;
  originalChars: number;
};

export type ModelToolOutputArtifactRef = Omit<ToolOutputArtifactRef, 'absolutePath'>;

export type ToolOutputArtifactStream = {
  write(chunk: string): void;
  finalize(): Promise<ToolOutputArtifactRef>;
  discard(): Promise<void>;
};

export type ToolStateCompleted = {
  status: 'completed';
  input: unknown;
  output: unknown;
  title?: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end: number;
  };
};

export type ToolStateError = {
  status: 'error';
  input: unknown;
  error: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end: number;
  };
};

export type ToolState = ToolStatePending | ToolStateRunning | ToolStateCompleted | ToolStateError;

export interface ToolsSnapshot {
  tools: Array<{
    name: string;
    description?: string;
    inputSchema?: unknown;
  }>;
  providerOptions?: unknown;
}

// Part Schemas
export type Part =
  | TextPart
  | ReasoningPart
  | ToolPart
  | FilePart
  | AgentPart
  | StepStartPart
  | StepFinishPart
  | SnapshotPart
  | PatchPart
  | CompactionPart
  | CorrectionsPart
  | LearningPart
  | VerifyPart
  | ErrorPart
  | LogPart;

/** What triggered a context compaction. */
export type CompactionReason = 'limit' | 'approval' | 'step';

/**
 * Marker recorded when the context manager compacts the active conversation,
 * so the event is visible in the session log instead of only the CLI logs.
 */
export interface CompactionPart extends PartBase {
  type: 'compaction';
  reason: CompactionReason;
  tokensBefore: number;
  tokensAfter: number;
  messagesBefore: number;
  messagesAfter: number;
  usagePercentBefore?: number;
  time: {
    start: number;
  };
}

/**
 * Marker recorded when a run starts with stored corrections applied to its
 * instructions.
 *
 * The injected text itself survives inside the persisted prompt, so the session
 * view could always show *which* corrections were in force. What it could not
 * show is what was left out: the cap is applied at run time and the counts were
 * only ever logged to stderr, so a run that applied 10 of 26 looked identical to
 * one that applied all 10 it had. Recording them makes the dormant remainder
 * visible on the run it affected, which is the only place it is actionable.
 *
 * Injection-time only. {@link LearningPart} is the other direction — corrections
 * captured *from* a finished run.
 */
export interface CorrectionsPart extends PartBase {
  type: 'corrections';
  /** Injected into this run's instructions. */
  applied: number;
  /** Active corrections stored for the agent, injected and dormant together.
   *  Excludes graduated rules (in force through the agent file) and retired
   *  ones, neither of which competes for a cap slot. */
  active: number;
  /** The per-run injection cap in force, so a report can name it. */
  cap: number;
  time: {
    start: number;
  };
}

/** Outcome of a learning capture attempt. Mirrors learning/types LearningOutcome. */
export type LearningPartStatus = 'captured' | 'none' | 'failed';
export type LearningPartSource = 'auto' | 'approval' | 'manual';

/**
 * Marker recorded after a learning capture attempt (self-evaluation or
 * approval-comment promotion), so the result — including a silent failure — is
 * visible in the session log instead of only the CLI spinner.
 */
export interface LearningPart extends PartBase {
  type: 'learning';
  status: LearningPartStatus;
  source: LearningPartSource;
  count: number;
  titles?: string[];
  detail?: string;
  time: {
    start: number;
  };
}

/** Verdict of one verify judge invocation. `error` = the judge itself failed
 * (model/parse error in `detail`) and the output shipped unverified. */
export type VerifyPartVerdict = 'pass' | 'fail' | 'error';

/**
 * Marker recorded per verify judge invocation, so each verdict — and the
 * critique that drove a redo — is visible in the session log.
 */
export interface VerifyPart extends PartBase {
  type: 'verify';
  verdict: VerifyPartVerdict;
  /** 0 = the run's first output, N = the output produced by the Nth redo. */
  attempt: number;
  maxRedos: number;
  /** The judge's critique (fail) or failure detail (error). */
  critique?: string;
  /** Judge identity: model string (built-in) or judge agent name. */
  judge?: string;
  time: {
    start: number;
  };
}

/** Where a model/AI-SDK error originated. */
export type ErrorPartSource = 'agent' | 'compaction';

/**
 * Marker recorded when a model/AI-SDK call fails, so the failure — and the
 * provider's response body, which says *why* (e.g. "Instructions are required")
 * — is visible in the session log instead of being reduced to a terse "Bad
 * Request" status pill or only a CLI warning.
 */
export interface ErrorPart extends PartBase {
  type: 'error';
  source: ErrorPartSource;
  /** Classification code, e.g. EXECUTION_ERROR / AUTH_ERROR / TIMEOUT. */
  code?: string;
  /** error.message (often a generic "Bad Request"). */
  message: string;
  /** Provider response body — the actual cause. */
  detail?: string;
  statusCode?: number;
  time: {
    start: number;
  };
}

/** Severity of an operational log line mirrored into the session view. */
export type LogPartLevel = 'debug' | 'info' | 'warn' | 'error' | 'system';

/**
 * A single operational log line (logger.debug/info/warn/error/system) captured
 * during the run and persisted so the CLI's diagnostic stream is visible in the
 * session log and the serve web view, not only on the terminal that launched
 * the run. Recorded by the per-run sink in runner/session-helper. Best-effort:
 * a failed write never affects the run.
 */
export interface LogPart extends PartBase {
  type: 'log';
  level: LogPartLevel;
  message: string;
  /** Tool call id this log line is about, set when mirrored from
   *  logger.warnWithTool. Lets the session view nest it under its tool entry. */
  toolId?: string;
  time: {
    start: number;
  };
}

export interface TextPart extends PartBase {
  type: 'text';
  text: string;
  role?: 'assistant' | 'user';
  synthetic?: boolean;
  time?: {
    start: number;
    end?: number;
  };
}

export interface ReasoningPart extends PartBase {
  type: 'reasoning';
  text: string;
  metadata?: Record<string, unknown>;
  time: {
    start: number;
    end?: number;
  };
}

export interface ToolPart extends PartBase {
  type: 'tool';
  callID: string;    // Tool call ID from AI SDK
  tool: string;      // Tool name (renamed from 'name')
  state: ToolState;  // Discriminated union
}

export interface FilePart extends PartBase {
  type: 'file';
  mime: string;
  filename?: string;
  url: string;
  source?: {
    type: 'file' | 'symbol';
    path: string;
    text?: {
      value: string;
      start: number;
      end: number;
    };
  };
}

export interface AgentPart extends PartBase {
  type: 'agent';
  name: string;
  source?: {
    value: string;
    start: number;
    end: number;
  };
}

export interface StepStartPart extends PartBase {
  type: 'step-start';
}

export interface StepFinishPart extends PartBase {
  type: 'step-finish';
  cost: number;
  tokens: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
}

export interface SnapshotPart extends PartBase {
  type: 'snapshot';
  snapshot: string;
}

export interface PatchPart extends PartBase {
  type: 'patch';
  hash: string;
  files: string[];
}
