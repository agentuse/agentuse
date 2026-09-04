import { useState } from 'preact/hooks';
import type { ApprovalLogEntry, ApprovalPageInfo } from '../../types';
import type { AgentDraftTestRun as AgentDraftTestRunRecord } from '../../../../agents/draft';
import { useApprovalStream } from '../hooks/use-approval-stream';
import { isTerminalInternalAgentSessionStatus } from '../hooks/use-internal-agent-job';
import { OnboardingSessionLog } from './onboarding-session-log';

/**
 * A mock run of the draft, in the same panel as the file.
 *
 * The run uses the real runtime with every tool mocked and gates auto-resolved,
 * so the shape of the run is real while nothing leaves the machine. That keeps
 * refinement tied to an actual execution instead of a reading of the source.
 */
export function DraftTestRun(props: {
  project: string;
  session: { sessionId: string; sessionToken?: string; draftIndex: number } | null;
  runs: AgentDraftTestRunRecord[];
  busy: boolean;
  onRun: () => void;
}) {
  const [status, setStatus] = useState('idle');
  const [approval, setApproval] = useState<Omit<ApprovalPageInfo, 'logs'> | null>(null);
  const [entries, setEntries] = useState<ApprovalLogEntry[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);

  const sessionId = props.session?.sessionId ?? '';
  useApprovalStream({
    sessionId,
    token: props.session?.sessionToken,
    project: props.project,
    pending: true,
    enabled: Boolean(sessionId),
    logsLimit: 200,
    nudge: 0,
    handlers: {
      onStatus: (next, info) => { setStatus(next); setApproval(info); },
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

  const record = props.runs.find((run) => run.sessionId === sessionId);
  const finished = Boolean(sessionId) && isTerminalInternalAgentSessionStatus(status);
  const durationMs = record?.finishedAt && record.startedAt ? record.finishedAt - record.startedAt : undefined;
  const toolCalls = entries.filter((entry) => entry.type === 'tool');
  const failedCalls = toolCalls.filter((entry) => entry.status === 'error' || entry.status === 'failed');
  const gates = entries.filter((entry) => entry.type === 'approval' || entry.tool === 'await_human');

  if (!sessionId) {
    return (
      <div class="draft-testrun is-empty">
        <p>Run this draft once with every tool mocked and approvals auto-resolved. Nothing is sent and no store is written.</p>
        <button type="button" class="draft-primary" disabled={props.busy} aria-busy={props.busy} onClick={props.onRun}>
          {props.busy ? 'Starting…' : 'Run once as a test'}
        </button>
      </div>
    );
  }

  return (
    <div class="draft-testrun">
      <div class="draft-testrun-head">
        <span class="draft-pill is-mock">Mock</span>
        <span class="draft-testrun-summary">
          draft {props.session?.draftIndex}
          {finished ? ` · finished${durationMs !== undefined ? ` in ${Math.round(durationMs / 1000)}s` : ''}` : ' · running'}
          {' · isolated stores, no external sends'}
        </span>
        <button type="button" class="draft-secondary" disabled={props.busy} aria-busy={props.busy} onClick={props.onRun}>
          {props.busy ? 'Starting…' : 'Run again'}
        </button>
      </div>
      <OnboardingSessionLog
        job={{
          id: sessionId,
          sessionId,
          projectId: props.project,
          kind: 'agent-creation',
          status: finished ? 'completed' : 'running',
          phase: 'running',
          model: approval?.model ?? '',
          createdAt: record?.startedAt ?? Date.now(),
        }}
        title="Test run"
        status={status}
        entries={entries}
        streamError={streamError}
      />
      {gates.length > 0 && (
        <p class="draft-testrun-gate">
          {gates.length === 1 ? '1 approval gate' : `${gates.length} approval gates`} auto-resolved in mock, nothing was sent.
        </p>
      )}
      <div class="draft-testrun-result">
        <div class="cell"><span class="label">tool calls</span><span class="value">{toolCalls.length} · {failedCalls.length} failed</span></div>
        <div class="cell"><span class="label">gates hit</span><span class="value">{gates.length}{gates.length > 0 ? ' · auto-resolved' : ''}</span></div>
        <div class="cell"><span class="label">status</span><span class="value">{record?.status ?? status}</span></div>
      </div>
      {record?.error && <p class="draft-error" role="alert">{record.error.message}</p>}
    </div>
  );
}
