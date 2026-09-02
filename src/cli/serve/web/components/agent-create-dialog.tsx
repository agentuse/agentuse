import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ProviderStatus } from '../../../../auth/provider-status';
import type { ReasoningLevel } from '../../../../model-compatibility';
import type { ApprovalLogEntry } from '../../types';
import { useInternalAgentJob } from '../hooks/use-internal-agent-job';
import {
  fetchAgentCreationOptions,
  fetchProviderSetup,
  postSessionStop,
  startAgentCreationSession,
  type AgentCreationOptionsPayload,
  type AgentRow,
  type OnboardingJobHandle,
} from '../lib/api';
import { noAutofill } from '../lib/form';
import { agentDetailHref } from '../lib/links';
import { DashboardSelect } from './dashboard-select';
import { hasConfiguredProvider, ProviderSetupDialog } from './provider-setup';
import { SendToCodingAgentDialog } from './send-to-coding-agent-dialog';
import { OnboardingSessionLog } from './onboarding-session-log';

export interface AgentCreationDraft {
  projectId: string;
  projectPath: string;
  name?: string;
  objective: string;
  model: string;
  reasoning?: ReasoningLevel;
}

function defaultModel(payload: AgentCreationOptionsPayload): string {
  return payload.providers[0]?.defaultModel ?? payload.providers[0]?.models[0] ?? '';
}

function initialModelSelection(payload: AgentCreationOptionsPayload, requestedModel?: string): string {
  const requestedProvider = requestedModel
    ? payload.providers.find((provider) => provider.models.includes(requestedModel)
      || (provider.custom && requestedModel.startsWith(`${provider.id}:`)))
    : undefined;
  if (requestedProvider && requestedModel) return requestedModel;

  const provider = payload.providers[0];
  return defaultModel(payload) || (provider?.models[0] ?? '');
}

const CHATGPT_CREATOR_MODEL_LABELS: Readonly<Record<string, string>> = {
  'openai:gpt-5.6-luna': 'Fast · GPT-5.6 Luna',
  'openai:gpt-5.6-terra': 'Balanced · GPT-5.6 Terra',
  'openai:gpt-5.6-sol': 'Best · GPT-5.6 Sol',
};

const CREATOR_THINKING_OPTIONS: ReadonlyArray<{ value: ReasoningLevel; label: string }> = [
  { value: 'none', label: 'None' },
  { value: 'minimal', label: 'Minimal' },
  { value: 'low', label: 'Low' },
  { value: 'medium', label: 'Medium' },
  { value: 'high', label: 'High' },
  { value: 'xhigh', label: 'Extra high' },
  { value: 'max', label: 'Maximum' },
];

export function creationModelLabel(model: string, providerId: string): string {
  return CHATGPT_CREATOR_MODEL_LABELS[model] ?? model.replace(`${providerId}:`, '');
}

function creationModelOptions(payload: AgentCreationOptionsPayload): Array<{ value: string; label: string }> {
  return payload.providers.flatMap((provider) => provider.models.map((model) => ({
    value: model,
    label: `${provider.name} · ${creationModelLabel(model, provider.id)}`,
  })));
}

export type AgentCreationProgressPhase = 'creating' | 'success' | 'error';

export function AgentCreationProgressPanel(props: {
  phase: AgentCreationProgressPhase;
  modelLabel: string;
  job: OnboardingJobHandle | null;
  sessionStatus?: string;
  entries?: ApprovalLogEntry[];
  streamError?: string | null;
  error?: string | null;
  onBack?: () => void;
}) {
  const sessionHref = props.job && props.job.phase !== 'preparing' ? (() => {
    const params = new URLSearchParams({ project: props.job.projectId });
    if (props.job.sessionToken) params.set('token', props.job.sessionToken);
    return `/sessions/${encodeURIComponent(props.job.sessionId)}?${params.toString()}`;
  })() : null;
  return (
    <div class={`agent-create-progress is-${props.phase}`}>
      <div class="agent-create-progress-heading" role="status" aria-live="polite">
        {props.phase === 'creating'
          ? <span class="btn-spinner" aria-hidden="true" />
          : <span class="agent-create-progress-mark" aria-hidden="true">{props.phase === 'success' ? '✓' : '!'}</span>}
        <span>{props.phase === 'creating' ? `Working with ${props.modelLabel}` : props.phase === 'success' ? 'Agent saved' : 'Could not create the agent'}</span>
      </div>
      {props.job
        ? <OnboardingSessionLog
            job={props.job}
            title={`Creator session · ${props.modelLabel}`}
            status={props.sessionStatus ?? props.job.status}
            entries={props.entries ?? []}
            streamError={props.streamError}
          />
        : <p class="agent-create-loading">Starting the internal AgentUse creator session…</p>}
      {sessionHref && <a class="agent-create-session-link" href={sessionHref}>Open full session log</a>}
      {props.phase === 'error' && props.error && <p class="agent-create-error" role="alert">{props.error}</p>}
      {props.phase === 'creating' && <span class="agent-create-progress-hint">Keep this window open while the model finishes the draft.</span>}
      {props.phase === 'success' && <span class="agent-create-progress-hint">Opening your agent…</span>}
      {props.phase === 'error' && props.onBack && (
        <div class="agent-create-progress-actions"><button type="button" class="agent-create-escape" onClick={props.onBack}>Back to edit</button></div>
      )}
    </div>
  );
}

export function buildAgentCreationPrompt(draft: AgentCreationDraft, providerStatus?: ProviderStatus): string {
  const lines = [
    '# Create an AgentUse Agent',
    '',
    'Create and validate a persistent AgentUse agent in the project below.',
    '',
    '## Project',
    '',
    `- **Project:** ${draft.projectId}`,
    `- **Directory:** ${draft.projectPath}`,
  ];
  if (draft.name) lines.push(`- **Requested name:** ${draft.name}`);
  if (draft.objective) lines.push('', '## What I Want to Automate', '', draft.objective);
  if (providerStatus) {
    lines.push(
      '',
      '## Provider Status from AgentUse',
      '',
      'Use this redacted status as authoritative and choose only a configured provider:',
      '',
      '```json',
      JSON.stringify(providerStatus, null, 2),
      '```',
    );
  }
  lines.push(
    '',
    '## Required Workflow',
    '',
    '1. Use the `/agentuse` skill and load the version-matched authoring guidance:',
    '',
    '```sh',
    'agentuse skills get core --full',
    'agentuse skills get creator --full',
    'agentuse skills get tester --full',
    '```',
    '',
    '2. Create the narrowest useful `.agentuse` file in this project. Do not overwrite an existing agent.',
    '',
    '3. Validate it with `agentuse doctor <agent-file>` and `agentuse test <agent-file>`.',
    '',
    '4. Do not perform a real run. AgentUse serve is already running; do not restart or reconfigure it.',
  );
  return lines.join('\n');
}

export function AgentCreateDialog(props: {
  open: boolean;
  title?: string;
  initialProjectId?: string;
  initialModel?: string;
  initialDraft?: AgentCreationDraft | null;
  lockProject?: boolean;
  onCreated: (agent: AgentRow) => void;
  onCodingAgent?: (draft: AgentCreationDraft) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [payload, setPayload] = useState<AgentCreationOptionsPayload | null>(null);
  const [projectId, setProjectId] = useState('');
  const [model, setModel] = useState('');
  const [reasoning, setReasoning] = useState<ReasoningLevel>('medium');
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'form' | 'creating' | 'success' | 'error'>('form');
  const [activeJob, setActiveJob] = useState<OnboardingJobHandle | null>(null);
  const [createdAgent, setCreatedAgent] = useState<AgentRow | null>(null);
  const creatorSession = useInternalAgentJob(activeJob);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!props.open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [props.open]);

  useEffect(() => {
    if (!props.open) return;
    setPayload(null);
    setError(null);
    setBusy(false);
    setPhase('form');
    setActiveJob(null);
    setCreatedAgent(null);
    setProjectId('');
    setModel('');
    setReasoning(props.initialDraft?.reasoning ?? 'medium');
    setObjective(props.initialDraft?.objective ?? '');
    void fetchAgentCreationOptions().then((next) => {
      const initialSelection = initialModelSelection(next, props.initialDraft?.model ?? props.initialModel);
      setPayload(next);
      const requestedProjectId = props.initialDraft?.projectId ?? props.initialProjectId;
      setProjectId(requestedProjectId && next.projects.some((project) => project.id === requestedProjectId)
        ? requestedProjectId
        : next.default ?? next.projects[0]?.id ?? '');
      setModel(initialSelection);
    }, (caught) => setError((caught as Error).message || 'Could not load agent creation options.'));
  }, [props.open, props.initialProjectId, props.initialModel, props.initialDraft]);

  useEffect(() => {
    if (!props.open || phase !== 'creating') return;
    if (creatorSession.controllerError) {
      setError(creatorSession.controllerError);
      setPhase('error');
      setBusy(false);
      return;
    }
    const job = creatorSession.finalJob;
    if (!job) return;
    if (job.status === 'error') {
      setError(job.error?.message || 'The creator agent did not finish successfully.');
      setPhase('error');
      setBusy(false);
      return;
    }
    const agent = (job.result as { success: true; agent: AgentRow } | undefined)?.agent;
    if (!agent) {
      setError('The creator session ended before the agent was saved.');
      setPhase('error');
      setBusy(false);
      return;
    }
    setCreatedAgent(agent);
    setPhase('success');
    setBusy(false);
    props.onCreated(agent);
  }, [props.open, phase, creatorSession.finalJob, creatorSession.controllerError]);

  const modelOptions = payload ? creationModelOptions(payload) : [];
  const provider = payload?.providers.find((item) => item.models.includes(model)
    || (item.custom && model.startsWith(`${item.id}:`)));
  const project = payload?.projects.find((item) => item.id === projectId);
  const modelLabel = provider?.id && model.startsWith(`${provider.id}:`) ? model.slice(provider.id.length + 1) : model;
  const modelReady = modelOptions.some((option) => option.value === model);
  const canSubmit = Boolean(projectId && objective.trim() && modelReady && !busy);
  const draft = useMemo<AgentCreationDraft>(() => ({
    projectId,
    projectPath: project?.path ?? '',
    objective: objective.trim(),
    model: model.trim(),
    reasoning,
  }), [projectId, project?.path, objective, model, reasoning]);

  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    setCreatedAgent(null);
    setPhase('creating');
    try {
      const { job } = await startAgentCreationSession({
        project: projectId,
        objective: objective.trim(),
        model: model.trim(),
        reasoning,
      });
      setActiveJob(job);
    } catch (caught) {
      const message = (caught as Error).message || 'Could not create the agent.';
      setError(message);
      setPhase('error');
      setBusy(false);
    }
  };

  const close = () => {
    const currentJob = creatorSession.job ?? activeJob;
    if (busy && currentJob) {
      void postSessionStop(currentJob.sessionId, currentJob.sessionToken, {
        project: currentJob.projectId,
        reason: 'Agent creation cancelled from the New Agent dialog',
      });
    }
    props.onClose();
  };

  const backToEdit = () => {
    setPhase('form');
    setError(null);
    setActiveJob(null);
  };

  return (
    <dialog class="agent-create-dialog" ref={dialogRef} aria-labelledby="agent-create-title" onClose={close} onClick={(event) => { if (event.target === dialogRef.current) close(); }}>
      <div class="dialog-head"><span id="agent-create-title" class="title">{props.title ?? 'new agent'}</span><button type="button" class="dialog-close" aria-label={busy ? 'Cancel agent creation' : 'Close'} onClick={close}>×</button></div>
      <div class="agent-create-body">
        <div class="agent-create-intro">
          <strong>{phase === 'form' ? 'Create an agent' : phase === 'success' ? 'Agent saved' : phase === 'error' ? 'Creation stopped' : 'Creating your agent'}</strong>
          <span>{phase === 'form'
            ? 'Describe the job. Choose a model to design the agent.'
            : phase === 'success'
              ? `${createdAgent?.name ?? 'Your agent'} is saved. Review its model, tools, and instructions before running it.`
              : phase === 'error'
                ? 'Review what happened below, then return to the form and try again.'
                : `${modelLabel} is designing the agent from your brief.`}</span>
        </div>
        {!payload && !error && <p class="agent-create-loading">Loading your projects and models…</p>}
        {payload && phase === 'form' && (
          <div class="agent-create-form">
            {payload.projects.length > 1 && !props.lockProject ? (
              <div class="agent-create-field"><span>Project</span><DashboardSelect value={projectId} options={payload.projects.map((item) => ({ value: item.id, label: item.id }))} disabled={busy} onChange={setProjectId} ariaLabel="Project" /></div>
            ) : project ? (
              <div class="agent-create-project"><span>Project</span><strong>{project.id}</strong><code>{project.path}</code></div>
            ) : null}
            <span class="agent-create-model-hint">AgentUse checks this project and its available project and global skills. Only relevant skills are included; review the agent&apos;s tools before running.</span>
            <label class="agent-create-field"><span>What should this agent do?</span><textarea value={objective} placeholder="Summarize new support tickets and highlight urgent replies." disabled={busy} {...noAutofill} onInput={(event) => setObjective((event.target as HTMLTextAreaElement).value)} /></label>
            <div class="agent-create-creator-row">
              <div class="agent-create-field"><span>Creator provider model</span><DashboardSelect value={model} options={modelOptions} disabled={busy || modelOptions.length === 0} onChange={setModel} ariaLabel="Creator provider model" placeholder="Choose a provider and model…" /></div>
              <div class="agent-create-field"><span>Thinking effort</span><DashboardSelect value={reasoning} options={CREATOR_THINKING_OPTIONS} disabled={busy} onChange={(value) => setReasoning(value as ReasoningLevel)} ariaLabel="Thinking effort" /></div>
            </div>
            <span class="agent-create-model-hint">Used to design the agent; its runtime model is chosen separately.</span>
            {error && <p class="agent-create-error" role="alert">{error}</p>}
            <div class="agent-create-actions">
              <button type="button" class="agent-create-primary" disabled={!canSubmit} aria-busy={busy} onClick={() => void submit()}>{busy ? `Designing with ${modelLabel}…` : 'Create agent'}</button>
            </div>
            {props.onCodingAgent && (
              <div class="agent-create-handoff">
                <span class="agent-create-handoff-copy"><strong>Need code or custom integrations?</strong><span>Use your coding agent when the setup needs scripts, dependencies, or project-specific code.</span></span>
                <button type="button" class="agent-create-escape" disabled={busy || !projectId} onClick={() => props.onCodingAgent?.(draft)}>Copy prompt to coding agent</button>
              </div>
            )}
          </div>
        )}
        {payload && phase !== 'form' && (
          <AgentCreationProgressPanel
            phase={phase}
            modelLabel={modelLabel}
            job={creatorSession.job ?? activeJob}
            sessionStatus={creatorSession.sessionStatus}
            entries={creatorSession.entries}
            streamError={creatorSession.streamError}
            error={error}
            onBack={backToEdit}
          />
        )}
        {!payload && error && <p class="agent-create-error" role="alert">{error}</p>}
      </div>
    </dialog>
  );
}

/** Normal Agents-view entry point. Onboarding uses the same dialog from its session CTA. */
export function NewAgentButton(props: { initialProjectId?: string; autoOpen?: boolean }) {
  const [createOpen, setCreateOpen] = useState(false);
  const [providerOpen, setProviderOpen] = useState(false);
  const [codingOpen, setCodingOpen] = useState(false);
  const [draft, setDraft] = useState<AgentCreationDraft | null>(null);
  const [providerStatus, setProviderStatus] = useState<ProviderStatus | undefined>(undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const begin = async () => {
    setBusy(true);
    setError(null);
    try {
      const payload = await fetchProviderSetup();
      setProviderStatus(payload.status);
      if (hasConfiguredProvider(payload.status)) setCreateOpen(true);
      else setProviderOpen(true);
    } catch (caught) {
      setError((caught as Error).message || 'Could not read provider status.');
    } finally {
      setBusy(false);
    }
  };

  // The command palette links here with ?new=1 rather than reaching into this
  // button's state, so the provider check still runs before the dialog opens.
  const started = useRef(false);
  useEffect(() => {
    if (!props.autoOpen || started.current) return;
    started.current = true;
    void begin();
  }, [props.autoOpen]);

  return (
    <>
      <button type="button" class="new-agent-button" disabled={busy} aria-busy={busy} onClick={() => void begin()}><span aria-hidden="true">＋</span>{busy ? 'Checking…' : 'New agent'}</button>
      {error && <span class="new-agent-error" role="alert">{error}</span>}
      <AgentCreateDialog
        open={createOpen}
        initialDraft={draft}
        {...(props.initialProjectId ? { initialProjectId: props.initialProjectId } : {})}
        {...(props.initialProjectId ? { lockProject: true } : {})}
        onCreated={(agent) => {
          window.location.href = agentDetailHref(agent.projectId, agent.runPath, { tab: 'source' });
        }}
        onCodingAgent={(nextDraft) => { setDraft(nextDraft); setCreateOpen(false); setCodingOpen(true); }}
        onClose={() => setCreateOpen(false)}
      />
      <ProviderSetupDialog
        open={providerOpen}
        title="new agent"
        onComplete={(payload) => { setProviderStatus(payload.status); setProviderOpen(false); setCreateOpen(true); }}
        onClose={() => setProviderOpen(false)}
      />
      <SendToCodingAgentDialog
        open={codingOpen && draft !== null}
        title="create an agent with a coding agent"
        buildPrompt={(detail) => draft ? buildAgentCreationPrompt({ ...draft, objective: detail.trim() || draft.objective }, providerStatus) : ''}
        initialDetail={draft?.objective ?? ''}
        detailFirst
        promptCollapsed
        detailLabel="What should this agent do?"
        placeholder="Describe the task and desired outcome"
        copyLabel="Copy instructions"
        copyHint="Paste into Codex, Claude Code, Cursor, or another coding agent."
        contextLabel="Your agent will be saved in"
        contextValue={draft?.projectPath ?? ''}
        onClose={() => setCodingOpen(false)}
      />
    </>
  );
}
