import type { LanguageModelUsage, ToolSet } from 'ai';
import type { ParsedAgent } from '../parser';
import type { MCPConnection } from '../mcp';
import type { ToolCallTrace } from '../plugin/types';
import type { DoomLoopDetector } from '../tools/index.js';
import type { SessionManager } from '../session';

export interface PrepareAgentOptions {
  agent: ParsedAgent;
  mcpClients: MCPConnection[];
  agentFilePath?: string | undefined;
  cliMaxSteps?: number | undefined;
  sessionManager?: SessionManager | undefined;
  projectContext?: { projectRoot: string; cwd: string } | undefined;
  userPrompt?: string | undefined;
  abortSignal?: AbortSignal | undefined;
  verbose?: boolean | undefined;
}

export interface PreparedAgentExecution {
  tools: ToolSet;
  systemMessages: Array<{ role: string; content: string }>;
  userMessage: string;
  maxSteps: number;
  subAgentNames: Set<string>;
  sessionID?: string | undefined;
  assistantMsgID?: string | undefined;
  /** Agent ID (file-path-based identifier for session directory naming) */
  agentId?: string | undefined;
  doomLoopDetector: DoomLoopDetector;
  /** Cleanup function to release resources (store locks, etc.) - call when agent execution completes */
  cleanup: () => Promise<void>;
  /** Number of learnings applied to this run (0 if learning.apply is disabled) */
  learningsApplied: number;
}

export interface AgentChunk {
  type: 'text' | 'tool-call' | 'tool-result' | 'tool-error' | 'finish' | 'error' | 'llm-start' | 'llm-first-token';
  text?: string;
  toolName?: string;
  toolCallId?: string;      // Tool call ID from AI SDK
  toolInput?: unknown;
  toolResult?: string;
  toolResultRaw?: unknown;
  error?: unknown;
  finishReason?: string;
  usage?: LanguageModelUsage;
  toolStartTime?: number;  // Track when tool started
  toolDuration?: number;    // Duration in ms
  isSubAgent?: boolean;     // Track if this tool is a subagent
  llmModel?: string;        // Model name for LLM traces
  llmStartTime?: number;    // When LLM call started
  llmFirstTokenTime?: number; // Time to first token
}

export interface RunAgentResult {
  text: string;
  usage?: LanguageModelUsage;
  toolCallCount: number;
  toolCallTraces?: ToolCallTrace[];
  finishReason?: string;
  finishReasons?: string[];
  hasTextOutput: boolean;
}
