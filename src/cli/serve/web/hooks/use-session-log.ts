import { useState } from 'preact/hooks';
import type { ApprovalLogEntry, ApprovalPageInfo } from '../../types';
import { useApprovalStream } from './use-approval-stream';

export interface SessionLogController {
  status: string;
  approval: Omit<ApprovalPageInfo, 'logs'> | null;
  entries: ApprovalLogEntry[];
  streamError: string | null;
}

/**
 * Follow one session's live log for as long as the view is open.
 *
 * `useInternalAgentJob` stops streaming once its job reaches a terminal state,
 * which is right for a view that waits for one result. The draft and revision
 * panels outlive that: the session settles, the operator asks for a change, and
 * it runs again. They need the log itself, not a job outcome.
 */
export function useSessionLog(options: {
  sessionId: string;
  token?: string | undefined;
  project?: string | undefined;
  enabled?: boolean;
  logsLimit?: number;
}): SessionLogController {
  const [status, setStatus] = useState('idle');
  const [approval, setApproval] = useState<Omit<ApprovalPageInfo, 'logs'> | null>(null);
  const [entries, setEntries] = useState<ApprovalLogEntry[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);

  useApprovalStream({
    sessionId: options.sessionId,
    token: options.token,
    project: options.project,
    pending: true,
    enabled: options.enabled !== false && Boolean(options.sessionId),
    logsLimit: options.logsLimit ?? 400,
    nudge: 0,
    handlers: {
      onStatus: (next, info) => {
        setStatus(next);
        setApproval(info);
        setStreamError(null);
      },
      onLogs: (next) => setEntries(next),
      onLog: (entry) => setEntries((current) => {
        const index = current.findIndex((candidate) => candidate.id === entry.id);
        if (index < 0) return [...current, entry];
        const copy = [...current];
        copy[index] = entry;
        return copy;
      }),
      onFatalError: (_code, message) => setStreamError(message),
    },
  });

  return { status, approval, entries, streamError };
}
