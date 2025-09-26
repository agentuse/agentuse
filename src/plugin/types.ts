/**
 * Plugin system type definitions
 */

export interface ToolCallTrace {
  name: string;           // Tool, sub-agent, or model name
  type: 'tool' | 'subagent' | 'llm';
  startTime: number;      // Unix timestamp in ms
  duration: number;       // Duration in ms
  tokens?: number;        // Tokens used (for sub-agents and LLM calls)
  promptTokens?: number;  // Input tokens (for LLM calls)
  completionTokens?: number; // Output tokens (for LLM calls)
}

export interface AgentCompleteEvent {
  agent: {
    name: string;
    model: string;
    description?: string;
    filePath?: string;
  };
  result: {
    text: string;
    duration: number;      // seconds
    tokens?: number;       // total tokens used
    toolCalls: number;     // count of tool calls
    toolCallTraces?: ToolCallTrace[];  // Detailed timing for each tool/sub-agent call
  };
  isSubAgent: boolean;
  consoleOutput: string;    // Full console output including logs and results
}

// Plugin returns handlers for events
export interface PluginHandlers {
  'agent:complete'?: (event: AgentCompleteEvent) => Promise<void>;
  // Future events can be added here
  // 'agent:start'?: (event: AgentStartEvent) => Promise<void>;
  // 'tool:execute'?: (event: ToolExecuteEvent) => Promise<void>;
}

export type Plugin = PluginHandlers;