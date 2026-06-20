export interface SuspendPayload {
  // 'await_human' is a real human gate (leaf). 'subagent_wait' is a parent step
  // parked on a delegated child's gate — it carries no human-facing fields, only
  // the pointer down to the suspended child so the cascade can descend/resume.
  kind: 'await_human' | 'subagent_wait';
  prompt?: string;
  surface?: 'web';
  channelMessage?: {
    type: 'slack-message';
    url?: string;
    channel?: string;
    ts?: string;
    actionTs?: string;
  };
  channelRequest?: {
    type: 'slack-message';
    channel: string;
  };
  expiresAt?: number;
  resumeToken?: string;
  approvalUrl?: string;
  // subagent_wait only: the suspended child gate this parent step is parked on.
  childSessionID?: string;
  childAgentName?: string;
}

export class SuspendSignal extends Error {
  constructor(public payload: SuspendPayload) {
    super('Agent execution suspended');
    this.name = 'SuspendSignal';
  }
}

export function isSuspendSignal(error: unknown): error is SuspendSignal {
  return error instanceof SuspendSignal || (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: string }).name === 'SuspendSignal'
  );
}
