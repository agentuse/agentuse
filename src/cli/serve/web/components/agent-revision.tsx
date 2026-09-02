import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ReasoningLevel } from '../../../../model-compatibility';
import type { AgentRevisionRecord } from '../../../../agents/revision';
import { revisionLineDiff } from '../lib/revision-diff';
import {
  fetchAgentCreationOptions,
  fetchAgentRevision,
  fetchAgentRevisions,
  fetchSessionRevisions,
  postAgentRevisionAction,
  requestAgentRevisionChanges,
  startAgentRevision,
  ApiRequestError,
  type AgentRevisionSummary,
} from '../lib/api';
import { buildDebugPrompt, type DebugPromptContext } from './debug-prompt-button';
import { copyText } from './send-to-coding-agent-dialog';

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

export function revisionLabel(revision: Pick<AgentRevisionSummary, 'status'>): string {
  if (revision.status === 'running') return 'Revision session is running';
  if (revision.status === 'proposed') return 'Revision ready to review';
  if (revision.status === 'no-change') return 'Revision needs review';
  if (revision.status === 'accepted') return 'Diagnosis accepted';
  if (revision.status === 'applied') return 'Revision applied';
  if (revision.status === 'restored') return 'Previous source restored';
  if (revision.status === 'discarded') return 'Revision discarded';
  return 'Revision stopped';
}

export function revisionOriginDescription(revision: Pick<AgentRevisionSummary, 'status' | 'targetAgentName'>): string {
  if (revision.status === 'no-change') return 'Review this diagnosis before starting another revision.';
  if (revision.status === 'accepted') return 'No agent source change was made. You can start another revision.';
  return `Revising ${revision.targetAgentName} from this run.`;
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
  /** A run paused at an approval gate is the clearest evidence of a bad step, so it can be revised too. */
  atGate?: boolean;
  token?: string | undefined;
  /** Agent pages use the same safe revision flow with a context-specific action label and visual weight. */
  buttonLabel?: string | undefined;
  buttonClassName?: string | undefined;
  buttonTitle?: string | undefined;
}) {
  const [open, setOpen] = useState(false);
  const [handoffCopied, setHandoffCopied] = useState(false);
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
    setInstruction('');
    setOpen(false);
    setHandoffCopied(false);
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
  // A finished revision is history, not a task: it collapses to a quiet line so
  // the agent header keeps reading as a row of actions.
  const showCard = Boolean(latest) && (active || latest!.status === 'no-change');
  if ((!props.ended && !props.atGate) || !props.context.agentFilePath) return null;

  return (
    <>
      {latest && showCard && !open && (
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
                <span>Revision · {relativeTime(revision.updatedAt)}</span>
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
      {historyLoaded && !showCard && !open && (
        <button
          type="button"
          class={props.buttonClassName ?? `debug-prompt-button${props.atGate ? '' : ' is-primary'}`}
          title={props.buttonTitle ?? "Diagnose this run and propose a change to this agent's source"}
          onClick={() => void begin()}
        >
          <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
            <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
          </svg>
          <span>{props.buttonLabel ?? 'Revise agent file'}</span>
        </button>
      )}
      {open && <section class="agent-revision-form" aria-labelledby="agent-revision-title">
        <div class="agent-revision-form-head"><span id="agent-revision-title">Revise {props.context.agentName ?? 'this agent'}</span><button type="button" aria-label="Close revision form" disabled={busy} onClick={() => setOpen(false)}>×</button></div>
        <div class="agent-revision-form-body">
          <div class="agent-revision-intro"><span>Start one internal session to diagnose this run and propose a safe source change. Nothing changes until you review and apply it.</span></div>
          <p class="agent-revision-gate-note">This changes the agent file for future runs, not this run.{props.atGate ? ' Approve or reject the pending step to continue this one.' : ''}</p>
          <label class="agent-revision-field"><span>What should change?</span><textarea value={instruction} disabled={busy} placeholder="e.g. exclude refunded orders, or make results shorter without missing urgent tickets" onInput={(event) => setInstruction((event.target as HTMLTextAreaElement).value)} /></label>
          <div class="agent-revision-models">
            <label class="agent-revision-field"><span>Authoring model</span><select value={model} disabled={busy || loadingOptions} onChange={(event) => { const value = (event.target as HTMLSelectElement).value; setModel(value); storeAuthoring({ model: value }); }}>{models.map((option) => <option value={option.value}>{option.label}</option>)}</select></label>
            <label class="agent-revision-field"><span>Thinking effort</span><select value={reasoning} disabled={busy} onChange={(event) => { const value = (event.target as HTMLSelectElement).value as ReasoningLevel; setReasoning(value); storeAuthoring({ reasoning: value }); }}><option value="low">Low</option><option value="medium">Medium</option><option value="high">High</option></select></label>
          </div>
          {error && <p class="agent-revision-error" role="alert">{error}{errorHref && <> <a href={errorHref}>Open it</a></>}</p>}
          <div class="agent-revision-actions"><button type="button" class="agent-revision-primary" disabled={busy || loadingOptions || !instruction.trim() || !model} onClick={() => void submit()}>{busy ? 'Starting revision…' : 'Start revision session'}</button></div>
          <div class="agent-revision-handoff">
            <span><strong>Need project code or a custom integration?</strong><small>Use your coding agent when the change is larger than this AgentUse file.</small></span>
            <button type="button" disabled={busy} onClick={() => { void copyText(buildDebugPrompt(props.context, instruction)).then((ok) => { if (!ok) return; setHandoffCopied(true); setTimeout(() => setHandoffCopied(false), 2000); }); }}>{handoffCopied ? 'Prompt copied — paste it into your coding agent' : 'Copy prompt for Coding Agent'}</button>
          </div>
        </div>
      </section>}
    </>
  );
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
  const [busy, setBusy] = useState<'apply' | 'discard' | 'restore' | 'cancel' | null>(null);
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

  const act = async (action: 'apply' | 'discard' | 'restore' | 'cancel') => {
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
    ? revisionLineDiff((revision.baseSource ?? props.currentSource)!, revision.proposedSource)
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
      {revision.status === 'running' && props.sessionStatus === 'preparing' && <p>AgentUse is preparing a safe project view. The reviser will start automatically when its context is ready.</p>}
      {revision.status === 'running' && props.sessionStatus !== 'preparing' && props.sessionStatus !== 'waiting' && <p>AgentUse is diagnosing the originating run. You can leave; this revision remains available from that run and Sessions.</p>}
      {revision.status === 'running' && props.sessionStatus === 'waiting' && <p>The reviser needs your decision below. Answering resumes this same internal session.</p>}
      {revision.status === 'running' && <div class="agent-revision-review-actions"><button type="button" class="is-quiet" disabled={busy !== null} onClick={() => void act('cancel')}>{busy === 'cancel' ? 'Cancelling…' : 'Cancel revision'}</button></div>}
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
          <div class="agent-revision-proposal-title"><strong>{revision.summary}</strong><span>No changes applied yet.</span></div>
          <div class="agent-revision-capabilities">
            <strong>Capability review</strong>
            {revision.capabilityChanges && revision.capabilityChanges.length > 0
              ? <ul>{revision.capabilityChanges.map((change) => <li>{change}</li>)}</ul>
              : <span>No model, schedule, tool, skill, integration, sub-agent, or channel changes.</span>}
          </div>
          <pre class="agent-revision-diff" aria-label="Proposed agent source changes">{diff.length > 0 ? diff.map((line) => <span class={`is-${line.kind}`}>{line.kind === 'add' ? '+ ' : line.kind === 'remove' ? '- ' : line.kind === 'same' ? '  ' : ''}{line.text}{'\n'}</span>) : revision.proposedSource}</pre>
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
  'originSessionId' | 'targetAgentName'
>;

function revisionFallbackOriginHref(originSessionId: string, project?: string): string {
  const params = new URLSearchParams();
  if (project) params.set('project', project);
  return `/sessions/${encodeURIComponent(originSessionId)}${params.size ? `?${params.toString()}` : ''}`;
}


/**
 * Revision history for one agent. The agent header only carries the action and
 * anything still awaiting a decision; everything finished reads better as a
 * list in its own tab, next to jobs and learnings.
 */
export function AgentRevisionsPanel(props: { project: string; path: string }) {
  const [revisions, setRevisions] = useState<AgentRevisionSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const payload = await fetchAgentRevisions(props.project, props.path);
        if (!cancelled) { setRevisions(payload.revisions); setError(null); }
      } catch (caught) {
        if (!cancelled) { setError((caught as Error).message); setRevisions([]); }
      }
    })();
    return () => { cancelled = true; };
  }, [props.project, props.path]);

  if (error) return <p class="empty err">{error}</p>;
  if (revisions === null) return <p class="empty">Loading revisions…</p>;
  if (revisions.length === 0) {
    return <p class="empty">No revisions yet. Use <strong>Revise Agent</strong> to diagnose a run and propose a change to this agent.</p>;
  }

  return (
    <div class="agent-revision-list">
      {revisions.map((revision) => (
        <a
          class={`agent-revision-link is-${revision.status}`}
          key={revision.revisionSessionId}
          href={revisionHref(revision, undefined, props.project)}
        >
          <span class="agent-revision-link-copy">
            <strong>
              {ACTIVE_REVISION_STATUSES.has(revision.status) && revision.status === 'running'
                && <span class="agent-revision-pulse" aria-hidden="true" />}
              {revisionLabel(revision)}
            </strong>
            <span>{revision.summary || revision.instruction}</span>
          </span>
          <span class="agent-revision-link-time">{relativeTime(revision.updatedAt)}</span>
        </a>
      ))}
    </div>
  );
}
