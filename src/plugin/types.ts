/**
 * Plugin system type definitions
 */

export interface AgentCompleteEvent {
  agent: {
    name: string;
    model: string;
    filePath?: string;
  };
  result: {
    text: string;
    duration: number;      // seconds
    tokens?: number;       // total tokens used
    toolCalls: number;     // count of tool calls
  };
  isSubAgent: boolean;
}

// Plugin returns handlers for events
export interface PluginHandlers {
  'agent:complete'?: (event: AgentCompleteEvent) => Promise<void>;
  // Future events can be added here
  // 'agent:start'?: (event: AgentStartEvent) => Promise<void>;
  // 'tool:execute'?: (event: ToolExecuteEvent) => Promise<void>;
}

export type Plugin = PluginHandlers;