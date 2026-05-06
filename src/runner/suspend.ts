export interface SuspendPayload {
  kind: 'await_human';
  prompt: string;
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
