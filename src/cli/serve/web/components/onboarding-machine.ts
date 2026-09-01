import type {
  AgentCreationOptionsPayload,
  ProjectAgentSuggestion,
  ProjectDiscoveryPayload,
  ProjectInfo,
  ProviderSetupPayload,
  OnboardingJobHandle,
} from '../lib/api';
import type { AgentCreationProvider } from '../../../../agents/create';

export function projectDiscoveryModelOptions(providers: AgentCreationProvider[]): Array<{ value: string; label: string }> {
  return providers.flatMap((provider) => provider.custom
    ? [{ value: `${provider.id}:`, label: `${provider.name} · Enter model ID…` }]
    : provider.models.map((model) => ({ value: model, label: model })));
}

export function projectDiscoveryModelReady(
  model: string | null,
  providers: AgentCreationProvider[],
): boolean {
  if (!model) return false;
  const provider = providers.find((candidate) => candidate.models.includes(model)
    || (candidate.custom && model.startsWith(`${candidate.id}:`)));
  if (!provider) return false;
  return provider.custom ? Boolean(model.slice(provider.id.length + 1).trim()) : true;
}

export type ProjectSelectionState =
  | { type: 'choose'; name: string; path: string }
  | { type: 'new'; name: string; path: string; submitting: boolean; error: string | null }
  | { type: 'existing'; name: string; path: string; activity: 'idle' | 'choosing-folder' | 'submitting'; error: string | null }
  | { type: 'attached'; project: ProjectInfo };

export type ProjectSelectionEvent =
  | { type: 'CHOOSE_NEW' }
  | { type: 'CHOOSE_EXISTING' }
  | { type: 'BACK' }
  | { type: 'NAME_CHANGED'; name: string }
  | { type: 'PATH_CHANGED'; path: string }
  | { type: 'SUBMIT_STARTED' }
  | { type: 'FOLDER_PICK_STARTED' }
  | { type: 'FOLDER_PICKED'; path: string | null }
  | { type: 'FAILED'; error: string }
  | { type: 'PROJECT_ATTACHED'; project: ProjectInfo };

export function initialProjectSelectionState(name: string): ProjectSelectionState {
  return { type: 'choose', name, path: '' };
}

export function projectSelectionReducer(
  state: ProjectSelectionState,
  event: ProjectSelectionEvent,
): ProjectSelectionState {
  if (event.type === 'PROJECT_ATTACHED') return { type: 'attached', project: event.project };
  if (state.type === 'attached') return state;
  switch (event.type) {
    case 'CHOOSE_NEW':
      return { type: 'new', name: state.name, path: state.path, submitting: false, error: null };
    case 'CHOOSE_EXISTING':
      return { type: 'existing', name: state.name, path: state.path, activity: 'idle', error: null };
    case 'BACK':
      return { type: 'choose', name: state.name, path: state.path };
    case 'NAME_CHANGED':
      return { ...state, name: event.name };
    case 'PATH_CHANGED':
      return { ...state, path: event.path };
    case 'SUBMIT_STARTED':
      if (state.type === 'new' && !state.submitting) return { ...state, submitting: true, error: null };
      if (state.type === 'existing' && state.activity === 'idle') return { ...state, activity: 'submitting', error: null };
      return state;
    case 'FOLDER_PICK_STARTED':
      return state.type === 'existing' && state.activity === 'idle' ? { ...state, activity: 'choosing-folder', error: null } : state;
    case 'FOLDER_PICKED':
      return state.type === 'existing'
        ? { ...state, path: event.path ?? state.path, activity: 'idle' }
        : state;
    case 'FAILED':
      if (state.type === 'new') return { ...state, submitting: false, error: event.error };
      if (state.type === 'existing') return { ...state, activity: 'idle', error: event.error };
      return state;
    default:
      return state;
  }
}

export interface OnboardingSetup {
  provider: ProviderSetupPayload;
  options: AgentCreationOptionsPayload;
  model: string | null;
}

export type OnboardingReadyIntent =
  | { type: 'scan' }
  | { type: 'retry-scan' }
  | { type: 'retry-create'; discovery: ProjectDiscoveryPayload; suggestion: ProjectAgentSuggestion };

type WithSetup = { setup: OnboardingSetup };

export type ProjectDiscoveryState =
  | { type: 'booting' }
  | { type: 'boot-error'; error: string }
  | ({ type: 'provider-required' } & WithSetup)
  | ({ type: 'ready'; intent: OnboardingReadyIntent } & WithSetup)
  | ({ type: 'scanning'; job: OnboardingJobHandle | null } & WithSetup)
  | ({ type: 'scan-failed'; error: string; job?: OnboardingJobHandle } & WithSetup)
  | ({ type: 'suggestions'; discovery: ProjectDiscoveryPayload } & WithSetup)
  | ({
      type: 'creating';
      discovery: ProjectDiscoveryPayload;
      suggestion: ProjectAgentSuggestion;
      log: string;
      draftStarted: boolean;
      errorReported: boolean;
      job: OnboardingJobHandle | null;
    } & WithSetup)
  | ({
      type: 'creation-failed';
      discovery: ProjectDiscoveryPayload;
      suggestion: ProjectAgentSuggestion;
      log: string;
      error: string;
      draftStarted: boolean;
      errorReported: boolean;
      job?: OnboardingJobHandle;
    } & WithSetup);

export type ProjectDiscoveryResume =
  | { type: 'ready'; model: string | null; intent: OnboardingReadyIntent }
  | { type: 'scanning'; model: string | null; job: OnboardingJobHandle }
  | { type: 'scan-failed'; model: string | null; error: string }
  | { type: 'suggestions'; model: string | null; discovery: ProjectDiscoveryPayload }
  | {
      type: 'creating';
      model: string | null;
      discovery: ProjectDiscoveryPayload;
      suggestion: ProjectAgentSuggestion;
      job: OnboardingJobHandle;
    }
  | {
      type: 'creation-failed';
      model: string | null;
      discovery: ProjectDiscoveryPayload;
      suggestion: ProjectAgentSuggestion;
      log: string;
      error: string;
      job?: OnboardingJobHandle;
    };

export type ProjectDiscoveryEvent =
  | { type: 'BOOT_SUCCEEDED'; provider: ProviderSetupPayload; options: AgentCreationOptionsPayload }
  | { type: 'BOOT_FAILED'; error: string }
  | { type: 'RESTORE'; resume: ProjectDiscoveryResume }
  | { type: 'PROVIDER_CONNECTED'; provider: ProviderSetupPayload; options: AgentCreationOptionsPayload }
  | { type: 'MODEL_SELECTED'; model: string }
  | { type: 'SCAN_STARTED' }
  | { type: 'SCAN_SESSION_STARTED'; job: OnboardingJobHandle }
  | { type: 'SCAN_SUCCEEDED'; discovery: ProjectDiscoveryPayload }
  | { type: 'SCAN_FAILED'; error: string }
  | { type: 'CHOOSE_MODEL_AFTER_SCAN' }
  | { type: 'CREATION_STARTED'; suggestion: ProjectAgentSuggestion }
  | { type: 'CREATION_SESSION_STARTED'; job: OnboardingJobHandle }
  | { type: 'CREATION_STATUS'; message: string }
  | { type: 'CREATION_DRAFT'; text: string }
  | { type: 'CREATION_SAVED'; agentName: string }
  | { type: 'CREATION_FAILED'; error: string }
  | { type: 'CHOOSE_MODEL_AFTER_CREATION' };

export const initialProjectDiscoveryState: ProjectDiscoveryState = { type: 'booting' };

function hasConfiguredProvider(provider: ProviderSetupPayload): boolean {
  return provider.status.providers.some((candidate) => candidate.configured)
    || provider.status.customProviders.length > 0;
}

function configuredModel(options: AgentCreationOptionsPayload, current: string | null): string | null {
  if (current && options.providers.some((provider) => provider.models.includes(current)
    || (provider.custom && current.startsWith(`${provider.id}:`)))) return current;
  return null;
}

function hasSetup(state: ProjectDiscoveryState): state is Exclude<ProjectDiscoveryState, { type: 'booting' | 'boot-error' }> {
  return 'setup' in state;
}

function withModel(state: ProjectDiscoveryState, model: string): ProjectDiscoveryState {
  if (!hasSetup(state)) return state;
  return { ...state, setup: { ...state.setup, model } };
}

function appendCreationLog(
  state: Extract<ProjectDiscoveryState, { type: 'creating' | 'creation-failed' }>,
  text: string,
): ProjectDiscoveryState {
  return { ...state, log: `${state.log}${text}` };
}

export function projectDiscoveryReducer(
  state: ProjectDiscoveryState,
  event: ProjectDiscoveryEvent,
): ProjectDiscoveryState {
  switch (event.type) {
    case 'BOOT_SUCCEEDED': {
      // A configured provider is necessary, but it is not a model choice. Keep
      // the model empty until the user explicitly selects one so onboarding
      // cannot silently skip this step by accepting a provider default.
      const setup = { provider: event.provider, options: event.options, model: null };
      return hasConfiguredProvider(event.provider)
        ? { type: 'ready', setup, intent: { type: 'scan' } }
        : { type: 'provider-required', setup };
    }
    case 'BOOT_FAILED':
      return { type: 'boot-error', error: event.error };
    case 'RESTORE': {
      if (state.type !== 'ready') return state;
      const setup = { ...state.setup, model: configuredModel(state.setup.options, event.resume.model) };
      if (event.resume.type === 'ready') return { type: 'ready', setup, intent: event.resume.intent };
      if (event.resume.type === 'scanning') return { type: 'scanning', setup, job: event.resume.job };
      if (event.resume.type === 'scan-failed') return { type: 'scan-failed', setup, error: event.resume.error };
      if (event.resume.type === 'suggestions') return { type: 'suggestions', setup, discovery: event.resume.discovery };
      if (event.resume.type === 'creating') {
        return {
          type: 'creating',
          setup,
          discovery: event.resume.discovery,
          suggestion: event.resume.suggestion,
          job: event.resume.job,
          log: '',
          draftStarted: false,
          errorReported: false,
        };
      }
      return {
        type: 'creation-failed',
        setup,
        discovery: event.resume.discovery,
        suggestion: event.resume.suggestion,
        log: event.resume.log,
        error: event.resume.error,
        draftStarted: event.resume.log.includes('[model draft]'),
        errorReported: event.resume.log.includes('[error]'),
        ...(event.resume.job && { job: event.resume.job }),
      };
    }
    case 'PROVIDER_CONNECTED': {
      const setup = {
        provider: event.provider,
        options: event.options,
        // Returning from provider setup always comes back to model selection.
        // This gives newly-added providers/models a single predictable entry
        // point and avoids branching based on how provider setup was reached.
        model: null,
      };
      const intent = state.type === 'ready' ? state.intent : { type: 'scan' as const };
      return { type: 'ready', setup, intent };
    }
    case 'MODEL_SELECTED':
      return withModel(state, event.model);
    case 'SCAN_STARTED':
      return state.type === 'ready' || state.type === 'scan-failed'
        ? { type: 'scanning', setup: state.setup, job: null }
        : state;
    case 'SCAN_SESSION_STARTED':
      return state.type === 'scanning' ? { ...state, job: event.job } : state;
    case 'SCAN_SUCCEEDED':
      return state.type === 'scanning'
        ? { type: 'suggestions', setup: { ...state.setup, model: event.discovery.model }, discovery: event.discovery }
        : state;
    case 'SCAN_FAILED':
      return state.type === 'scanning'
        ? { type: 'scan-failed', setup: state.setup, error: event.error, ...(state.job && { job: state.job }) }
        : state;
    case 'CHOOSE_MODEL_AFTER_SCAN':
      return state.type === 'scan-failed'
        ? { type: 'ready', setup: { ...state.setup, model: null }, intent: { type: 'retry-scan' } }
        : state;
    case 'CREATION_STARTED': {
      const source = state.type === 'suggestions'
        ? state
        : state.type === 'ready' && state.intent.type === 'retry-create'
          ? { ...state, discovery: state.intent.discovery }
          : state.type === 'creation-failed'
            ? state
            : null;
      if (!source || !('discovery' in source)) return state;
      return {
        type: 'creating',
        setup: source.setup,
        discovery: source.discovery,
        suggestion: event.suggestion,
        log: '[agentuse] Starting agent creation\n',
        draftStarted: false,
        errorReported: false,
        job: null,
      };
    }
    case 'CREATION_SESSION_STARTED':
      return state.type === 'creating' ? { ...state, job: event.job } : state;
    case 'CREATION_STATUS':
      return state.type === 'creating'
        ? appendCreationLog(state, `\n[agentuse] ${event.message}\n`)
        : state;
    case 'CREATION_DRAFT':
      return state.type === 'creating'
        ? {
            ...state,
            log: `${state.log}${state.draftStarted ? '' : '\n[model draft]\n'}${event.text}`,
            draftStarted: true,
          }
        : state;
    case 'CREATION_SAVED':
      return state.type === 'creating'
        ? appendCreationLog(state, `\n[agentuse] Saved ${event.agentName}\n`)
        : state;
    case 'CREATION_FAILED':
      if (state.type !== 'creating') return state;
      return {
        type: 'creation-failed',
        setup: state.setup,
        discovery: state.discovery,
        suggestion: state.suggestion,
        error: event.error,
        log: state.errorReported ? state.log : `${state.log}\n[error] ${event.error}\n`,
        draftStarted: state.draftStarted,
        errorReported: state.errorReported,
        ...(state.job && { job: state.job }),
      };
    case 'CHOOSE_MODEL_AFTER_CREATION':
      return state.type === 'creation-failed'
        ? {
            type: 'ready',
            setup: { ...state.setup, model: null },
            intent: { type: 'retry-create', discovery: state.discovery, suggestion: state.suggestion },
          }
        : state;
    default:
      return state;
  }
}

export function onboardingCurrentStep(state: ProjectDiscoveryState): 2 | 3 | 4 {
  if (state.type === 'provider-required' || state.type === 'ready' || state.type === 'booting' || state.type === 'boot-error') return 2;
  if (state.type === 'scanning' || state.type === 'scan-failed') return 3;
  return 4;
}

export function onboardingDiscovery(state: ProjectDiscoveryState): ProjectDiscoveryPayload | null {
  if (state.type === 'suggestions' || state.type === 'creating' || state.type === 'creation-failed') return state.discovery;
  if (state.type === 'ready' && state.intent.type === 'retry-create') return state.intent.discovery;
  return null;
}

export function onboardingSuggestion(state: ProjectDiscoveryState): ProjectAgentSuggestion | null {
  if (state.type === 'creating' || state.type === 'creation-failed') return state.suggestion;
  if (state.type === 'ready' && state.intent.type === 'retry-create') return state.intent.suggestion;
  return null;
}

export function resumableProjectDiscoveryState(state: ProjectDiscoveryState): ProjectDiscoveryResume | null {
  if (state.type === 'ready') return { type: 'ready', model: state.setup.model, intent: state.intent };
  if (state.type === 'scanning') return state.job
    ? { type: 'scanning', model: state.setup.model, job: state.job }
    : { type: 'ready', model: state.setup.model, intent: { type: 'retry-scan' } };
  if (state.type === 'scan-failed') return { type: 'scan-failed', model: state.setup.model, error: state.error };
  if (state.type === 'suggestions') return { type: 'suggestions', model: state.setup.model, discovery: state.discovery };
  if (state.type === 'creating') {
    if (state.job) {
      return {
        type: 'creating',
        model: state.setup.model,
        discovery: state.discovery,
        suggestion: state.suggestion,
        job: state.job,
      };
    }
    const error = 'Agent creation was interrupted before it finished.';
    return {
      type: 'creation-failed',
      model: state.setup.model,
      discovery: state.discovery,
      suggestion: state.suggestion,
      log: state.errorReported ? state.log : `${state.log}\n[error] ${error}\n`,
      error,
    };
  }
  if (state.type === 'creation-failed') {
    return {
      type: 'creation-failed',
      model: state.setup.model,
      discovery: state.discovery,
      suggestion: state.suggestion,
      log: state.log,
      error: state.error,
      ...(state.job && { job: state.job }),
    };
  }
  return null;
}

export function parseProjectDiscoveryResume(value: string | null): ProjectDiscoveryResume | null {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<ProjectDiscoveryResume>;
    const modelValid = parsed.model === null || typeof parsed.model === 'string';
    if (!modelValid) return null;
    if (parsed.type === 'ready' && 'intent' in parsed && parsed.intent
      && (parsed.intent.type === 'scan' || parsed.intent.type === 'retry-scan'
        || (parsed.intent.type === 'retry-create' && parsed.intent.discovery && parsed.intent.suggestion))) {
      return parsed as ProjectDiscoveryResume;
    }
    if (parsed.type === 'scanning' && 'job' in parsed && parsed.job && typeof parsed.job.sessionId === 'string') {
      return parsed as ProjectDiscoveryResume;
    }
    if (parsed.type === 'scan-failed' && typeof parsed.error === 'string') return parsed as ProjectDiscoveryResume;
    if (parsed.type === 'suggestions' && 'discovery' in parsed && parsed.discovery) return parsed as ProjectDiscoveryResume;
    if (parsed.type === 'creating'
      && 'discovery' in parsed && parsed.discovery
      && 'suggestion' in parsed && parsed.suggestion
      && 'job' in parsed && parsed.job && typeof parsed.job.sessionId === 'string') return parsed as ProjectDiscoveryResume;
    if (parsed.type === 'creation-failed'
      && 'discovery' in parsed && parsed.discovery
      && 'suggestion' in parsed && parsed.suggestion
      && typeof parsed.log === 'string'
      && typeof parsed.error === 'string') return parsed as ProjectDiscoveryResume;
  } catch {
    // Ignore stale or malformed tab state and start from provider/model setup.
  }
  return null;
}
