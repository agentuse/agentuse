import { useEffect, useRef, useState } from 'preact/hooks';
import { agentDetailHref, projectDiscoveryHref } from '../lib/links';
import {
  createAgentWithProgress,
  discoverProjectAgents,
  fetchAgentCreationOptions,
  fetchProviderSetup,
  type AgentCreationOptionsPayload,
  type ProjectAgentSuggestion,
  type ProjectDiscoveryPayload,
  type ProviderSetupPayload,
} from '../lib/api';
import {
  AgentCreateDialog,
  AgentCreationProgressPanel,
  creationModelLabel,
  type AgentCreationProgressPhase,
} from './agent-create-dialog';
import { DashboardSelect } from './dashboard-select';
import { hasConfiguredProvider, ProviderSetupDialog } from './provider-setup';

type DiscoveryStage = 'provider' | 'ready' | 'scanning' | 'scan-error' | 'suggestions' | 'creating' | 'creation-error';

function setProviderRouteState(projectId: string, open: boolean): void {
  history.replaceState(null, '', projectDiscoveryHref(projectId, { ...(open && { connectProvider: true }) }));
}

export function ProjectAgentDiscovery(props: {
  projectId: string;
  projectName?: string;
  projectPath: string;
  compact?: boolean;
  existingAgents?: boolean;
}) {
  const [stage, setStage] = useState<DiscoveryStage>('provider');
  const [providerPayload, setProviderPayload] = useState<ProviderSetupPayload | null>(null);
  const [creationOptions, setCreationOptions] = useState<AgentCreationOptionsPayload | null>(null);
  const [providerOpen, setProviderOpen] = useState(() => typeof window !== 'undefined' && new URLSearchParams(window.location.search).get('provider') === 'connect');
  const [discovery, setDiscovery] = useState<ProjectDiscoveryPayload | null>(null);
  const [model, setModel] = useState<string | null>(null);
  const [directCreateOpen, setDirectCreateOpen] = useState(false);
  const [creatingId, setCreatingId] = useState<string | null>(null);
  const [retrySuggestion, setRetrySuggestion] = useState<ProjectAgentSuggestion | null>(null);
  const [retryScan, setRetryScan] = useState(false);
  const [creationPhase, setCreationPhase] = useState<AgentCreationProgressPhase | null>(null);
  const [creationLog, setCreationLog] = useState('');
  const creationRequestRef = useRef<AbortController | null>(null);
  const sawCreationDraftRef = useRef(false);
  const creationErrorReportedRef = useRef(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void Promise.all([fetchProviderSetup(), fetchAgentCreationOptions()]).then(([providers, options]) => {
      setProviderPayload(providers);
      setCreationOptions(options);
      setModel(options.providers[0]?.defaultModel ?? options.providers[0]?.models[0] ?? null);
      setStage(hasConfiguredProvider(providers.status) ? 'ready' : 'provider');
    }).catch((caught) => setError((caught as Error).message || 'Could not check provider setup.'));
  }, []);

  const scan = async (nextModel = model) => {
    if (stage === 'scanning' || stage === 'creating') return;
    setRetryScan(false);
    setRetrySuggestion(null);
    setStage('scanning');
    setError(null);
    try {
      const result = await discoverProjectAgents(props.projectId, nextModel ?? undefined);
      setDiscovery(result);
      setModel(result.model);
      setStage('suggestions');
    } catch (caught) {
      setError((caught as Error).message || 'Could not scan this project.');
      setStage('scan-error');
    }
  };

  const create = async (suggestion: ProjectAgentSuggestion) => {
    if (!model || creatingId) return;
    const controller = new AbortController();
    creationRequestRef.current = controller;
    setCreatingId(suggestion.id);
    setRetrySuggestion(suggestion);
    setCreationPhase('creating');
    setCreationLog('[agentuse] Starting agent creation\n');
    sawCreationDraftRef.current = false;
    creationErrorReportedRef.current = false;
    setStage('creating');
    setError(null);
    try {
      const agent = await createAgentWithProgress({
        project: props.projectId, name: suggestion.name, description: suggestion.description, objective: suggestion.objective, model, schedule: suggestion.schedule, guided: true,
      }, (event) => {
        if (event.type === 'status') {
          setCreationLog((current) => `${current}\n[agentuse] ${event.message}\n`);
        } else if (event.type === 'draft') {
          const heading = sawCreationDraftRef.current ? '' : '\n[model draft]\n';
          sawCreationDraftRef.current = true;
          setCreationLog((current) => `${current}${heading}${event.text}`);
        } else if (event.type === 'complete') {
          setCreationLog((current) => `${current}\n[agentuse] Saved ${event.agent.name}\n`);
        } else {
          creationErrorReportedRef.current = true;
          setCreationLog((current) => `${current}\n[error] ${event.error.message}\n`);
        }
      }, controller.signal);
      setCreationPhase('success');
      window.location.href = agentDetailHref(agent.projectId, agent.runPath, {
        tab: 'source',
        spotlightRun: !props.existingAgents,
      });
    } catch (caught) {
      if ((caught as Error).name === 'AbortError') return;
      const message = (caught as Error).message || 'Could not create this agent.';
      if (!creationErrorReportedRef.current) setCreationLog((current) => `${current}\n[error] ${message}\n`);
      setCreationPhase('error');
      setCreatingId(null);
      setStage('creation-error');
    } finally {
      creationRequestRef.current = null;
    }
  };

  const continueToScan = () => {
    if (hasConfiguredProvider(providerPayload?.status)) {
      if (retrySuggestion) void create(retrySuggestion);
      else void scan();
    } else {
      setProviderOpen(true);
      setProviderRouteState(props.projectId, true);
    }
  };

  const chooseAnotherModel = (kind: 'scan' | 'create') => {
    setRetryScan(kind === 'scan');
    if (kind === 'scan') setRetrySuggestion(null);
    setCreationPhase(null);
    setError(null);
    setStage('ready');
  };

  const currentStep = stage === 'provider' || stage === 'ready' ? 2 : stage === 'scanning' || stage === 'scan-error' ? 3 : 4;
  const modelOptions = creationOptions?.providers.flatMap((provider) => provider.models.map((candidate) => ({
    value: candidate,
    label: `${provider.name} · ${creationModelLabel(candidate, provider.id)}`,
  }))) ?? [];
  const selectedProvider = creationOptions?.providers.find((provider) => model
    ? provider.models.includes(model) || (provider.custom && model.startsWith(`${provider.id}:`))
    : false);
  const selectedModelLabel = model
    ? creationModelLabel(model, selectedProvider?.id ?? '')
    : 'the selected model';
  const isCreationStage = stage === 'creating' || stage === 'creation-error';
  return (
    <section class={`onboarding-empty project-discovery${props.compact ? ' is-compact' : ''}`} aria-labelledby="project-discovery-title">
      <div class="onboarding-copy">
        <div class="eyebrow">{isCreationStage ? `Creating ${retrySuggestion?.name ?? 'your agent'}` : props.existingAgents ? 'Add another useful agent' : 'Your first useful agent'}</div>
        <h2 id="project-discovery-title">
          {isCreationStage ? 'The model is writing your agent' : stage === 'suggestions' ? 'Pick the work worth repeating' : 'Find useful work in this project'}
        </h2>
        <p class="onboarding-lede">
          {stage === 'provider'
            ? 'Connect a model provider so AgentUse can inspect this project and propose agents grounded in the work already here.'
            : stage === 'ready'
              ? retrySuggestion
                ? 'Choose a more capable model, then try creating the same agent again. The project and selected idea are preserved.'
                : retryScan
                  ? 'Choose a more capable model, then scan the same project again.'
                  : 'AgentUse will read a bounded project snapshot—file names and common project docs—and propose three safe, recurring agents.'
              : stage === 'scanning' || stage === 'scan-error'
                ? 'Scan this project with the selected provider and model. If it fails, change the model without restarting onboarding.'
                : isCreationStage
                  ? 'The live creation log stays visible. AgentUse adds validated configuration after the model finishes the instructions.'
                  : discovery?.summary ?? 'Choose one suggestion to create it.'}
        </p>

        <div class="onboarding-project">
          <span>Project selected</span>
          <strong>{props.projectName ?? props.projectId}</strong>
          <code title={props.projectPath}>{props.projectPath}</code>
          {(stage === 'scanning' || stage === 'scan-error') && <small>{'Secrets, .git, dependencies, and generated files are excluded.'}</small>}
          {discovery && <small>{`Read-only scan · ${discovery.inspectedFiles} project files mapped`}</small>}
        </div>

        {stage === 'ready' && (
          <div class="discovery-model-field">
            <span>{retrySuggestion ? 'Creator model' : 'Analysis model'}</span>
            <div class="discovery-model-control">
              <DashboardSelect
                value={model ?? ''}
                options={modelOptions}
                disabled={modelOptions.length === 0}
                onChange={setModel}
                ariaLabel={retrySuggestion ? 'Creator model' : 'Analysis model'}
              />
              <button type="button" class="onboarding-secondary" onClick={() => {
                setProviderOpen(true);
                setProviderRouteState(props.projectId, true);
              }}>Add provider</button>
            </div>
            <small>{retrySuggestion ? 'Used to create the selected agent. Its runtime model is chosen separately.' : 'Generates project suggestions only. The agent’s runtime model is chosen separately when the agent is created.'}</small>
            <details class="discovery-sharing-details">
              <summary>What exactly gets sent to the model?</summary>
              <ul>
                <li>Up to 160 file paths, mapped no more than four folders deep.</li>
                <li>Selected README, ABOUT, and common manifest content, capped at 12,000 characters per file.</li>
                <li>Approximately 48,000 characters of project context in total.</li>
                <li>No <code>.env</code>, keys, credentials, dependency folders, build output, or source-code contents.</li>
              </ul>
              <p>The scan only reads project context and returns suggestions. It does not modify the project.</p>
            </details>
          </div>
        )}
        {(stage === 'provider' || stage === 'ready') && (
          <div class="onboarding-actions">
            <button type="button" class="onboarding-primary" disabled={stage === 'ready' && !model} onClick={continueToScan}>
              {stage === 'provider' ? 'Connect provider' : retrySuggestion ? 'Try creating again' : retryScan ? 'Scan again' : 'Scan this project'}
            </button>
            {stage === 'ready' && !retrySuggestion && (
              <button type="button" class="onboarding-skip-link" disabled={!model} onClick={() => setDirectCreateOpen(true)}>
                Skip scan and create an agent directly
              </button>
            )}
            {stage === 'ready' && retrySuggestion && <a class="onboarding-skip-link" href="/agents">Skip for now — open the agent dashboard</a>}
            <span class="onboarding-assurance">{retrySuggestion ? 'Project and selected idea preserved' : 'Read-only scan · You choose what gets created'}</span>
          </div>
        )}
        {stage === 'scanning' && (
          <div class="discovery-progress" role="status">
            <span class="btn-spinner" aria-hidden="true" />
            <span>Looking for repeated decisions, checks, and reporting work</span>
          </div>
        )}
        {stage === 'scan-error' && (
          <div class="discovery-recovery" aria-live="polite">
            <div class="discovery-failure" role="alert">
              <strong>Couldn’t scan this project</strong>
              <span>The selected model didn’t return usable, evidence-backed suggestions. It may not be capable enough for this task.</span>
            </div>
            <div class="onboarding-actions">
              <button type="button" class="onboarding-primary" onClick={() => void scan()}>Try again</button>
              <button type="button" class="onboarding-secondary" onClick={() => chooseAnotherModel('scan')}>Choose another model</button>
              <button type="button" class="onboarding-skip-link" disabled={!model} onClick={() => setDirectCreateOpen(true)}>Skip scan</button>
            </div>
          </div>
        )}
        {discovery && stage === 'suggestions' && (
          <div class="agent-suggestion-list">
            {discovery.suggestions.map((suggestion, index) => (
              <article class="agent-suggestion-card" key={suggestion.id}>
                <div class="agent-suggestion-rank">0{index + 1}</div>
                <div class="agent-suggestion-content">
                  <h3>{suggestion.name}</h3>
                  <p>{suggestion.description}</p>
                  <div class="agent-suggestion-meta">
                    <span>{suggestion.scheduleHuman}</span>
                    <span>{suggestion.evidence[0]}</span>
                  </div>
                </div>
                <button type="button" class="onboarding-primary" onClick={() => void create(suggestion)}>Create agent</button>
              </article>
            ))}
            <div class="agent-suggestion-footer">
              <p class="agent-suggestion-note">The selected schedule is added to the agent Source. Run it once now to review the result; you can change or remove the schedule anytime.</p>
              <a class="onboarding-skip-link" href="/agents">Skip for now — open the agent dashboard</a>
            </div>
          </div>
        )}
        {isCreationStage && creationPhase && (
          <div class="discovery-creation" aria-live="polite">
            <AgentCreationProgressPanel
              phase={creationPhase}
              modelLabel={selectedModelLabel}
              logText={creationLog}
              error={stage === 'creation-error' ? 'The selected model did not produce usable agent instructions. It may not be capable enough for this task.' : null}
            />
            {stage === 'creation-error' && retrySuggestion && (
              <div class="onboarding-actions">
                <button type="button" class="onboarding-primary" onClick={() => void create(retrySuggestion)}>Try again</button>
                <button type="button" class="onboarding-secondary" onClick={() => chooseAnotherModel('create')}>Choose another model</button>
                <a class="onboarding-skip-link" href="/agents">Skip for now</a>
              </div>
            )}
          </div>
        )}
        {error && stage !== 'scan-error' && stage !== 'creation-error' && <div class="onboarding-error" role="alert">{error}</div>}
      </div>

      <ol class="onboarding-steps" aria-label="First useful agent setup steps">
        <li><span class="onboarding-step-number">01</span><span><strong>Choose project</strong><small>{props.projectName ?? props.projectId}</small></span></li>
        <li class={currentStep === 2 ? 'is-current' : ''}><span class="onboarding-step-number">02</span><span><strong>Connect provider</strong><small>{hasConfiguredProvider(providerPayload?.status) ? 'Provider ready' : 'Required before project scan'}</small></span></li>
        <li class={currentStep === 3 ? 'is-current' : ''}><span class="onboarding-step-number">03</span><span><strong>Scan project</strong><small>Read-only, bounded project context</small></span></li>
        <li class={currentStep === 4 ? 'is-current' : ''}><span class="onboarding-step-number">04</span><span><strong>{props.existingAgents ? 'Create another agent' : 'Create an agent'}</strong><small>Review Source, then run it</small></span></li>
      </ol>

      <ProviderSetupDialog
        open={providerOpen}
        title="connect before scanning"
        onComplete={(next) => {
          setProviderPayload(next);
          setProviderOpen(false);
          setProviderRouteState(props.projectId, false);
          window.location.replace(projectDiscoveryHref(props.projectId));
        }}
        onClose={() => { setProviderOpen(false); setProviderRouteState(props.projectId, false); }}
      />
      <AgentCreateDialog
        open={directCreateOpen}
        title="create an agent directly"
        initialProjectId={props.projectId}
        {...(model ? { initialModel: model } : {})}
        lockProject
        onCreated={(agent) => {
          window.location.href = agentDetailHref(agent.projectId, agent.runPath, {
            tab: 'source',
            spotlightRun: !props.existingAgents,
          });
        }}
        onClose={() => setDirectCreateOpen(false)}
      />
    </section>
  );
}
