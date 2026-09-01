import { useEffect, useReducer } from 'preact/hooks';
import { FIRST_PROJECT_DEFAULT_NAME } from '../../../../onboarding';
import { attachExistingProject, createManagedProject, reportOnboardingTelemetry } from '../lib/api';
import { ProjectAgentDiscovery } from './project-agent-discovery';
import { ProjectFolderField } from './project-folder-field';
import { projectDiscoveryHref } from '../lib/links';
import { firstUsefulAgentSetupSteps, OnboardingShell } from './onboarding-shell';
import { initialProjectSelectionState, projectSelectionReducer } from './onboarding-machine';

export function FirstProjectEmptyState(props: { compact?: boolean; folderPickerAvailable?: boolean }) {
  const [state, dispatch] = useReducer(projectSelectionReducer, initialProjectSelectionState(FIRST_PROJECT_DEFAULT_NAME));

  useEffect(() => { reportOnboardingTelemetry({ event: 'onboarding_started' }); }, []);

  if (state.type === 'attached') {
    const { project } = state;
    if (project.agentCount > 0) {
      const agentLabel = `${project.agentCount} AgentUse ${project.agentCount === 1 ? 'agent' : 'agents'}`;
      return (
        <OnboardingShell
          className="existing-project-found"
          compact={props.compact}
          labelledBy="existing-project-title"
          stepsLabel="First useful agent setup steps"
          steps={firstUsefulAgentSetupSteps({ currentStep: 1, flow: 'existing', projectDetail: project.about?.name ?? project.id })}
        >
            <div class="eyebrow">Project ready</div>
            <h2 id="existing-project-title">This project already has {project.agentCount} {project.agentCount === 1 ? 'agent' : 'agents'}</h2>
            <p class="onboarding-lede">Open its agents, or find another useful workflow in this project.</p>
            <div class="onboarding-project">
              <span>Existing project</span>
              <strong>{project.about?.name ?? project.id}</strong>
              <code title={project.path}>{project.path}</code>
              <small>{agentLabel} found</small>
            </div>
            <div class="onboarding-actions existing-project-actions">
              <button type="button" class="onboarding-primary" onClick={() => { window.location.href = '/agents'; }}>Open agent dashboard</button>
              <button type="button" class="onboarding-secondary" onClick={() => {
                window.location.href = projectDiscoveryHref(project.id);
              }}>Scan for new ideas</button>
            </div>
        </OnboardingShell>
      );
    }
    return <ProjectAgentDiscovery
      projectId={project.id}
      {...(project.about?.name ? { projectName: project.about.name } : {})}
      projectPath={project.path}
      {...(state.origin === 'new' ? { startDirectCreate: true } : {})}
      {...(props.compact ? { compact: true } : {})}
    />;
  }

  const busy = (state.type === 'new' && state.submitting)
    || (state.type === 'existing' && state.activity === 'submitting');
  const choosing = state.type === 'existing' && state.activity === 'choosing-folder';
  const error = state.type === 'new' || state.type === 'existing' ? state.error : null;

  const createNew = async (event: Event) => {
    event.preventDefault();
    if (state.type !== 'new' || state.submitting || !state.name.trim()) return;
    dispatch({ type: 'SUBMIT_STARTED' });
    try {
      const result = await createManagedProject(state.name.trim());
      reportOnboardingTelemetry({ event: 'onboarding_step_completed', step: 'project_created' });
      dispatch({ type: 'PROJECT_ATTACHED', project: result.project, origin: 'new' });
    } catch (err) {
      reportOnboardingTelemetry({ event: 'onboarding_step_failed', step: 'project_created', error_code: 'project_create_failed' });
      dispatch({ type: 'FAILED', error: (err as Error).message });
    }
  };

  const attachExisting = async (event: Event) => {
    event.preventDefault();
    if (state.type !== 'existing' || state.activity !== 'idle' || !state.path.trim()) return;
    dispatch({ type: 'SUBMIT_STARTED' });
    try {
      const result = await attachExistingProject(state.path.trim());
      reportOnboardingTelemetry({ event: 'onboarding_step_completed', step: 'project_created' });
      dispatch({ type: 'PROJECT_ATTACHED', project: result.project, origin: 'existing' });
    } catch (err) {
      reportOnboardingTelemetry({ event: 'onboarding_step_failed', step: 'project_created', error_code: 'project_create_failed' });
      dispatch({ type: 'FAILED', error: (err as Error).message });
    }
  };

  return (
    <OnboardingShell
      className="first-project-empty"
      compact={props.compact}
      labelledBy="first-project-title"
      stepsLabel="First useful agent setup steps"
      steps={firstUsefulAgentSetupSteps({
        currentStep: 1,
        flow: state.type === 'new' ? 'new' : state.type === 'existing' ? 'existing' : 'choose',
      })}
    >
        <div class="eyebrow">Get started</div>
        {props.compact ? <h2 id="first-project-title">Build your first agent</h2> : <h1 id="first-project-title">Build your first agent</h1>}
        <p class="onboarding-lede">Start fresh or find recurring work in an existing project.</p>

        {state.type === 'choose' && (
          <div class="project-choice-grid">
            <button type="button" class="project-choice-card" onClick={() => dispatch({ type: 'CHOOSE_NEW' })}>
              <strong>Start a new project</strong>
              <span>Build an agent in an empty workspace.</span>
              <small>New workflow</small>
            </button>
            <button type="button" class="project-choice-card is-recommended" onClick={() => dispatch({ type: 'CHOOSE_EXISTING' })}>
              <strong>Use an existing project</strong>
              <span>Find recurring work in its files.</span>
              <small>Recommended</small>
            </button>
          </div>
        )}

        {state.type === 'new' && (
          <form class="first-project-form" onSubmit={createNew}>
            <label for="first-project-name">Project name</label>
            <div class="first-project-field-row">
              <input id="first-project-name" value={state.name} maxLength={80} autofocus disabled={busy} onInput={(event) => dispatch({ type: 'NAME_CHANGED', name: event.currentTarget.value })} />
            </div>
            <div class="first-project-footer">
              <small>Stored in the AgentUse configuration profile's <code>projects/</code> folder. Nothing is added to the folder where you started AgentUse.</small>
              <div class="first-project-actions">
                <button type="button" class="onboarding-secondary" onClick={() => dispatch({ type: 'BACK' })} disabled={busy}>Back to project choices</button>
                <button type="submit" class="onboarding-primary" disabled={busy || !state.name.trim()} aria-busy={busy}>{busy && <span class="btn-spinner" aria-hidden="true" />}{busy ? 'Creating…' : 'Create project'}</button>
              </div>
            </div>
          </form>
        )}

        {state.type === 'existing' && (
          <form class="first-project-form" onSubmit={attachExisting}>
            <ProjectFolderField
              id="existing-project-path"
              value={state.path}
              pickerAvailable={props.folderPickerAvailable === true}
              autofocus
              disabled={busy || choosing}
              onChange={(path) => dispatch({ type: 'PATH_CHANGED', path })}
              onPickingChange={(picking) => dispatch(picking
                ? { type: 'FOLDER_PICK_STARTED' }
                : { type: 'FOLDER_PICKED', path: null })}
              onError={(message) => dispatch({ type: 'FAILED', error: message })}
            />
            <div class="first-project-footer">
              <small>The folder stays in place. The next step is read-only.</small>
              <div class="first-project-actions">
                <button type="button" class="onboarding-secondary" onClick={() => dispatch({ type: 'BACK' })} disabled={busy || choosing}>Back to project choices</button>
                <button type="submit" class="onboarding-primary" disabled={busy || !state.path.trim()} aria-busy={busy}>{busy && <span class="btn-spinner" aria-hidden="true" />}{busy ? 'Opening…' : 'Use this project'}</button>
              </div>
            </div>
          </form>
        )}
        {error && <div class="onboarding-error" role="alert">{error}</div>}
    </OnboardingShell>
  );
}
