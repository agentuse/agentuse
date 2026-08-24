import type { LanguageModelUsage, ModelMessage, ToolSet } from 'ai';
import type { ParsedAgent } from '../parser';
import type { MCPConnection } from '../mcp';
import type { ToolCallTrace } from '../plugin/types';
import type { DoomLoopDetector } from '../tools/index.js';
import type { SessionManager } from '../session';
import type { ActiveContextUsage, ContextSnapshot, SessionTrigger } from '../session/types';
import type { AssistantTokens } from '../session/usage';
import type { RunOutcome } from '../tools/report-outcome.js';
import type { EffectWAL } from './effect-wal';
import type { LiveToolOutputRelay } from './live-tool-output';
import type { RunModelOverride } from '../utils/model-alias';

export type UsageKind = 'cumulative' | 'step';

export interface PrepareAgentOptions {
  agent: ParsedAgent;
  mcpClients: MCPConnection[];
  /**
   * A model override explicitly supplied for this run (CLI/API), propagated to
   * every delegated agent. Omit for an agent's ordinary configured model: a
   * parent's frontmatter must not overwrite each child's own `model:` field.
   * Keep the resolved snapshot so nested children retain the complete fallback
   * policy instead of inheriting one selected candidate or re-reading aliases.
   */
  subagentModelOverride?: RunModelOverride | undefined;
  agentFilePath?: string | undefined;
  cliMaxSteps?: number | undefined;
  sessionManager?: SessionManager | undefined;
  projectContext?: { projectRoot: string; stateRoot: string; cwd: string } | undefined;
  userPrompt?: string | undefined;
  abortSignal?: AbortSignal | undefined;
  verbose?: boolean | undefined;
  existingSessionId?: string | undefined;
  prebuiltMessages?: ModelMessage[] | undefined;
  /** How this run was triggered. Only the fresh-session path records it. */
  trigger?: SessionTrigger | undefined;
  /**
   * Pre-assign the id for a fresh session instead of generating a ULID. Used by
   * serve's detached run so the client receives the session id up front and can
   * navigate to the live session view before the run produces anything. Ignored
   * when `existingSessionId` is set (resume/continue reuse the existing id).
   */
  newSessionId?: string | undefined;
}

export interface PreparedAgentExecution {
  tools: ToolSet;
  systemMessages: Array<{ role: string; content: string }>;
  userMessage: string;
  cacheableUserMessage?: string | undefined;
  messages?: ModelMessage[] | undefined;
  maxSteps: number;
  subAgentNames: Set<string>;
  sessionID?: string | undefined;
  assistantMsgID?: string | undefined;
  /**
   * Cumulative token total already persisted on the primary message from prior
   * invocations (only set when resuming an existing session). Folded into every
   * usage write so the session token count stays cumulative across approval
   * suspend/resume boundaries instead of resetting to the resumed run's usage.
   */
  priorTokens?: AssistantTokens | undefined;
  /** Agent ID (file-path-based identifier for session directory naming) */
  agentId?: string | undefined;
  /**
   * Per-run outcome written by the `report_incomplete` / `report_complete`
   * tools. Checked after a clean finish: when `incomplete` is set the session is
   * marked error/INCOMPLETE and failure channels fire instead of completion;
   * `complete.headline` becomes the run's one-line outcome. Optional so
   * hand-built preparations (tests) stay valid; prepareAgentExecution always
   * sets it.
   */
  runOutcome?: RunOutcome | undefined;
  doomLoopDetector: DoomLoopDetector;
  /**
   * Per-session effect WAL (tool executes + bash spawn/exit records), already
   * threaded into the bash tool as its audit sink. Pass into executeAgentCore
   * so tool executes are journaled too. Optional so hand-built preparations
   * (tests) stay valid; prepareAgentExecution always sets it.
   */
  effectWal?: EffectWAL | undefined;
  /**
   * Relay carrying a running tool's output tail to the session view, already
   * threaded into the tools. Pass into processAgentStream so it binds the
   * consumer that owns the tool parts; without it, tails are dropped and the
   * session view just shows the call as running (pre-existing behavior).
   */
  liveToolOutput?: LiveToolOutputRelay | undefined;
  /** Cleanup function to release resources (store locks, etc.) - call when agent execution completes */
  cleanup: () => Promise<void>;
  /**
   * Release only the store lock, early and idempotently. Call this immediately
   * before flipping the session status (completed/suspended) so a session never
   * appears "done" while still holding the lock - that window let the next run's
   * acquire overlap this run's release. `cleanup` calls it again, which is safe.
   */
  releaseStoreLock: () => Promise<void>;
  /** Number of learnings applied to this run (0 if learning.apply is disabled) */
  learningsApplied: number;
  /** Number of ACTIVE learnings stored for the agent. Higher than
   *  `learningsApplied` means the injection cap left the remainder dormant for
   *  this run. Excludes graduated rules (in force via the agent file) and
   *  retired ones. */
  learningsStored: number;
  /** The injection cap in force for this run (`learning.max`, else the default).
   *  Carried so the session log can name the number that made the difference
   *  rather than leaving "10 of 26" to be explained. */
  learningsCap: number;
  /** Ids injected this run, so a run a human approves without comment can credit
   *  exactly the rules that were in force for it. */
  learningsInjectedIds: string[];
}

export interface AgentChunk {
  type: 'text' | 'reasoning' | 'tool-call' | 'tool-result' | 'tool-error' | 'finish' | 'usage' | 'error' | 'suspended' | 'llm-start' | 'llm-first-token';
  text?: string;
  /** Provider block id grouping a reasoning stream; deltas with the same id
   *  belong to one ReasoningPart. Set on `type: 'reasoning'` chunks. */
  reasoningId?: string;
  /** Marks the end of a reasoning block (reasoning-end), so the consumer can
   *  finalize the part. No `text` delta accompanies this. */
  reasoningDone?: boolean;
  toolName?: string;
  toolCallId?: string;      // Tool call ID from AI SDK
  toolInput?: unknown;
  toolResult?: string;
  toolResultRaw?: unknown;
  /** Canonical success classification when the raw tool result is ambiguous. */
  toolSuccess?: boolean;
  error?: unknown;
  finishReason?: string;
  usage?: LanguageModelUsage;
  usageKind?: UsageKind;
  contextUsage?: ActiveContextUsage;
  contextSnapshot?: ContextSnapshot;
  toolStartTime?: number;  // Track when tool started
  toolDuration?: number;    // Duration in ms
  isSubAgent?: boolean;     // Track if this tool is a subagent
  /** Set on tool-call/tool-result chunks drained AFTER an approval gate
   *  registered in the same turn: the call was already dispatched by the SDK
   *  when the suspension began (agentuse-lab#165). Journaled for visibility. */
  postSuspend?: boolean;
  llmModel?: string;        // Model name for LLM traces
  llmStartTime?: number;    // When LLM call started
  llmFirstTokenTime?: number; // Time to first token
  suspend?: {
    sessionId?: string;
    toolCallId?: string;
    resumeUrl?: string;
  };
}

export interface RunAgentResult {
  status?: 'completed' | 'suspended' | 'failed';
  text: string;
  usage?: LanguageModelUsage;
  usageKind?: UsageKind;
  toolCallCount: number;
  toolCallTraces?: ToolCallTrace[];
  finishReason?: string;
  finishReasons?: string[];
  hasTextOutput: boolean;
  sessionId?: string;
  approvalUrl?: string;
  contextUsage?: ActiveContextUsage;
  /**
   * Set when the agent declared the run incomplete via `report_incomplete`:
   * the run finished cleanly but did not achieve its objective. The session is
   * persisted as error/INCOMPLETE.
   */
  incomplete?: { reason: string };
  /**
   * Set when the agent declared the run complete via `report_complete`. The
   * headline is the one-line outcome every surface shows before the body; a
   * parent reads it (with `artifacts`) instead of parsing a sub-agent's report.
   * Absent when the agent never called the tool, so consumers must fall back to
   * `text`.
   */
  complete?: { headline: string; details?: string; artifacts?: string[] };
}
