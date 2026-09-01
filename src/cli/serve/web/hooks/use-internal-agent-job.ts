import { useEffect, useState } from 'preact/hooks';
import type { ApprovalLogEntry } from '../../types';
import {
  fetchInternalAgentJob,
  type OnboardingJob,
  type OnboardingJobHandle,
} from '../lib/api';
import { useApprovalStream } from './use-approval-stream';

const TERMINAL_SESSION_STATUSES = new Set([
  'completed',
  'error',
  'expired',
  'failed',
  'stopped',
  'timeout',
  'incomplete',
]);
const JOB_POLL_MS = 500;
const FINAL_RESULT_MAX_ATTEMPTS = 60;

export function isTerminalInternalAgentSessionStatus(status: string): boolean {
  return TERMINAL_SESSION_STATUSES.has(status);
}

/** Job GET responses intentionally omit capability tokens. Preserve the token
 * minted by the start response while accepting every persisted job update. */
export function mergeInternalAgentJob<T extends OnboardingJobHandle>(
  current: OnboardingJobHandle | null,
  next: T,
): T {
  if (next.sessionToken || !current?.sessionToken || current.id !== next.id) return next;
  return { ...next, sessionToken: current.sessionToken };
}

export interface InternalAgentJobController {
  job: OnboardingJobHandle | null;
  sessionStatus: string;
  entries: ApprovalLogEntry[];
  streamError: string | null;
  finalJob: OnboardingJob | null;
  controllerError: string | null;
}

/** Follow one persisted internal AgentUse job. SSE owns the live lifecycle and
 * logs. HTTP polling is limited to preparation (before a session exists) and
 * result collection (after SSE says the session ended). */
export function useInternalAgentJob(initialJob: OnboardingJobHandle | null): InternalAgentJobController {
  const [job, setJob] = useState<OnboardingJobHandle | null>(initialJob);
  const [sessionStatus, setSessionStatus] = useState(initialJob?.status ?? 'idle');
  const [entries, setEntries] = useState<ApprovalLogEntry[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [terminalSignal, setTerminalSignal] = useState<string | null>(null);
  const [finalJob, setFinalJob] = useState<OnboardingJob | null>(null);
  const [controllerError, setControllerError] = useState<string | null>(null);

  useEffect(() => {
    setJob(initialJob);
    setSessionStatus(initialJob?.status ?? 'idle');
    setEntries([]);
    setStreamError(null);
    setTerminalSignal(null);
    setFinalJob(null);
    setControllerError(null);
  }, [initialJob?.id]);

  useEffect(() => {
    if (!job || job.phase !== 'preparing' || finalJob) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const pollPreparation = async () => {
      try {
        const { job: fetched } = await fetchInternalAgentJob(job.id);
        if (disposed) return;
        const merged = mergeInternalAgentJob(job, fetched);
        setJob(merged);
        if (fetched.status !== 'running') {
          setFinalJob(merged);
          return;
        }
        if (fetched.phase === 'preparing') {
          timer = setTimeout(() => void pollPreparation(), JOB_POLL_MS);
        }
      } catch (caught) {
        if (!disposed) setControllerError((caught as Error).message || 'Could not prepare the internal AgentUse session.');
      }
    };

    void pollPreparation();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [job?.id, job?.phase, finalJob?.id]);

  useApprovalStream({
    sessionId: job?.sessionId ?? '',
    token: job?.sessionToken,
    project: job?.projectId,
    pending: true,
    enabled: Boolean(job && job.phase !== 'preparing' && !finalJob),
    logsLimit: 160,
    nudge: 0,
    handlers: {
      onStatus: (status) => {
        setSessionStatus(status);
        if (isTerminalInternalAgentSessionStatus(status)) {
          setTerminalSignal((current) => current ?? `${job?.id ?? ''}:${status}`);
        }
      },
      onLogs: (next) => setEntries(next),
      onLog: (entry) => setEntries((current) => {
        const index = current.findIndex((candidate) => candidate.id === entry.id);
        if (index < 0) return [...current, entry];
        const copy = [...current];
        copy[index] = entry;
        return copy;
      }),
      onFatalError: (_code, message) => {
        setStreamError(message);
        setTerminalSignal((current) => current ?? `${job?.id ?? ''}:stream-error`);
      },
    },
  });

  useEffect(() => {
    if (!job || !terminalSignal || finalJob) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;

    const fetchFinalResult = async () => {
      try {
        const { job: fetched } = await fetchInternalAgentJob(job.id);
        if (disposed) return;
        const merged = mergeInternalAgentJob(job, fetched);
        setJob(merged);
        if (fetched.status === 'running') {
          attempts += 1;
          if (attempts >= FINAL_RESULT_MAX_ATTEMPTS) {
            setControllerError('The session ended, but AgentUse could not finish preparing its result.');
            return;
          }
          timer = setTimeout(() => void fetchFinalResult(), JOB_POLL_MS);
          return;
        }
        setFinalJob(merged);
      } catch (caught) {
        if (disposed) return;
        attempts += 1;
        if (attempts < FINAL_RESULT_MAX_ATTEMPTS) {
          timer = setTimeout(() => void fetchFinalResult(), JOB_POLL_MS);
          return;
        }
        setControllerError((caught as Error).message || 'Could not retrieve the internal AgentUse session result.');
      }
    };

    void fetchFinalResult();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [job?.id, terminalSignal, finalJob?.id]);

  return { job, sessionStatus, entries, streamError, finalJob, controllerError };
}
