/**
 * The in-memory and persisted envelopes for an internal model job (agent
 * creation, project discovery, revision). Moved verbatim out of serve.ts.
 */
import type { ProcessRef } from "../../utils/process-info";

export interface OnboardingModelJob {
  id: string;
  sessionId: string;
  projectId: string;
  kind: 'project-discovery' | 'agent-creation' | 'agent-revision' | 'changeset';
  status: 'running' | 'completed' | 'error';
  phase: 'preparing' | 'running';
  model: string;
  createdAt: number;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface AgentCreationRecoveryInput {
  request: { name?: string; objective: string; model: string };
  schedule?: string;
  guided: boolean;
  configuredProviders: string[];
  availableModels: string[];
}

export interface PersistedOnboardingModelJob {
  job: OnboardingModelJob;
  /** Stable process identity for deciding whether a missing preparing shell is
   * still being created or was lost with a prior daemon. */
  owner?: ProcessRef;
  /** Backward-compatible owner field written by pre-0.20 development builds. */
  ownerPid: number;
  agentCreation?: AgentCreationRecoveryInput;
}
