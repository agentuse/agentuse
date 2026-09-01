import { useEffect, useReducer, useState } from 'preact/hooks';
import { agentDetailHref, projectDiscoveryHref } from '../lib/links';
import {
  fetchOnboardingJob,
  fetchAgentCreationOptions,
  fetchProviderSetup,
  startOnboardingAgentCreation,
  startProjectDiscoverySession,
  type AgentRow,
  type OnboardingJobHandle,
  type ProjectAgentSuggestion,
  type ProjectDiscoveryPayload,
  type ProviderSetupPayload,
} from '../lib/api';
import { AgentCreateDialog, creationModelLabel } from './agent-create-dialog';
import { DashboardSelect } from './dashboard-select';
import { OnboardingSessionLog } from './onboarding-session-log';
import {
  initialProjectDiscoveryState,
  onboardingCurrentStep,
  onboardingDiscovery,
  onboardingSuggestion,
  parseProjectDiscoveryResume,
  projectDiscoveryModelOptions,
  projectDiscoveryModelReady,
  projectDiscoveryReducer,
  resumableProjectDiscoveryState,
} from './onboarding-machine';
import { firstUsefulAgentSetupSteps, OnboardingShell } from './onboarding-shell';
import { hasConfiguredProvider, ProviderSetupDialog } from './provider-setup';

type OnboardingModal = 'provider' | 'direct-create' | null;
type TerminalSessionSignal = { jobId: string; status: string };

const TERMINAL_SESSION_STATUSES = new Set(['completed', 'error', 'expired', 'failed', 'stopped', 'timeout', 'incomplete']);
const FINAL_RESULT_RETRY_MS = 500;
const FINAL_RESULT_MAX_ATTEMPTS = 60;

export function isTerminalOnboardingSessionStatus(status: string): boolean {
  return TERMINAL_SESSION_STATUSES.has(status);
}

function setProviderRouteState(projectId: string, open: boolean): void {
  history.replaceState(null, '', projectDiscoveryHref(projectId, { ...(open && { connectProvider: true }) }));
}

function likelyCreatorCapabilityFailure(error: string): boolean {
  return /AgentUse source|submit_agent_source|generated agent|agent configuration/i.test(error);
}

export function ProjectAgentDiscovery(props: {
  projectId: string;
  projectName?: string;
  projectPath: string;
  compact?: boolean;
  existingAgents?: boolean;
}) {
  const [state, dispatch] = useReducer(projectDiscoveryReducer, initialProjectDiscoveryState);
  const [modal, setModal] = useState<OnboardingModal>(() => typeof window !== 'undefined'
    && new URLSearchParams(window.location.search).get('provider') === 'connect'
    ? 'provider'
    : null);
  const [terminalSession, setTerminalSession] = useState<TerminalSessionSignal | null>(null);
  const resumeKey = `agentuse:onboarding:${props.projectId}`;

  const clearResume = () => {
    if (typeof sessionStorage !== 'undefined') sessionStorage.removeItem(resumeKey);
  };

  useEffect(() => {
    void Promise.all([fetchProviderSetup(), fetchAgentCreationOptions()]).then(([provider, options]) => {
      dispatch({ type: 'BOOT_SUCCEEDED', provider, options });
      const resume = typeof sessionStorage === 'undefined'
        ? null
        : parseProjectDiscoveryResume(sessionStorage.getItem(resumeKey));
      if (resume) dispatch({ type: 'RESTORE', resume });
    }).catch((caught) => dispatch({
      type: 'BOOT_FAILED',
      error: (caught as Error).message || 'Could not check provider setup.',
    }));
  }, [resumeKey]);

  useEffect(() => {
    const resume = resumableProjectDiscoveryState(state);
    if (resume && typeof sessionStorage !== 'undefined') sessionStorage.setItem(resumeKey, JSON.stringify(resume));
  }, [resumeKey, state]);

  const activeJob = state.type === 'scanning' || state.type === 'creating' ? state.job : null;
  useEffect(() => {
    if (!activeJob || terminalSession?.jobId !== activeJob.id) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    let attempts = 0;
    const fetchFinalResult = async () => {
      try {
        const { job } = await fetchOnboardingJob(activeJob.id);
        if (disposed) return;
        if (job.status === 'running') {
          attempts += 1;
          if (attempts >= FINAL_RESULT_MAX_ATTEMPTS) {
            const message = 'The session ended, but AgentUse could not finish preparing its result.';
            if (activeJob.kind === 'project-discovery') dispatch({ type: 'SCAN_FAILED', error: message });
            else dispatch({ type: 'CREATION_FAILED', error: message });
            return;
          }
          timer = setTimeout(() => void fetchFinalResult(), FINAL_RESULT_RETRY_MS);
          return;
        }
        if (job.status === 'error') {
          const message = job.error?.message || 'The onboarding agent did not finish successfully.';
          if (job.kind === 'project-discovery') dispatch({ type: 'SCAN_FAILED', error: message });
          else dispatch({ type: 'CREATION_FAILED', error: message });
          return;
        }
        if (job.kind === 'project-discovery') {
          dispatch({ type: 'SCAN_SUCCEEDED', discovery: job.result as ProjectDiscoveryPayload });
          return;
        }
        const agent = (job.result as { success: true; agent: AgentRow }).agent;
        clearResume();
        window.location.href = agentDetailHref(agent.projectId, agent.runPath, {
          tab: 'source',
          spotlightRun: !props.existingAgents,
        });
      } catch (caught) {
        if (disposed) return;
        attempts += 1;
        if (attempts < FINAL_RESULT_MAX_ATTEMPTS) {
          timer = setTimeout(() => void fetchFinalResult(), FINAL_RESULT_RETRY_MS);
          return;
        }
        const message = (caught as Error).message || 'Could not reconnect to the onboarding session.';
        if (state.type === 'scanning') dispatch({ type: 'SCAN_FAILED', error: message });
        else if (state.type === 'creating') dispatch({ type: 'CREATION_FAILED', error: message });
      }
    };
    void fetchFinalResult();
    return () => {
      disposed = true;
      if (timer) clearTimeout(timer);
    };
  }, [activeJob?.id, terminalSession?.jobId]);

  const observeSessionStatus = (job: OnboardingJobHandle, status: string) => {
    if (!isTerminalOnboardingSessionStatus(status)) return;
    setTerminalSession((current) => current?.jobId === job.id ? current : { jobId: job.id, status });
  };

  const observeFatalSessionError = (job: OnboardingJobHandle) => {
    setTerminalSession((current) => current?.jobId === job.id ? current : { jobId: job.id, status: 'stream-error' });
  };

  const setup = 'setup' in state ? state.setup : null;
  const model = setup?.model ?? null;
  const discovery = onboardingDiscovery(state);
  const selectedSuggestion = onboardingSuggestion(state);

  const openProvider = () => {
    setModal('provider');
    setProviderRouteState(props.projectId, true);
  };

  const providerConnected = async (provider: ProviderSetupPayload) => {
    setModal(null);
    setProviderRouteState(props.projectId, false);
    try {
      const options = await fetchAgentCreationOptions();
      dispatch({ type: 'PROVIDER_CONNECTED', provider, options });
    } catch (caught) {
      dispatch({ type: 'BOOT_FAILED', error: (caught as Error).message || 'Could not refresh available models.' });
    }
  };

  const scan = async () => {
    if (!model || !modelReady || (state.type !== 'ready' && state.type !== 'scan-failed')) return;
    dispatch({ type: 'SCAN_STARTED' });
    try {
      const { job } = await startProjectDiscoverySession(props.projectId, model);
      dispatch({ type: 'SCAN_SESSION_STARTED', job });
    } catch (caught) {
      dispatch({ type: 'SCAN_FAILED', error: (caught as Error).message || 'Could not scan this project.' });
    }
  };

  const create = async (suggestion: ProjectAgentSuggestion) => {
    if (!model || !modelReady || state.type === 'creating' || !onboardingDiscovery(state)) return;
    dispatch({ type: 'CREATION_STARTED', suggestion });
    try {
      const { job } = await startOnboardingAgentCreation({
        project: props.projectId,
        name: suggestion.name,
        description: suggestion.description,
        objective: suggestion.objective,
        model,
        schedule: suggestion.schedule,
      });
      dispatch({ type: 'CREATION_SESSION_STARTED', job });
    } catch (caught) {
      dispatch({ type: 'CREATION_FAILED', error: (caught as Error).message || 'Could not create this agent.' });
    }
  };

  const continueFromSetup = () => {
    if (!setup || !hasConfiguredProvider(setup.provider.status)) {
      openProvider();
      return;
    }
    if (state.type !== 'ready') return;
    if (state.intent.type === 'retry-create') void create(state.intent.suggestion);
    else void scan();
  };

  const currentStep = onboardingCurrentStep(state);
  const modelOptions = projectDiscoveryModelOptions(setup?.options.providers ?? []).map((option) => {
    const provider = setup?.options.providers.find((candidate) => option.value.startsWith(`${candidate.id}:`));
    return provider?.custom
      ? option
      : { ...option, label: `${provider?.name ?? ''} · ${creationModelLabel(option.value, provider?.id ?? '')}` };
  });
  const selectedProvider = setup?.options.providers.find((provider) => model
    ? provider.models.includes(model) || (provider.custom && model.startsWith(`${provider.id}:`))
    : false);
  const modelReady = projectDiscoveryModelReady(model, setup?.options.providers ?? []);
  const selectedModelLabel = model ? creationModelLabel(model, selectedProvider?.id ?? '') : 'the selected model';
  const isCreationStage = state.type === 'creating' || state.type === 'creation-failed';
  const retryingCreation = state.type === 'ready' && state.intent.type === 'retry-create';
  const retryingScan = state.type === 'ready' && state.intent.type === 'retry-scan';
  const projectLabel = props.projectName ?? props.projectId;

  return (
    <>
      <OnboardingShell
        className="project-discovery"
        compact={props.compact}
        labelledBy="project-discovery-title"
        stepsLabel="First useful agent setup steps"
        steps={firstUsefulAgentSetupSteps({
          currentStep,
          projectDetail: projectLabel,
          providerReady: hasConfiguredProvider(setup?.provider.status),
          scanDetail: 'Read-only, bounded project context',
          createDetail: 'Review Source, then run it',
        })}
      >
        <div class="eyebrow">{isCreationStage ? `Creating ${selectedSuggestion?.name ?? 'your agent'}` : props.existingAgents ? 'Add another useful agent' : 'Your first useful agent'}</div>
        <h2 id="project-discovery-title">
          {isCreationStage ? 'The model is writing your agent' : state.type === 'suggestions' ? 'Pick the work worth repeating' : 'Find useful work in this project'}
        </h2>
        <p class="onboarding-lede">
          {state.type === 'booting'
            ? 'Checking your providers and available models…'
            : state.type === 'boot-error'
              ? 'AgentUse could not prepare this onboarding flow.'
              : state.type === 'provider-required'
                ? 'Connect a model provider so AgentUse can inspect this project and propose agents grounded in the work already here.'
                : state.type === 'ready'
                  ? retryingCreation
                    ? 'Choose a more capable model, then try creating the same agent again. The project and selected idea are preserved.'
                    : retryingScan
                      ? 'Choose a more capable model, then scan the same project again.'
                      : 'A read-only AgentUse session will intelligently explore a sanitized project view and propose three safe, recurring agents.'
                  : state.type === 'scanning' || state.type === 'scan-failed'
                    ? 'Watch the AgentUse session inspect relevant files. If it fails, change the model without restarting onboarding.'
                    : isCreationStage
                      ? 'The live AgentUse session stays visible while the Creator skill designs and validates the complete agent.'
                      : discovery?.summary ?? 'Choose one suggestion to create it.'}
        </p>

        <div class="onboarding-project">
          <span>Project selected</span>
          <strong>{projectLabel}</strong>
          <code title={props.projectPath}>{props.projectPath}</code>
          {(state.type === 'scanning' || state.type === 'scan-failed') && <small>{'Secrets, .git, dependencies, and generated files are excluded.'}</small>}
          {discovery && <small>{discovery.inspectedFiles > 400
            ? 'Read-only view · up to 400 files available to the model'
            : `Read-only view · ${discovery.inspectedFiles} files available to the model`}</small>}
        </div>

        {state.type === 'ready' && (
          <div class="discovery-model-field">
            <span>{retryingCreation ? 'Creator model' : 'Analysis model'}</span>
            <div class="discovery-model-control">
              <DashboardSelect
                value={model ?? ''}
                options={modelOptions}
                disabled={modelOptions.length === 0}
                onChange={(next) => dispatch({ type: 'MODEL_SELECTED', model: next })}
                ariaLabel={retryingCreation ? 'Creator model' : 'Analysis model'}
                placeholder="Choose a model…"
              />
              <button type="button" class="onboarding-secondary" onClick={openProvider}>Add provider</button>
            </div>
            <small>{retryingCreation ? 'Used to create the selected agent. Its runtime model is chosen separately.' : 'Generates project suggestions only. The agent’s runtime model is chosen separately when the agent is created.'}</small>
            <details class="discovery-sharing-details">
              <summary>What exactly gets sent to the model?</summary>
              <ul>
                <li>The model receives read-only list, search, and read tools over a temporary sanitized copy.</li>
                <li>It chooses which project files matter, up to 400 text files and approximately 2 MB in total.</li>
                <li><code>.env</code>, keys, credentials, dependencies, generated output, Git data, and binary files are blocked.</li>
                <li>Recognizable credential values inside otherwise allowed text files are redacted.</li>
              </ul>
              <p>The session log shows which paths the model lists, searches, and reads. The scan cannot modify the project.</p>
            </details>
          </div>
        )}

        {(state.type === 'provider-required' || state.type === 'ready') && (
          <div class="onboarding-actions">
            <button type="button" class="onboarding-primary" disabled={state.type === 'ready' && !modelReady} onClick={continueFromSetup}>
              {state.type === 'provider-required' ? 'Connect provider' : !modelReady ? 'Choose a model to continue' : retryingCreation ? 'Try creating again' : retryingScan ? 'Scan again' : 'Scan this project'}
            </button>
            {state.type === 'ready' && !retryingCreation && <button type="button" class="onboarding-skip-link" onClick={() => setModal('direct-create')}>Skip scan and create an agent directly</button>}
            {retryingCreation && <a class="onboarding-skip-link" href="/agents" onClick={clearResume}>Skip for now — open the agent dashboard</a>}
            <span class="onboarding-assurance">{retryingCreation ? 'Project and selected idea preserved' : 'Read-only scan · You choose what gets created'}</span>
          </div>
        )}

        {state.type === 'booting' && <div class="discovery-progress" role="status"><span class="btn-spinner" aria-hidden="true" /><span>Loading providers and models</span></div>}
        {state.type === 'boot-error' && <div class="onboarding-error" role="alert">{state.error}</div>}
        {state.type === 'scanning' && !state.job && <div class="discovery-progress" role="status"><span class="btn-spinner" aria-hidden="true" /><span>Starting project discovery session</span></div>}
        {state.type === 'scanning' && state.job && <OnboardingSessionLog job={state.job} title={`Scanning with ${selectedModelLabel}`} onStatus={(status) => observeSessionStatus(state.job!, status)} onFatalError={() => observeFatalSessionError(state.job!)} />}

        {state.type === 'scan-failed' && (
          <div class="discovery-recovery" aria-live="polite">
            {state.job && <OnboardingSessionLog job={state.job} title="Project scan session" />}
            <div class="discovery-failure" role="alert"><strong>Couldn’t scan this project</strong><span>The selected model didn’t return usable, evidence-backed suggestions. It may not be capable enough for this task.</span></div>
            <div class="onboarding-actions">
              <button type="button" class="onboarding-primary" onClick={() => void scan()}>Try again</button>
              <button type="button" class="onboarding-secondary" onClick={() => dispatch({ type: 'CHOOSE_MODEL_AFTER_SCAN' })}>Choose another model</button>
              <button type="button" class="onboarding-skip-link" onClick={() => setModal('direct-create')}>Skip scan</button>
            </div>
          </div>
        )}

        {state.type === 'suggestions' && (
          <div class="agent-suggestion-list">
            {state.discovery.suggestions.map((suggestion, index) => (
              <article class="agent-suggestion-card" key={suggestion.id}>
                <div class="agent-suggestion-rank">0{index + 1}</div>
                <div class="agent-suggestion-content">
                  <h3>{suggestion.name}</h3>
                  <p>{suggestion.description}</p>
                  <div class="agent-suggestion-meta"><span>{suggestion.scheduleHuman}</span></div>
                </div>
                <button type="button" class="onboarding-primary" onClick={() => void create(suggestion)}>Create agent</button>
              </article>
            ))}
            <div class="agent-suggestion-footer">
              <p class="agent-suggestion-note">The selected schedule is added to the agent Source. Run it once now to review the result; you can change or remove the schedule anytime.</p>
              <a class="onboarding-skip-link" href="/agents" onClick={clearResume}>Skip for now — open the agent dashboard</a>
            </div>
          </div>
        )}

        {isCreationStage && (
          <div class="discovery-creation" aria-live="polite">
            {state.job
              ? <OnboardingSessionLog job={state.job} title={`Creating with ${selectedModelLabel}`} onStatus={(status) => observeSessionStatus(state.job!, status)} onFatalError={() => observeFatalSessionError(state.job!)} />
              : state.type === 'creating'
                ? <div class="discovery-progress" role="status"><span class="btn-spinner" aria-hidden="true" /><span>Starting AgentUse Creator session</span></div>
                : null}
            {state.type === 'creation-failed' && (
              <div class="discovery-recovery">
                <div class="discovery-failure" role="alert">
                  <strong>Couldn’t create this agent</strong>
                  <span>{state.error}</span>
                  {likelyCreatorCapabilityFailure(state.error) && <small>The selected model may not be capable enough for this task.</small>}
                </div>
                <div class="onboarding-actions">
                  <button type="button" class="onboarding-primary" onClick={() => void create(state.suggestion)}>Try again</button>
                  <button type="button" class="onboarding-secondary" onClick={() => dispatch({ type: 'CHOOSE_MODEL_AFTER_CREATION' })}>Choose another model</button>
                  <a class="onboarding-skip-link" href="/agents" onClick={clearResume}>Skip for now</a>
                </div>
              </div>
            )}
          </div>
        )}
      </OnboardingShell>

      <ProviderSetupDialog
        open={modal === 'provider'}
        title="connect before scanning"
        allowCustom
        onComplete={(provider) => { void providerConnected(provider); }}
        onClose={() => { setModal(null); setProviderRouteState(props.projectId, false); }}
      />
      <AgentCreateDialog
        open={modal === 'direct-create'}
        title="create an agent directly"
        initialProjectId={props.projectId}
        {...(model ? { initialModel: model } : {})}
        lockProject
        onCreated={(agent) => {
          clearResume();
          window.location.href = agentDetailHref(agent.projectId, agent.runPath, { tab: 'source', spotlightRun: !props.existingAgents });
        }}
        onClose={() => setModal(null)}
      />
    </>
  );
}
