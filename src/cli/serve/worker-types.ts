/**
 * The shapes the daemon exchanges with a project worker when it runs an agent.
 * Moved verbatim out of serve.ts so both the run and changeset paths can name
 * them without importing back through the command file.
 */
import type { ProjectDiscoveryResult } from "../../agents/discover";
import type { SessionTrigger } from "../../session/types";
import type { ToolCallMetrics } from "../../telemetry";

export interface WorkerExecuteOptions {
  agentPath?: string;
  /** In-memory agent definition used by the zero-file onboarding run. */
  agentContent?: string;
  agentName?: string;
  projectRoot: string;
  prompt?: string | undefined;
  model?: string | undefined;
  timeout?: number | undefined;
  maxSteps?: number | undefined;
  debug?: boolean | undefined;
  sessionId?: string | undefined;
  /** Pre-assigned id for a fresh `execute` (detached run). */
  newSessionId?: string | undefined;
  /** The pre-assigned id already has a durable `preparing` session shell. */
  preparedSession?: boolean | undefined;
  toolResult?: unknown;
  resumeToken?: string | undefined;
  trigger?: SessionTrigger | undefined;
  signal?: AbortSignal | undefined;
}

export interface WorkerExecuteResult {
  success: true;
  /** The reporting worker's RSS when the run settled (see worker recycling). */
  workerRssBytes?: number;
  telemetry?: {
    toolCalls: ToolCallMetrics;
    steps: number;
  };
  result: {
    text: string;
    finishReason?: string;
    duration: number;
    tokens?: { input: number; output: number };
    toolCalls: number;
    sessionId?: string;
    approvalUrl?: string;
    /** One-line outcome from report_complete, when the run called it. */
    headline?: string;
    /** Validated source returned by the creator-only submission tool. */
    agentSource?: string;
    /** Human-facing name returned with creator-only source. */
    authoredAgentName?: string;
    /** Project-local filename returned with creator-only source. */
    authoredAgentFileName?: string;
    /** Skills the creator loaded before the accepted source was submitted. */
    authoredAgentLoadedSkills?: string[];
    /** Validated suggestions returned by the discovery-only submission tool. */
    projectDiscovery?: ProjectDiscoveryResult;
  };
}

export interface WorkerExecuteError {
  success: false;
  /** The reporting worker's RSS when the run settled (see worker recycling). */
  workerRssBytes?: number;
  telemetry?: WorkerExecuteResult['telemetry'];
  error: {
    cause?: string;
    phase?: string;
    attempts?: number;
    statusCode?: number;
    code: string;
    message: string;
  };
  /** Final output remains useful when report_incomplete ends the run. */
  result?: WorkerExecuteResult['result'];
}
