import type { LanguageModelUsage, ModelMessage, ToolSet } from 'ai';
import type { ParsedAgent } from '../parser';
import type { MCPConnection } from '../mcp';
import type { ToolCallTrace } from '../plugin/types';
import type { DoomLoopDetector } from '../tools/index.js';
import type { SessionManager } from '../session';
import type { ActiveContextUsage, ContextSnapshot, SessionTrigger } from '../session/types';
import type { AssistantTokens } from '../session/usage';

export type UsageKind = 'cumulative' | 'step';

export interface PrepareAgentOptions {
  agent: ParsedAgent;
  mcpClients: MCPConnection[];
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
  doomLoopDetector: DoomLoopDetector;
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
}

export interface AgentChunk {
  type: 'text' | 'tool-call' | 'tool-result' | 'tool-error' | 'finish' | 'usage' | 'error' | 'suspended' | 'llm-start' | 'llm-first-token';
  text?: string;
  toolName?: string;
  toolCallId?: string;      // Tool call ID from AI SDK
  toolInput?: unknown;
  toolResult?: string;
  toolResultRaw?: unknown;
  error?: unknown;
  finishReason?: string;
  usage?: LanguageModelUsage;
  usageKind?: UsageKind;
  contextUsage?: ActiveContextUsage;
  contextSnapshot?: ContextSnapshot;
  toolStartTime?: number;  // Track when tool started
  toolDuration?: number;    // Duration in ms
  isSubAgent?: boolean;     // Track if this tool is a subagent
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
  status?: 'completed' | 'suspended';
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
}
