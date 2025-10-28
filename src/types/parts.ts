export type AgentPart = TextPart | ToolCallPart | ToolResultPart;

export interface TextPart {
  type: 'text';
  text: string;
  timestamp: number;
}

export interface ToolCallPart {
  type: 'tool-call';
  tool: string;
  args: unknown;
  timestamp: number;
}

export interface ToolResultPart {
  type: 'tool-result';
  tool: string;
  output: string;
  duration: number;
  success: boolean;
  timestamp: number;
}
