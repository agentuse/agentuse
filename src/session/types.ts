// Session Info Schema
export interface SessionInfo {
  id: string;                        // ULID
  parentSessionID?: string;          // For subagent sessions - links to parent agent session

  // Agent metadata
  agent: {
    name: string;                    // Agent name from YAML
    filePath?: string;               // Path to .agentuse file (if local)
    description?: string;            // Agent description from YAML
    isSubAgent: boolean;             // True if this is a subagent execution
  };

  // Model and version
  model: string;                     // Full model identifier (e.g., "anthropic:claude-sonnet-4-0")
  version: string;                   // agentuse version

  // Configuration (from agent YAML)
  config: {
    timeout?: number;                // Timeout in seconds
    maxSteps?: number;               // Max steps configured
    mcpServers?: string[];           // MCP server names (keys from mcpServers object)
    subagents?: Array<{              // Subagent definitions
      path: string;
      name?: string;
    }>;
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
}

// Message Schemas
export type Message = UserMessage | AssistantMessage;

export interface UserMessage {
  id: string;
  role: 'user';
  sessionID: string;
  time: {
    created: number;
  };
}

export interface AssistantMessage {
  id: string;
  role: 'assistant';
  sessionID: string;
  time: {
    created: number;
    completed?: number;
  };
  error?: {
    message: string;
    type?: string;
    stack?: string;
  };
  system: string[];                  // System prompts
  modelID: string;
  providerID: string;
  mode: string;                      // 'build', 'plan', etc.
  path: {
    cwd: string;
    root: string;
  };
  summary?: boolean;
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
  | PatchPart;

export interface TextPart {
  type: 'text';
  text: string;
  time?: {
    start: number;
    end?: number;
  };
}

export interface ReasoningPart {
  type: 'reasoning';
  text: string;
  time?: {
    start: number;
    end?: number;
  };
}

export interface ToolPart {
  type: 'tool';
  state: 'pending' | 'running' | 'completed' | 'error';
  name: string;
  input?: unknown;
  output?: unknown;
  title?: string;
  error?: string;
  metadata?: Record<string, unknown>;
  time?: {
    start: number;
    end?: number;
  };
}

export interface FilePart {
  type: 'file';
  file: string;                      // File path
  mime?: string;
  source?: {
    start: number;
    end: number;
  };
}

export interface AgentPart {
  type: 'agent';
  id: string;
}

export interface StepStartPart {
  type: 'step-start';
}

export interface StepFinishPart {
  type: 'step-finish';
  tokens?: {
    input: number;
    output: number;
    reasoning: number;
    cache: {
      read: number;
      write: number;
    };
  };
  cost?: number;
}

export interface SnapshotPart {
  type: 'snapshot';
  snapshot: string;
}

export interface PatchPart {
  type: 'patch';
  patch: string;
}
