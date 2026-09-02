import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ReasoningLevel } from '../../../../model-compatibility';
import type { AgentRevisionMode, AgentRevisionRecord } from '../../../../agents/revision';
import {
  fetchAgentCreationOptions,
  fetchAgentRevision,
  fetchSessionRevisions,
  postAgentRevisionAction,
  requestAgentRevisionChanges,
  startAgentRevision,
  ApiRequestError,
  type AgentRevisionSummary,
} from '../lib/api';
import { buildDebugPrompt, type DebugPromptContext } from './debug-prompt-button';
import { SendToCodingAgentDialog } from './send-to-coding-agent-dialog';

const ACTIVE_REVISION_STATUSES = new Set(['running', 'proposed', 'no-change']);
const AUTHORING_PREFS_KEY = 'agentuse:revision-authoring';

/** Finished revisions read alike, so the list needs a time to tell them apart. */
function relativeTime(updatedAt: number): string {
  const seconds = Math.max(0, Math.round((Date.now() - updatedAt) / 1000));
  if (seconds < 60) return 'just now';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.round(hours / 24)}d ago`;
}

function readStoredAuthoring(): { model?: string; reasoning?: ReasoningLevel } {
  try {
    const raw = localStorage.getItem(AUTHORING_PREFS_KEY);
    return raw ? JSON.parse(raw) as { model?: string; reasoning?: ReasoningLevel } : {};
  } catch {
    return {};
  }
}

function storeAuthoring(patch: { model?: string; reasoning?: ReasoningLevel }): void {
  try {
    localStorage.setItem(AUTHORING_PREFS_KEY, JSON.stringify({ ...readStoredAuthoring(), ...patch }));
  } catch { /* remembering the last choice is a convenience only */ }
}

export function revisionLabel(revision: Pick<AgentRevisionSummary, 'status' | 'mode'>): string {
  if (revision.status === 'running') return `${revision.mode === 'fix' ? 'Fix' : 'Improvement'} session is running`;
  if (revision.status === 'proposed') return 'Revision ready to review';
  if (revision.status === 'no-change') return 'Revision needs review';
  if (revision.status === 'accepted') return 'Diagnosis accepted';
  if (revision.status === 'applied') return 'Revision applied';
  if (revision.status === 'restored') return 'Previous source restored';
  if (revision.status === 'discarded') return 'Revision discarded';
  return 'Revision stopped';
}

export function revisionOriginDescription(revision: Pick<AgentRevisionSummary, 'status' | 'mode' | 'targetAgentName'>): string {
  if (revision.status === 'no-change') return 'Review this diagnosis before starting another revision.';
  if (revision.status === 'accepted') return 'No agent source change was made. You can start another revision.';
  return `${revision.mode === 'fix' ? 'Fixing' : 'Improving'} ${revision.targetAgentName} from this run.`;
}

export function revisionOriginAction(revision: Pick<AgentRevisionSummary, 'status'>, active: boolean): string {
  if (revision.status === 'no-change') return 'Review diagnosis';
  return active ? 'Open revision session' : 'View revision';
}

function revisionHref(revision: AgentRevisionSummary & { href?: string }, token?: string, project?: string): string {
  if (revision.href) return revision.href;
  const params = new URLSearchParams();
  if (token) params.set('token', token);
  if (project) params.set('project', project);
  const query = params.toString();
  return `/sessions/${encodeURIComponent(revision.revisionSessionId)}${query ? `?${query}` : ''}`;
}

export function AgentRevisionLauncher(props: {
  context: DebugPromptContext;
  ended: boolean;
  token?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [codingOpen, setCodingOpen] = useState(false);
  const [mode, setMode] = useState<AgentRevisionMode>(
    props.context.sessionStatus === 'completed' ? 'improve' : 'fix'
  );
  const [instruction, setInstruction] = useState('');
  const [model, setModel] = useState('');
  const [reasoning, setReasoning] = useState<ReasoningLevel>('medium');
  const [models, setModels] = useState<Array<{ value: string; label: string }>>([]);
  const [revisions, setRevisions] = useState<Array<AgentRevisionSummary & { href?: string }>>([]);
  const [historySessionId, setHistorySessionId] = useState<string | null>(null);
  const [loadingOptions, setLoadingOptions] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [errorHref, setErrorHref] = useState<string | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  const currentSessionId = useRef(props.context.sessionId);
  currentSessionId.current = props.context.sessionId;
  const historyLoaded = historySessionId === props.context.sessionId;
  const currentRevisions = historyLoaded ? revisions : [];
  const activeRevision = currentRevisions.find((revision) => ACTIVE_REVISION_STATUSES.has(revision.status));
  const latest = activeRevision ?? currentRevisions[0];
  const earlier = currentRevisions.filter((revision) => revision !== latest);

  const refresh = async (): Promise<Array<AgentRevisionSummary & { href?: string }>> => {
    const requestedSessionId = props.context.sessionId;
    try {
      const payload = await fetchSessionRevisions(
        requestedSessionId,
        props.token,
        props.context.projectId,
      );
      if (currentSessionId.current !== requestedSessionId) return [];
      const next = payload.revisions as Array<AgentRevisionSummary & { href?: string }>;
      setRevisions(next);
      return next;
    } catch {
      // Revision history is additive; the ordinary session remains usable.
      if (currentSessionId.current !== requestedSessionId) return [];
      setRevisions([]);
      return [];
    } finally {
      if (currentSessionId.current === requestedSessionId) setHistorySessionId(requestedSessionId);
    }
  };

  useEffect(() => {
    void refresh();
  }, [props.context.sessionId, props.context.projectId]);

  useEffect(() => {
    setMode(props.context.sessionStatus === 'completed' ? 'improve' : 'fix');
    setInstruction('');
    setOpen(false);
    setCodingOpen(false);
    setError(null);
    setErrorHref(null);
    setShowHistory(false);
  }, [props.context.sessionId]);

  useEffect(() => {
    if (!latest || latest.status !== 'running') return;
    const timer = setInterval(() => void refresh(), 1500);
    return () => clearInterval(timer);
  }, [latest?.revisionSessionId, latest?.status]);

  const begin = async () => {
    setError(null);
    setErrorHref(null);
    // The list in hand can be stale, so confirm against the server before
    // opening a form the server would reject on submit.
    const fresh = await refresh();
    const blocking = fresh.find((revision) => ACTIVE_REVISION_STATUSES.has(revision.status));
    if (blocking) {
      setError('This run already has a revision open. Finish or discard it before starting another.');
      setErrorHref(revisionHref(blocking, undefined, props.context.projectId));
      return;
    }
    setOpen(true);
    if (models.length > 0 || loadingOptions) return;
    setLoadingOptions(true);
    try {
      const payload = await fetchAgentCreationOptions();
      const next = payload.providers.flatMap((provider) => provider.models.map((value) => ({
        value,
        label: `${provider.name} · ${value.startsWith(`${provider.id}:`) ? value.slice(provider.id.length + 1) : value}`,
      })));
      setModels(next);
      const remembered = readStoredAuthoring();
      setModel(remembered.model && next.some((option) => option.value === remembered.model)
        ? remembered.model
        : next[0]?.value ?? '');
      if (remembered.reasoning) setReasoning(remembered.reasoning);
    } catch (caught) {
      setError((caught as Error).message || 'Could not load authoring models.');
    } finally {
      setLoadingOptions(false);
    }
  };

  const submit = async () => {
    if (!instruction.trim() || !model || busy) return;
    setBusy(true);
    setError(null);
    try {
      const { job } = await startAgentRevision({
        sessionId: props.context.sessionId,
        ...(props.token && { token: props.token }),
        ...(props.context.projectId && { project: props.context.projectId }),
        mode,
        instruction: instruction.trim(),
        model,
        reasoning,
      });
      try {
        if (job.sessionToken) localStorage.setItem(`agentuse:revision-token:${job.sessionId}`, job.sessionToken);
      } catch { /* persistence only improves return navigation */ }
      const params = new URLSearchParams({ project: job.projectId, pending: '1' });
      if (job.sessionToken) params.set('token', job.sessionToken);
      window.location.assign(`/sessions/${encodeURIComponent(job.sessionId)}?${params.toString()}`);
    } catch (caught) {
      setError((caught as Error).message || 'Could not start the revision session.');
      const href = caught instanceof ApiRequestError && typeof caught.details.href === 'string'
        ? caught.details.href
        : null;
      setErrorHref(href);
      if (href) void refresh();
      setBusy(false);
    }
  };

  const active = Boolean(activeRevision);
  if (!props.ended || !props.context.agentFilePath) return null;

  return (
    <>
      {latest && !open && (
        <div class="agent-revision-history">
          <div class={`agent-revision-link is-${latest.status}`}>
            <span class="agent-revision-link-copy">
              <strong>{latest.status === 'running' && <span class="agent-revision-pulse" aria-hidden="true" />}{revisionLabel(latest)}</strong>
              <span>{revisionOriginDescription(latest)}</span>
            </span>
            <span class="agent-revision-link-actions">
              <a class="agent-revision-open" href={revisionHref(latest, undefined, props.context.projectId)}>
                {revisionOriginAction(latest, active)}
              </a>
              {!active && <button type="button" onClick={() => void begin()}>Start another revision</button>}
            </span>
          </div>
          {earlier.length > 0 && (
            <button type="button" class="agent-revision-more" aria-expanded={showHistory} onClick={() => setShowHistory((value) => !value)}>
              {showHistory ? 'Hide earlier revisions' : `Show ${earlier.length} earlier revision${earlier.length === 1 ? '' : 's'}`}
            </button>
          )}
          {showHistory && earlier.map((revision) => (
            <div class={`agent-revision-link is-compact is-${revision.status}`} key={revision.revisionSessionId}>
              <span class="agent-revision-link-copy">
                <strong>{revisionLabel(revision)}</strong>
                <span>{revision.mode === 'fix' ? 'Fix' : 'Improvement'} · {relativeTime(revision.updatedAt)}</span>
              </span>
              <a class="agent-revision-open" href={revisionHref(revision, undefined, props.context.projectId)}>View revision</a>
            </div>
          ))}
          {error && (
            <p class="agent-revision-error" role="alert">
              {error}{errorHref && <> <a href={errorHref}>Open it</a></>}
            </p>
          )}
        </div>
      )}
      {historyLoaded && !latest && !open && (
        <button type="button" class="debug-prompt-button is-primary" title="Fix or improve this agent's source from what this run did" onClick={() => void begin()}>
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
          </svg>
          <span>Improve agent</span>
        </button>
      )}
      {open && <section class="agent-revision-form" aria-labelledby="agent-revision-title">
        <div class="agent-revision-form-head"><span id="agent-revision-title">Revise {props.context.agentName ?? 'this agent'}</span><button type="button" aria-label="Close revision form" disabled={busy} onClick={() => setOpen(false)}>×</button></div>
        <div class="agent-revision-form-body">
          <div class="agent-revision-intro"><span>Start one internal session to diagnose this run and propose a safe source change. Nothing changes until you review and apply it.</span></div>
          <div class="agent-revision-modes">
            <button type="button" class={mode === 'fix' ? 'is-selected' : ''} aria-pressed={mode === 'fix'} onClick={() => setMode('fix')}><strong>Fix a problem</strong><span>Make the smallest durable correction.</span></button>
            <button type="button" class={mode === 'improve' ? 'is-selected' : ''} aria-pressed={mode === 'improve'} onClick={() => setMode('improve')}><strong>Improve behavior</strong><span>Refine quality, cost, or reliability.</span></button>
          </div>
          <label class="agent-revision-field"><span>What should change?</span><textarea value={instruction} disabled={busy} placeholder={mode === 'fix' ? 'e.g. exclude refunded orders instead of treating them as unknown' : 'e.g. make future results shorter without missing urgent tickets'} onInput={(event) => setInstruction((event.target as HTMLTextAreaElement).value)} /></label>
          <div class="agent-revision-models">
            <label class="agent-revision-field"><span>Authoring model</span><select value={model} disabled={busy || loadingOptions} onChange={(event) => { const value = (event.target as HTMLSelectElement).value; setModel(value); storeAuthoring({ model: value }); }}>{models.map((option) => <option value={option.value}>{option.label}</option>)}</select></label>
            <label class="agent-revision-field"><span>Thinking effort</span><select value={reasoning} disabled={busy} onChange={(event) => { const value = (event.target as HTMLSelectElement).value as ReasoningLevel; setReasoning(value); storeAuthoring({ reasoning: value }); }}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          </div>
          {error && <p class="agent-revision-error" role="alert">{error}{errorHref && <> <a href={errorHref}>Open it</a></>}</p>}
          <div class="agent-revision-actions"><button type="button" class="agent-revision-primary" disabled={busy || loadingOptions || !instruction.trim() || !model} onClick={() => void submit()}>{busy ? 'Starting revision…' : 'Start revision session'}</button></div>
          <div class="agent-revision-handoff">
            <span><strong>Need project code or a custom integration?</strong><small>Use your coding agent when the change is larger than this AgentUse file.</small></span>
            <button type="button" disabled={busy} onClick={() => { setOpen(false); setCodingOpen(true); }}>Send to Coding Agent…</button>
          </div>
        </div>
      </section>}
      <SendToCodingAgentDialog
        open={codingOpen}
        title="send revision to coding agent"
        buildPrompt={(detail) => buildDebugPrompt(props.context, detail || instruction)}
        detailLabel="What should the coding agent focus on?"
        initialDetail={instruction}
        onClose={() => setCodingOpen(false)}
      />
    </>
  );
}

function simpleLineDiff(currentSource: string, proposedSource: string): Array<{ kind: 'same' | 'add' | 'remove'; text: string }> {
  const current = currentSource.split('\n');
  const proposed = proposedSource.split('\n');
  let prefix = 0;
  while (prefix < current.length && prefix < proposed.length && current[prefix] === proposed[prefix]) prefix++;
  let suffix = 0;
  while (suffix < current.length - prefix && suffix < proposed.length - prefix
    && current[current.length - 1 - suffix] === proposed[proposed.length - 1 - suffix]) suffix++;
  return [
    ...current.slice(Math.max(0, prefix - 2), prefix).map((text) => ({ kind: 'same' as const, text })),
    ...current.slice(prefix, current.length - suffix).map((text) => ({ kind: 'remove' as const, text })),
    ...proposed.slice(prefix, proposed.length - suffix).map((text) => ({ kind: 'add' as const, text })),
    ...proposed.slice(proposed.length - suffix, Math.min(proposed.length, proposed.length - suffix + 2)).map((text) => ({ kind: 'same' as const, text })),
  ];
}

export function AgentRevisionSessionPanel(props: {
  sessionId: string;
  token?: string | undefined;
  project?: string | undefined;
  currentSource?: string | undefined;
  sessionStatus: string;
  onDetected?: ((revision?: AgentRevisionSessionIdentity) => void) | undefined;
}) {
  const [revision, setRevision] = useState<(Omit<AgentRevisionRecord, 'previousSource'> & { baseSource?: string; originHref?: string }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'apply' | 'discard' | 'restore' | null>(null);
  const [requestingChanges, setRequestingChanges] = useState(false);
  const [changePrompt, setChangePrompt] = useState('');
  const isRevision = revision !== null;

  const refresh = async () => {
    try {
      const payload = await fetchAgentRevision(props.sessionId, props.token, props.project);
      setRevision(payload.revision);
      props.onDetected?.(payload.revision);
      setError(null);
    } catch (caught) {
      if ((caught as { status?: number }).status !== 404) {
        // A forbidden/failed revision lookup still identifies this as an
        // internal revision session. Keep generic agent actions hidden rather
        // than briefly offering a nested revision or stop flow.
        props.onDetected?.();
        setError((caught as Error).message);
      }
    }
  };

  useEffect(() => {
    void refresh();
  }, [props.sessionId, props.token, props.project]);

  useEffect(() => {
    if (!revision || revision.status !== 'running') return;
    const timer = setInterval(() => void refresh(), 1200);
    return () => clearInterval(timer);
  }, [revision?.revisionSessionId, revision?.status]);

  const act = async (action: 'apply' | 'discard' | 'restore') => {
    setBusy(action);
    setError(null);
    try {
      const acceptedDiagnosis = action === 'discard' && revision?.status === 'no-change';
      const payload = await postAgentRevisionAction(props.sessionId, action, props.project);
      setRevision(payload.revision);
      if (acceptedDiagnosis && revision) {
        window.location.assign(revision.originHref ?? revisionFallbackOriginHref(revision.originSessionId, props.project));
      }
    } catch (caught) {
      setError((caught as Error).message || `Could not ${action} this revision.`);
    } finally {
      setBusy(null);
    }
  };

  const requestChanges = async () => {
    if (!changePrompt.trim()) return;
    setError(null);
    try {
      await requestAgentRevisionChanges(props.sessionId, changePrompt.trim(), props.project);
      setRequestingChanges(false);
      setChangePrompt('');
      await refresh();
    } catch (caught) {
      setError((caught as Error).message || 'Could not continue the revision session.');
    }
  };

  const diff = useMemo(() => revision?.proposedSource && (revision.baseSource ?? props.currentSource)
    ? simpleLineDiff((revision.baseSource ?? props.currentSource)!, revision.proposedSource)
    : [], [revision?.proposedSource, revision?.baseSource, props.currentSource]);

  if (!isRevision) return null;
  const originHref = revision.originHref
    ?? revisionFallbackOriginHref(revision.originSessionId, props.project);

  return (
    <section class={`agent-revision-session-panel is-${revision.status}`}>
      <div class="agent-revision-session-head">
        <span><strong>{revision.status === 'running' ? 'Revision session' : revision.status === 'proposed' ? 'Review proposed revision' : revision.status === 'no-change' ? 'No agent change recommended' : revisionLabel(revision)}</strong><small>Started from <a href={originHref}>session {revision.originSessionId.slice(0, 8)}…</a></small></span>
        <span class="agent-revision-state">{revision.status}</span>
      </div>
      {revision.status === 'running' && props.sessionStatus !== 'waiting' && <p>AgentUse is diagnosing the originating run. You can leave; this revision remains available from that run and Sessions.</p>}
      {revision.status === 'running' && props.sessionStatus === 'waiting' && <p>The reviser needs your decision below. Answering resumes this same internal session.</p>}
      {revision.diagnosis && <div class="agent-revision-diagnosis"><strong>Diagnosis</strong><p>{revision.diagnosis}</p></div>}
      {revision.status === 'no-change' && revision.recommendedAction && <div class="agent-revision-diagnosis"><strong>Recommended next action</strong><p>{revision.recommendedAction}</p></div>}
      {revision.status === 'no-change' && (
        <>
          <p class="agent-revision-resolution-hint">Accepting finishes this revision. You can start another from the original session afterward.</p>
          <div class="agent-revision-review-actions"><button type="button" class="agent-revision-primary" disabled={busy !== null} onClick={() => void act('discard')}>{busy === 'discard' ? 'Accepting…' : 'Accept diagnosis'}</button><button type="button" disabled={busy !== null} onClick={() => setRequestingChanges((value) => !value)}>Ask reviser to reconsider</button></div>
          {requestingChanges && <div class="agent-revision-change-request"><textarea value={changePrompt} placeholder="Explain why the agent itself should change…" onInput={(event) => setChangePrompt((event.target as HTMLTextAreaElement).value)} /><button type="button" class="agent-revision-primary" disabled={!changePrompt.trim()} onClick={() => void requestChanges()}>Continue revision session</button></div>}
        </>
      )}
      {revision.status === 'proposed' && revision.proposedSource && (
        <>
          <div class="agent-revision-proposal-title"><strong>{revision.summary}</strong><span>The agent file is unchanged.</span></div>
          <div class="agent-revision-capabilities">
            <strong>Capability review</strong>
            {revision.capabilityChanges && revision.capabilityChanges.length > 0
              ? <ul>{revision.capabilityChanges.map((change) => <li>{change}</li>)}</ul>
              : <span>No model, schedule, tool, skill, integration, sub-agent, or channel changes.</span>}
          </div>
          <pre class="agent-revision-diff" aria-label="Proposed agent source changes">{diff.length > 0 ? diff.map((line) => <span class={`is-${line.kind}`}>{line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : '  '}{line.text}{'\n'}</span>) : revision.proposedSource}</pre>
          <div class="agent-revision-review-actions"><button type="button" class="agent-revision-primary" disabled={busy !== null} onClick={() => void act('apply')}>{busy === 'apply' ? 'Applying…' : 'Apply revision'}</button><button type="button" disabled={busy !== null} onClick={() => setRequestingChanges((value) => !value)}>Request changes</button><button type="button" class="is-quiet" disabled={busy !== null} onClick={() => void act('discard')}>Discard</button></div>
          {requestingChanges && <div class="agent-revision-change-request"><textarea value={changePrompt} placeholder="Keep the existing schedule, but make the output shorter…" onInput={(event) => setChangePrompt((event.target as HTMLTextAreaElement).value)} /><button type="button" class="agent-revision-primary" disabled={!changePrompt.trim()} onClick={() => void requestChanges()}>Continue revision session</button></div>}
        </>
      )}
      {revision.status === 'applied' && <div class="agent-revision-review-actions">{revision.targetAgentRunPath && <a class="agent-revision-primary" href={`/agents/${encodeURIComponent(revision.projectId)}/${revision.targetAgentRunPath.split('/').map(encodeURIComponent).join('/')}`}>Open agent</a>}<button type="button" disabled={busy !== null} onClick={() => void act('restore')}>{busy === 'restore' ? 'Restoring…' : 'Restore previous source'}</button></div>}
      {error && <p class="agent-revision-error" role="alert">{error}</p>}
    </section>
  );
}

export type AgentRevisionSessionIdentity = Pick<
  AgentRevisionRecord,
  'mode' | 'originSessionId' | 'targetAgentName'
>;

function revisionFallbackOriginHref(originSessionId: string, project?: string): string {
  const params = new URLSearchParams();
  if (project) params.set('project', project);
  return `/sessions/${encodeURIComponent(originSessionId)}${params.size ? `?${params.toString()}` : ''}`;
}
