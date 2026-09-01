import { describe, expect, it } from 'bun:test';
import {
  initialProjectDiscoveryState,
  initialProjectSelectionState,
  onboardingCurrentStep,
  onboardingDiscovery,
  onboardingSuggestion,
  parseProjectDiscoveryResume,
  projectDiscoveryModelOptions,
  projectDiscoveryModelReady,
  projectDiscoveryReducer,
  projectSelectionReducer,
  resumableProjectDiscoveryState,
  type ProjectDiscoveryState,
} from '../src/cli/serve/web/components/onboarding-machine';
import type {
  AgentCreationOptionsPayload,
  ProjectAgentSuggestion,
  ProjectDiscoveryPayload,
  ProviderSetupPayload,
} from '../src/cli/serve/web/lib/api';

const provider = (configured: boolean): ProviderSetupPayload => ({
  success: true,
  catalog: [],
  status: {
    credentialStore: '/tmp/auth.json',
    providers: [{ id: 'openai', name: 'OpenAI', configured, sources: [] }],
    customProviders: [],
  },
});

const options: AgentCreationOptionsPayload = {
  success: true,
  providers: [{ id: 'openai', name: 'OpenAI', models: ['openai:gpt-5.6-terra'], defaultModel: 'openai:gpt-5.6-terra' }],
  projects: [{ id: 'demo', path: '/tmp/demo' }],
  default: 'demo',
};

const suggestion: ProjectAgentSuggestion = {
  id: 'docs-drift',
  name: 'Documentation drift review',
  description: 'Compare guides with shipped behavior.',
  objective: 'Review documentation drift.',
  schedule: '0 10 * * 5',
  scheduleHuman: 'Friday at 10:00 AM',
  evidence: ['docs and manifests'],
};

const discovery: ProjectDiscoveryPayload = {
  success: true,
  model: 'openai:gpt-5.6-terra',
  projectName: 'demo',
  summary: 'Found useful recurring work.',
  inspectedFiles: 42,
  suggestions: [suggestion],
};

const job = {
  id: '01JOB',
  sessionId: '01JOB',
  projectId: 'demo',
  kind: 'project-discovery' as const,
  status: 'running' as const,
  model: 'openai:gpt-5.6-terra',
  createdAt: 1,
};

function readyState(): ProjectDiscoveryState {
  const state = projectDiscoveryReducer(initialProjectDiscoveryState, {
    type: 'BOOT_SUCCEEDED',
    provider: provider(true),
    options,
  });
  return projectDiscoveryReducer(state, { type: 'MODEL_SELECTED', model: 'openai:gpt-5.6-terra' });
}

function suggestionsState(): ProjectDiscoveryState {
  const scanning = projectDiscoveryReducer(readyState(), { type: 'SCAN_STARTED' });
  return projectDiscoveryReducer(scanning, { type: 'SCAN_SUCCEEDED', discovery });
}

describe('project discovery onboarding machine', () => {
  it('shows custom providers as model-ID entries and requires a complete ID', () => {
    const providers = [
      ...options.providers,
      { id: 'local', name: 'local', models: [], custom: true as const },
    ];
    expect(projectDiscoveryModelOptions(providers)).toContainEqual({
      value: 'local:',
      label: 'local · Enter model ID…',
    });
    expect(projectDiscoveryModelReady('local:', providers)).toBe(false);
    expect(projectDiscoveryModelReady('local:qwen3', providers)).toBe(true);
    expect(projectDiscoveryModelReady('unknown:qwen3', providers)).toBe(false);
  });

  it('boots into the provider gate or explicit model-selection state from provider status', () => {
    const gated = projectDiscoveryReducer(initialProjectDiscoveryState, {
      type: 'BOOT_SUCCEEDED',
      provider: provider(false),
      options,
    });
    const ready = projectDiscoveryReducer(initialProjectDiscoveryState, {
      type: 'BOOT_SUCCEEDED',
      provider: provider(true),
      options,
    });

    expect(gated.type).toBe('provider-required');
    expect(ready.type).toBe('ready');
    if (ready.type === 'ready') {
      expect(ready.intent).toEqual({ type: 'scan' });
      expect(ready.setup.model).toBeNull();
    }
  });

  it('returns from provider connection to explicit model selection', () => {
    const gated = projectDiscoveryReducer(initialProjectDiscoveryState, {
      type: 'BOOT_SUCCEEDED',
      provider: provider(false),
      options,
    });
    const selecting = projectDiscoveryReducer(gated, {
      type: 'PROVIDER_CONNECTED',
      provider: provider(true),
      options,
    });

    expect(selecting.type).toBe('ready');
    if (selecting.type === 'ready') {
      expect(selecting.intent).toEqual({ type: 'scan' });
      expect(selecting.setup.model).toBeNull();
    }
  });

  it('preserves scan configuration while recovering through model selection', () => {
    const scanning = projectDiscoveryReducer(readyState(), { type: 'SCAN_STARTED' });
    const failed = projectDiscoveryReducer(scanning, { type: 'SCAN_FAILED', error: 'Timed out' });
    const selecting = projectDiscoveryReducer(failed, { type: 'CHOOSE_MODEL_AFTER_SCAN' });

    expect(failed.type).toBe('scan-failed');
    expect(onboardingCurrentStep(failed)).toBe(3);
    expect(selecting.type).toBe('ready');
    if (selecting.type === 'ready') {
      expect(selecting.intent).toEqual({ type: 'retry-scan' });
      expect(selecting.setup.model).toBeNull();
    }
  });

  it('retains the suggestion, discovery, and streamed log after creation fails', () => {
    let state = projectDiscoveryReducer(suggestionsState(), { type: 'CREATION_STARTED', suggestion });
    state = projectDiscoveryReducer(state, { type: 'CREATION_STATUS', message: 'Preparing model' });
    state = projectDiscoveryReducer(state, { type: 'CREATION_DRAFT', text: '## Goal\nReview docs.' });
    state = projectDiscoveryReducer(state, { type: 'CREATION_FAILED', error: 'Invalid source' });

    expect(state.type).toBe('creation-failed');
    expect(onboardingCurrentStep(state)).toBe(4);
    expect(onboardingDiscovery(state)).toEqual(discovery);
    expect(onboardingSuggestion(state)).toEqual(suggestion);
    if (state.type === 'creation-failed') {
      expect(state.log).toContain('[agentuse] Preparing model');
      expect(state.log).toContain('[model draft]');
      expect(state.log).toContain('[error] Invalid source');
    }
  });

  it('returns creation recovery to model selection without losing the chosen idea', () => {
    const creating = projectDiscoveryReducer(suggestionsState(), { type: 'CREATION_STARTED', suggestion });
    const failed = projectDiscoveryReducer(creating, { type: 'CREATION_FAILED', error: 'Invalid source' });
    const selecting = projectDiscoveryReducer(failed, { type: 'CHOOSE_MODEL_AFTER_CREATION' });
    const changed = projectDiscoveryReducer(selecting, { type: 'MODEL_SELECTED', model: 'openai:gpt-5.6-sol' });
    const retrying = projectDiscoveryReducer(changed, { type: 'CREATION_STARTED', suggestion });

    expect(selecting.type).toBe('ready');
    expect(onboardingSuggestion(selecting)).toEqual(suggestion);
    expect(onboardingDiscovery(selecting)).toEqual(discovery);
    if (selecting.type === 'ready') expect(selecting.setup.model).toBeNull();
    expect(retrying.type).toBe('creating');
    if (retrying.type === 'creating') expect(retrying.setup.model).toBe('openai:gpt-5.6-sol');
  });

  it('ignores transitions that are invalid for the current state', () => {
    const ready = readyState();
    expect(projectDiscoveryReducer(ready, { type: 'SCAN_SUCCEEDED', discovery })).toBe(ready);
    expect(projectDiscoveryReducer(ready, { type: 'CREATION_DRAFT', text: 'unexpected' })).toBe(ready);
  });

  it('restores a failed creation after reload with its suggestion and log intact', () => {
    const creating = projectDiscoveryReducer(suggestionsState(), { type: 'CREATION_STARTED', suggestion });
    const drafted = projectDiscoveryReducer(creating, { type: 'CREATION_DRAFT', text: '## Goal\nReview docs.' });
    const resume = resumableProjectDiscoveryState(drafted);
    const parsed = parseProjectDiscoveryResume(JSON.stringify(resume));
    const restored = parsed
      ? projectDiscoveryReducer(readyState(), { type: 'RESTORE', resume: parsed })
      : readyState();

    expect(parsed?.type).toBe('creation-failed');
    expect(restored.type).toBe('creation-failed');
    expect(onboardingSuggestion(restored)).toEqual(suggestion);
    if (restored.type === 'creation-failed') {
      expect(restored.log).toContain('[model draft]');
      expect(restored.log).toContain('creation was interrupted');
    }
  });

  it('ignores malformed resume data', () => {
    expect(parseProjectDiscoveryResume(null)).toBeNull();
    expect(parseProjectDiscoveryResume('{bad json')).toBeNull();
    expect(parseProjectDiscoveryResume(JSON.stringify({ type: 'suggestions', model: null }))).toBeNull();
  });

  it('restores a live scan session instead of restarting model work', () => {
    let state = projectDiscoveryReducer(readyState(), { type: 'SCAN_STARTED' });
    state = projectDiscoveryReducer(state, { type: 'SCAN_SESSION_STARTED', job });
    const resume = resumableProjectDiscoveryState(state);
    const parsed = parseProjectDiscoveryResume(JSON.stringify(resume));
    const restored = parsed ? projectDiscoveryReducer(readyState(), { type: 'RESTORE', resume: parsed }) : readyState();

    expect(parsed?.type).toBe('scanning');
    expect(restored.type).toBe('scanning');
    if (restored.type === 'scanning') expect(restored.job?.sessionId).toBe('01JOB');
  });

  it('restores a live creator session with its reviewed suggestion', () => {
    let state = projectDiscoveryReducer(suggestionsState(), { type: 'CREATION_STARTED', suggestion });
    state = projectDiscoveryReducer(state, { type: 'CREATION_SESSION_STARTED', job: { ...job, kind: 'agent-creation' } });
    const resume = resumableProjectDiscoveryState(state);
    const parsed = parseProjectDiscoveryResume(JSON.stringify(resume));
    const restored = parsed ? projectDiscoveryReducer(readyState(), { type: 'RESTORE', resume: parsed }) : readyState();

    expect(parsed?.type).toBe('creating');
    expect(restored.type).toBe('creating');
    expect(onboardingSuggestion(restored)).toEqual(suggestion);
    if (restored.type === 'creating') expect(restored.job?.kind).toBe('agent-creation');
  });
});

describe('project selection onboarding machine', () => {
  it('keeps project drafts while moving backward and forward', () => {
    let state = projectSelectionReducer(initialProjectSelectionState('My agents'), { type: 'CHOOSE_EXISTING' });
    state = projectSelectionReducer(state, { type: 'PATH_CHANGED', path: '/tmp/my-project' });
    state = projectSelectionReducer(state, { type: 'BACK' });
    state = projectSelectionReducer(state, { type: 'CHOOSE_EXISTING' });

    expect(state.type).toBe('existing');
    if (state.type === 'existing') expect(state.path).toBe('/tmp/my-project');
  });

  it('represents folder picking and project submission as exclusive activities', () => {
    let state = projectSelectionReducer(initialProjectSelectionState('My agents'), { type: 'CHOOSE_EXISTING' });
    state = projectSelectionReducer(state, { type: 'FOLDER_PICK_STARTED' });
    const ignoredSubmit = projectSelectionReducer(state, { type: 'SUBMIT_STARTED' });
    state = projectSelectionReducer(ignoredSubmit, { type: 'FOLDER_PICKED', path: '/tmp/chosen' });
    state = projectSelectionReducer(state, { type: 'SUBMIT_STARTED' });

    expect(ignoredSubmit.type).toBe('existing');
    if (ignoredSubmit.type === 'existing') expect(ignoredSubmit.activity).toBe('choosing-folder');
    expect(state.type).toBe('existing');
    if (state.type === 'existing') {
      expect(state.activity).toBe('submitting');
      expect(state.path).toBe('/tmp/chosen');
    }
  });

  it('moves directly into the attached project state without a page reload', () => {
    const project = { id: 'demo', path: '/tmp/demo', agentCount: 0, scheduleCount: 0 };
    const state = projectSelectionReducer(initialProjectSelectionState('My agents'), { type: 'PROJECT_ATTACHED', project });

    expect(state).toEqual({ type: 'attached', project });
    expect(projectSelectionReducer(state, { type: 'BACK' })).toBe(state);
  });
});
