import { z } from 'zod';

// Deep partial type for updates
export type DeepPartial<T> = {
  [P in keyof T]?: T[P] extends object ? DeepPartial<T[P]> : T[P];
};

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
    summary: z.boolean().optional(),
  }),
});

// Part Base - all parts include these fields
export interface PartBase {
  id: string;        // Part ID (ULID)
  sessionID: string; // Session this part belongs to
  messageID: string; // Message this part belongs to
}

// Tool State - discriminated union for type safety
export type ToolStatePending = {
  status: 'pending';
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

export interface TextPart extends PartBase {
  type: 'text';
  text: string;
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
