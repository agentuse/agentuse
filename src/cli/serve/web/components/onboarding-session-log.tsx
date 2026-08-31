import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ApprovalLogEntry } from '../../types';
import { useApprovalStream } from '../hooks/use-approval-stream';
import type { OnboardingJobHandle } from '../lib/api';

function entryLine(entry: ApprovalLogEntry): { label: string; text: string } | null {
  if (entry.type === 'log' && entry.level === 'debug') return null;
  if (entry.type === 'tool') {
    const label = (entry.tool ?? 'tool').replace(/^tools__/u, '').replace(/__/gu, ' · ');
    const detail = entry.status === 'running' || entry.status === 'streaming'
      ? 'running…'
      : entry.status === 'error' || entry.status === 'failed'
        ? 'failed'
        : 'complete';
    return { label, text: entry.title || detail };
  }
  const text = (entry.message ?? entry.title ?? '').trim();
  if (!text) return null;
  return { label: entry.type === 'reasoning' ? 'thinking' : entry.type === 'text' ? 'agent' : 'agentuse', text };
}

export function OnboardingSessionLog(props: {
  job: OnboardingJobHandle;
  title: string;
  onStatus?: (status: string) => void;
  onFatalError?: (message: string) => void;
}) {
  const [status, setStatus] = useState<string>(props.job.status);
  const [entries, setEntries] = useState<ApprovalLogEntry[]>([]);
  const [streamError, setStreamError] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const linesRef = useRef<HTMLDivElement>(null);

  useApprovalStream({
    sessionId: props.job.sessionId,
    token: props.job.sessionToken,
    project: props.job.projectId,
    pending: true,
    logsLimit: 160,
    nudge: 0,
    handlers: {
      onStatus: (next) => {
        setStatus(next);
        props.onStatus?.(next);
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
        props.onFatalError?.(message);
      },
    },
  });

  const lines = useMemo(() => entries.map(entryLine).filter((entry): entry is { label: string; text: string } => Boolean(entry)), [entries]);
  const visible = expanded ? lines : lines.slice(-12);
  const running = status === 'running' || status === 'waiting' || status === 'suspended';

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = linesRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [entries, expanded, streamError]);

  return (
    <section class="onboarding-session-log" aria-live="polite" aria-label={props.title}>
      <header>
        <span class={`onboarding-session-state${running ? ' is-running' : ''}`} aria-hidden="true" />
        <div><strong>{props.title}</strong><small>{running ? 'Live AgentUse session' : `Session ${status}`}</small></div>
      </header>
      <div class="onboarding-session-lines" ref={linesRef}>
        {visible.length === 0 && !streamError
          ? <div class="onboarding-session-placeholder">Starting the agent and preparing its tools…</div>
          : visible.map((line, index) => (
              <div class="onboarding-session-line" key={`${line.label}-${index}`}>
                <span>{line.label}</span><pre>{line.text}</pre>
              </div>
            ))}
        {streamError && <div class="onboarding-session-error">{streamError}</div>}
      </div>
      {lines.length > 12 && (
        <button type="button" class="onboarding-session-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show recent activity' : `Show all ${lines.length} updates`}
        </button>
      )}
    </section>
  );
}
