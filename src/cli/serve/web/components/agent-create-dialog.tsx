import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ProviderStatus } from '../../../../auth/provider-status';
import {
  createAgentWithProgress,
  fetchAgentCreationOptions,
  fetchProviderSetup,
  type AgentCreationOptionsPayload,
  type AgentRow,
} from '../lib/api';
import { noAutofill } from '../lib/form';
import { agentDetailHref } from '../lib/links';
import { DashboardSelect } from './dashboard-select';
import { hasConfiguredProvider, ProviderSetupDialog } from './provider-setup';
import { SendToCodingAgentDialog } from './send-to-coding-agent-dialog';

export interface AgentCreationDraft {
  projectId: string;
  projectPath: string;
  name: string;
  objective: string;
  model: string;
}

function defaultModel(payload: AgentCreationOptionsPayload): string {
  return payload.providers[0]?.defaultModel ?? payload.providers[0]?.models[0] ?? '';
}

function initialModelSelection(payload: AgentCreationOptionsPayload, requestedModel?: string): { providerId: string; model: string } {
  const requestedProvider = requestedModel
    ? payload.providers.find((provider) => provider.models.includes(requestedModel)
      || (provider.custom && requestedModel.startsWith(`${provider.id}:`)))
    : undefined;
  if (requestedProvider && requestedModel) return { providerId: requestedProvider.id, model: requestedModel };

  const provider = payload.providers[0];
  return {
    providerId: provider?.id ?? '',
    model: defaultModel(payload) || (provider?.custom ? `${provider.id}:` : ''),
  };
}

const CHATGPT_CREATOR_MODEL_LABELS: Readonly<Record<string, string>> = {
  'openai:gpt-5.6-luna': 'Fast · GPT-5.6 Luna',
  'openai:gpt-5.6-terra': 'Balanced · GPT-5.6 Terra',
  'openai:gpt-5.6-sol': 'Best · GPT-5.6 Sol',
};

export function creationModelLabel(model: string, providerId: string): string {
  return CHATGPT_CREATOR_MODEL_LABELS[model] ?? model.replace(`${providerId}:`, '');
}

export type AgentCreationProgressPhase = 'creating' | 'success' | 'error';

/** Shared streamed creation log used by both manual and discovery-based creation. */
export function AgentCreationProgressPanel(props: {
  phase: AgentCreationProgressPhase;
  modelLabel: string;
  logText: string;
  error?: string | null;
  onBack?: () => void;
}) {
  const logRef = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    const log = logRef.current;
    if (log) log.scrollTop = log.scrollHeight;
  }, [props.logText]);
  return (
    <div class={`agent-create-progress is-${props.phase}`}>
      <div class="agent-create-progress-heading" role="status" aria-live="polite">
        {props.phase === 'creating'
          ? <span class="btn-spinner" aria-hidden="true" />
          : <span class="agent-create-progress-mark" aria-hidden="true">{props.phase === 'success' ? '✓' : '!'}</span>}
        <span>{props.phase === 'creating' ? `Working with ${props.modelLabel}` : props.phase === 'success' ? 'Agent saved' : 'Could not create the agent'}</span>
      </div>
      <label class="agent-create-log-label" for="agent-create-log">Creation log</label>
      <textarea
        id="agent-create-log"
        ref={logRef}
        class="agent-create-log"
        value={props.logText}
        readOnly
        spellcheck={false}
        aria-label="Agent creation log"
      />
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
  lockProject?: boolean;
  onCreated: (agent: AgentRow) => void;
  onCodingAgent?: (draft: AgentCreationDraft) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestRef = useRef<AbortController | null>(null);
  const sawDraftRef = useRef(false);
  const errorReportedRef = useRef(false);
  const [payload, setPayload] = useState<AgentCreationOptionsPayload | null>(null);
  const [projectId, setProjectId] = useState('');
  const [providerId, setProviderId] = useState('');
  const [model, setModel] = useState('');
  const [agentName, setAgentName] = useState('');
  const [objective, setObjective] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [phase, setPhase] = useState<'form' | 'creating' | 'success' | 'error'>('form');
  const [logText, setLogText] = useState('');
  const [createdAgent, setCreatedAgent] = useState<AgentRow | null>(null);

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
    setLogText('');
    setCreatedAgent(null);
    setProjectId('');
    setProviderId('');
    setModel('');
    setAgentName('');
    setObjective('');
    sawDraftRef.current = false;
    errorReportedRef.current = false;
    void fetchAgentCreationOptions().then((next) => {
      const initialSelection = initialModelSelection(next, props.initialModel);
      setPayload(next);
      setProjectId(props.initialProjectId && next.projects.some((project) => project.id === props.initialProjectId)
        ? props.initialProjectId
        : next.default ?? next.projects[0]?.id ?? '');
      setProviderId(initialSelection.providerId);
      setModel(initialSelection.model);
    }, (caught) => setError((caught as Error).message || 'Could not load agent creation options.'));
  }, [props.open, props.initialProjectId, props.initialModel]);

  const provider = payload?.providers.find((item) => item.id === providerId);
  const project = payload?.projects.find((item) => item.id === projectId);
  const customProvider = provider?.custom === true;
  const modelLabel = model.startsWith(`${providerId}:`) ? model.slice(providerId.length + 1) : model;
  const modelReady = customProvider
    ? model.startsWith(`${providerId}:`) && Boolean(model.slice(providerId.length + 1).trim())
    : Boolean(model.trim());
  const canSubmit = Boolean(projectId && objective.trim() && modelReady && !busy);
  const draft = useMemo<AgentCreationDraft>(() => ({
    projectId,
    projectPath: project?.path ?? '',
    name: agentName.trim(),
    objective: objective.trim(),
    model: model.trim(),
  }), [projectId, project?.path, agentName, objective, model]);

  const selectProvider = (nextProviderId: string) => {
    setProviderId(nextProviderId);
    const next = payload?.providers.find((item) => item.id === nextProviderId);
    setModel(next?.defaultModel ?? next?.models[0] ?? (next?.custom ? `${next.id}:` : ''));
  };

  const submit = async () => {
    if (!canSubmit) return;
    const controller = new AbortController();
    requestRef.current = controller;
    setBusy(true);
    setError(null);
    setCreatedAgent(null);
    setPhase('creating');
    setLogText('[agentuse] Starting agent creation\n');
    sawDraftRef.current = false;
    errorReportedRef.current = false;
    try {
      const agent = await createAgentWithProgress(
        {
          project: projectId,
          ...(agentName.trim() && { name: agentName.trim() }),
          objective: objective.trim(),
          model: model.trim(),
        },
        (event) => {
          if (event.type === 'status') {
            setLogText((current) => `${current}\n[agentuse] ${event.message}\n`);
          } else if (event.type === 'draft') {
            const heading = sawDraftRef.current ? '' : '\n[model draft]\n';
            sawDraftRef.current = true;
            setLogText((current) => `${current}${heading}${event.text}`);
          } else if (event.type === 'complete') {
            setLogText((current) => `${current}\n[agentuse] Saved ${event.agent.name}\n`);
          } else {
            errorReportedRef.current = true;
            setError(event.error.message);
            setLogText((current) => `${current}\n[error] ${event.error.message}\n`);
          }
        },
        controller.signal,
      );
      setCreatedAgent(agent);
      setPhase('success');
      props.onCreated(agent);
    } catch (caught) {
      if ((caught as Error).name === 'AbortError') return;
      const message = (caught as Error).message || 'Could not create the agent.';
      setError(message);
      if (!errorReportedRef.current) setLogText((current) => `${current}\n[error] ${message}\n`);
      setPhase('error');
    } finally {
      requestRef.current = null;
      setBusy(false);
    }
  };

  const close = () => {
    requestRef.current?.abort();
    props.onClose();
  };

  const backToEdit = () => {
    setPhase('form');
    setError(null);
    setLogText('');
    sawDraftRef.current = false;
    errorReportedRef.current = false;
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
            <label class="agent-create-field"><span>What should this agent do?</span><textarea value={objective} placeholder="Summarize new support tickets and highlight urgent replies." disabled={busy} {...noAutofill} onInput={(event) => setObjective((event.target as HTMLTextAreaElement).value)} /></label>
            <label class="agent-create-field"><span>Agent name <em>optional</em></span><input value={agentName} placeholder="Support Ticket Triage" disabled={busy} {...noAutofill} onInput={(event) => setAgentName((event.target as HTMLInputElement).value)} /></label>
            <div class="agent-create-model-row">
              <div class="agent-create-field"><span>Creator provider</span><DashboardSelect value={providerId} options={payload.providers.map((item) => ({ value: item.id, label: item.name }))} disabled={busy} onChange={selectProvider} ariaLabel="Creator provider" /></div>
              {customProvider ? (
                <label class="agent-create-field"><span>Creator model ID</span><input value={model} placeholder={`${providerId}:model-name`} disabled={busy} {...noAutofill} onInput={(event) => setModel((event.target as HTMLInputElement).value)} /></label>
              ) : (
                <div class="agent-create-field"><span>Creator model</span><DashboardSelect value={model} options={(provider?.models ?? []).map((item) => ({ value: item, label: creationModelLabel(item, providerId) }))} disabled={busy} onChange={setModel} ariaLabel="Creator model" /></div>
              )}
            </div>
            <span class="agent-create-model-hint">Used only to create the agent. It will choose a suitable connected runtime model for the job.</span>
            {error && <p class="agent-create-error" role="alert">{error}</p>}
            <div class="agent-create-actions">
              <button type="button" class="agent-create-primary" disabled={!canSubmit} aria-busy={busy} onClick={() => void submit()}>{busy ? `Designing with ${modelLabel}…` : 'Create agent'}</button>
            </div>
            {props.onCodingAgent && (
              <div class="agent-create-handoff">
                <span class="agent-create-handoff-copy"><strong>Want more control?</strong><span>If you’re more hands-on, copy the setup prompt to your coding agent instead.</span></span>
                <button type="button" class="agent-create-escape" disabled={busy || !projectId} onClick={() => props.onCodingAgent?.(draft)}>Copy prompt to coding agent</button>
              </div>
            )}
          </div>
        )}
        {payload && phase !== 'form' && (
          <AgentCreationProgressPanel
            phase={phase}
            modelLabel={modelLabel}
            logText={logText}
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
export function NewAgentButton(props: { initialProjectId?: string }) {
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

  return (
    <>
      <button type="button" class="new-agent-button" disabled={busy} aria-busy={busy} onClick={() => void begin()}><span aria-hidden="true">＋</span>{busy ? 'Checking…' : 'New agent'}</button>
      {error && <span class="new-agent-error" role="alert">{error}</span>}
      <AgentCreateDialog
        open={createOpen}
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
