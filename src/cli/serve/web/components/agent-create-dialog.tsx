import { useEffect, useMemo, useRef, useState } from 'preact/hooks';
import type { ProviderStatus } from '../../../../auth/provider-status';
import type { ReasoningLevel } from '../../../../model-compatibility';
import {
  fetchAgentCreationOptions,
  fetchProviderSetup,
  startAgentCreationSession,
  type AgentCreationOptionsPayload,
  type AgentCreationSkillPool,
  type OnboardingJobHandle,
} from '../lib/api';
import { noAutofill } from '../lib/form';
import { agentDraftHref } from '../lib/links';
import { DashboardSelect } from './dashboard-select';
import { hasConfiguredProvider, ProviderSetupDialog } from './provider-setup';
import { SendToCodingAgentDialog } from './send-to-coding-agent-dialog';

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
  return model.replace(`${providerId}:`, '');
}

function creationModelOptions(payload: AgentCreationOptionsPayload): Array<{ value: string; label: string }> {
  return payload.providers.flatMap((provider) => provider.models.map((model) => ({
    value: model,
    label: `${provider.name} · ${creationModelLabel(model, provider.id)}`,
  })));
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

/**
 * The skill pool the creator can draw on, shown while the brief is still
 * editable: a thin catalog usually means a thin agent, and that is worth
 * knowing before the session starts rather than after the draft lands.
 */
export function AgentCreationSkills(props: { pool: AgentCreationSkillPool }) {
  const [expanded, setExpanded] = useState(false);
  const { counts, items } = props.pool;
  const shown = expanded ? items : items.slice(0, 6);
  const hidden = items.length - shown.length;
  return (
    <div class="agent-create-skills">
      <div class="agent-create-skills-head">
        <span>Skills the creator can use</span>
        <button type="button" class="agent-create-skills-toggle" aria-expanded={expanded} onClick={() => setExpanded((value) => !value)}>
          {expanded ? 'Hide' : 'Show'}
        </button>
      </div>
      <div class="agent-create-skills-counts">
        <span class="is-project">{counts.project} project</span>
        <span class="is-global">{counts.global} global</span>
        {counts.ambiguous > 0 && <span class="is-ambiguous">{counts.ambiguous} ambiguous</span>}
      </div>
      {expanded && (
        <div class="agent-create-skills-list">
          {shown.map((skill) => (
            <span class={skill.ambiguous ? 'is-ambiguous' : ''} key={`${skill.source}:${skill.name}`}>
              <code>{skill.name}</code> · {skill.ambiguous ? 'ambiguous, more than one copy' : skill.source}
            </span>
          ))}
          {hidden > 0 && <span class="is-more">+ {hidden} more</span>}
        </div>
      )}
      <span class="agent-create-skills-note">
        A skill is a folder of instructions the agent can load for a tool or a task.
        {items.length === 0
          ? ' None were found, so this agent will be thin unless you add one.'
          : ' Few skills here usually means a thin agent.'}
      </span>
    </div>
  );
}

export function AgentCreateDialog(props: {
  open: boolean;
  title?: string;
  initialProjectId?: string;
  initialModel?: string;
  initialDraft?: AgentCreationDraft | null;
  lockProject?: boolean;
  /** The creator session started; the draft page takes it from here. */
  onDrafted: (job: OnboardingJobHandle) => void;
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
    setProjectId('');
    setModel('');
    setReasoning(props.initialDraft?.reasoning ?? 'medium');
    setObjective(props.initialDraft?.objective ?? '');
    void fetchAgentCreationOptions(props.initialDraft?.projectId ?? props.initialProjectId).then((next) => {
      const initialSelection = initialModelSelection(next, props.initialDraft?.model ?? props.initialModel);
      setPayload(next);
      const requestedProjectId = props.initialDraft?.projectId ?? props.initialProjectId;
      setProjectId(requestedProjectId && next.projects.some((project) => project.id === requestedProjectId)
        ? requestedProjectId
        : next.default ?? next.projects[0]?.id ?? '');
      setModel(initialSelection);
    }, (caught) => setError((caught as Error).message || 'Could not load agent creation options.'));
  }, [props.open, props.initialProjectId, props.initialModel, props.initialDraft]);

  // The skill pool belongs to the selected project, so switching project on a
  // multi-project daemon has to re-read it rather than keep showing the first
  // project's counts.
  useEffect(() => {
    if (!props.open || !payload || !projectId || payload.skills?.project === projectId) return;
    let cancelled = false;
    void fetchAgentCreationOptions(projectId).then((next) => {
      const pool = next.skills;
      if (!cancelled && pool) setPayload((current) => (current ? { ...current, skills: pool } : current));
    }, () => undefined);
    return () => { cancelled = true; };
  }, [props.open, projectId, payload?.skills?.project]);

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

  // The dialog's job ends the moment the creator session exists: the draft page
  // owns the wait, the log, and the review, so the operator is never held in a
  // modal while a model works.
  const submit = async () => {
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const { job } = await startAgentCreationSession({
        project: projectId,
        objective: objective.trim(),
        model: model.trim(),
        reasoning,
      });
      props.onDrafted(job);
    } catch (caught) {
      setError((caught as Error).message || 'Could not start the creator session.');
      setBusy(false);
    }
  };

  const close = () => {
    props.onClose();
  };

  return (
    <dialog class="agent-create-dialog" ref={dialogRef} aria-labelledby="agent-create-title" onClose={close} onClick={(event) => { if (event.target === dialogRef.current) close(); }}>
      <div class="dialog-head"><span id="agent-create-title" class="title">{props.title ?? 'new agent'}</span><button type="button" class="dialog-close" aria-label="Close" onClick={close}>×</button></div>
      <div class="agent-create-body">
        <div class="agent-create-intro">
          <strong>New agent</strong>
          <span>Describe the job. The creator drafts the file, then you refine it before saving.</span>
        </div>
        {!payload && !error && <p class="agent-create-loading">Loading your projects and models…</p>}
        {payload && (
          <div class="agent-create-form">
            {payload.projects.length > 1 && !props.lockProject ? (
              <div class="agent-create-field"><span>Project</span><DashboardSelect value={projectId} options={payload.projects.map((item) => ({ value: item.id, label: item.id }))} disabled={busy} onChange={setProjectId} ariaLabel="Project" /></div>
            ) : project ? (
              <div class="agent-create-project"><span>Project</span><strong>{project.id}</strong><code>{project.path}</code></div>
            ) : null}
            {payload.skills && <AgentCreationSkills pool={payload.skills} />}
            <label class="agent-create-field"><span>What should this agent do?</span><textarea value={objective} placeholder="Summarize new support tickets and highlight urgent replies." disabled={busy} {...noAutofill} onInput={(event) => setObjective((event.target as HTMLTextAreaElement).value)} /><small>One or two sentences is enough. You can ask for changes after the first draft.</small></label>
            <div class="agent-create-creator-row">
              <div class="agent-create-field"><span>Creator provider model</span><DashboardSelect value={model} options={modelOptions} disabled={busy || modelOptions.length === 0} onChange={setModel} ariaLabel="Creator provider model" placeholder="Choose a provider and model…" /></div>
              <div class="agent-create-field"><span>Thinking effort</span><DashboardSelect value={reasoning} options={CREATOR_THINKING_OPTIONS} disabled={busy} onChange={(value) => setReasoning(value as ReasoningLevel)} ariaLabel="Thinking effort" /></div>
            </div>
            <span class="agent-create-model-hint">Used to design the agent; its runtime model is chosen separately.</span>
            {error && <p class="agent-create-error" role="alert">{error}</p>}
            <div class="agent-create-actions">
              <button type="button" class="agent-create-primary" disabled={!canSubmit} aria-busy={busy} onClick={() => void submit()}>{busy ? `Starting ${modelLabel}…` : 'Draft agent'}</button>
            </div>
            {props.onCodingAgent && (
              <div class="agent-create-handoff">
                <span class="agent-create-handoff-copy"><strong>Need code or custom integrations?</strong><span>Use your coding agent when the setup needs scripts, dependencies, or project-specific code.</span></span>
                <button type="button" class="agent-create-escape" disabled={busy || !projectId} onClick={() => props.onCodingAgent?.(draft)}>Copy prompt to coding agent</button>
              </div>
            )}
          </div>
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
        onDrafted={(job) => {
          window.location.href = agentDraftHref(job.projectId, job.id);
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
