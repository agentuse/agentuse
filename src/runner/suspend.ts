export interface SuspendPayload {
  kind: 'await_external' | 'await_human';
  prompt: string;
  channel?: string;
  notification?: {
    type: 'webhook' | 'slack-message';
    url?: string;
    channel?: string;
    ts?: string;
  };
  expiresAt?: number;
  resumeToken?: string;
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
