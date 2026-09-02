import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ApprovalLogEntry } from '../../types';
import type { OnboardingJobHandle } from '../lib/api';
import { isLiveSessionStatus } from '../../../../session/status';

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
  status: string;
  entries: ApprovalLogEntry[];
  streamError?: string | null | undefined;
}) {
  const [expanded, setExpanded] = useState(false);
  const linesRef = useRef<HTMLDivElement>(null);
  const lines = useMemo(() => props.entries.map(entryLine).filter((entry): entry is { label: string; text: string } => Boolean(entry)), [props.entries]);
  const visible = expanded ? lines : lines.slice(-12);
  const running = isLiveSessionStatus(props.status);
  const preparing = props.status === 'preparing' || props.job.phase === 'preparing';

  useEffect(() => {
    const frame = requestAnimationFrame(() => {
      const element = linesRef.current;
      if (element) element.scrollTop = element.scrollHeight;
    });
    return () => cancelAnimationFrame(frame);
  }, [props.entries, expanded, props.streamError, props.status]);

  return (
    <section class="onboarding-session-log" aria-live="polite" aria-label={props.title}>
      <header>
        <span class={`onboarding-session-state${running ? ' is-running' : ''}`} aria-hidden="true" />
        <div><strong>{props.title}</strong><small>{preparing ? 'Preparing project context' : running ? 'Live AgentUse session' : `Session ${props.status}`}</small></div>
      </header>
      <div class="onboarding-session-lines" ref={linesRef}>
        {visible.length === 0 && !props.streamError
          ? <div class="onboarding-session-placeholder">{preparing ? 'Scanning project files and discovering available skills…' : 'Starting the agent and preparing its tools…'}</div>
          : visible.map((line, index) => (
              <div class="onboarding-session-line" key={`${line.label}-${index}`}>
                <span>{line.label}</span><pre>{line.text}</pre>
              </div>
            ))}
        {running && !props.streamError && visible.length > 0 && (
          <div class="onboarding-session-line onboarding-session-working" aria-label="Agent is still working">
            <span class="onboarding-session-working-indicator" aria-hidden="true"><i /></span>
            <pre>Still working<span class="onboarding-session-working-dots" aria-hidden="true" /></pre>
          </div>
        )}
        {props.streamError && <div class="onboarding-session-error">{props.streamError}</div>}
      </div>
      {lines.length > 12 && (
        <button type="button" class="onboarding-session-expand" onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Show recent activity' : `Show all ${lines.length} updates`}
        </button>
      )}
    </section>
  );
}
