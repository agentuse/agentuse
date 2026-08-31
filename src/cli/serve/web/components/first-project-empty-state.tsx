import { useEffect, useState } from 'preact/hooks';
import { FIRST_PROJECT_DEFAULT_NAME } from '../../../../onboarding';
import { attachExistingProject, createManagedProject, pickProjectFolder, reportOnboardingTelemetry, type ProjectInfo } from '../lib/api';
import { ProjectAgentDiscovery } from './project-agent-discovery';
import { projectDiscoveryHref } from '../lib/links';

type ProjectChoice = 'new' | 'existing' | null;

export function FirstProjectEmptyState(props: { compact?: boolean; folderPickerAvailable?: boolean }) {
  const [choice, setChoice] = useState<ProjectChoice>(null);
  const [name, setName] = useState(FIRST_PROJECT_DEFAULT_NAME);
  const [path, setPath] = useState('');
  const [attached, setAttached] = useState<ProjectInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [choosing, setChoosing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { reportOnboardingTelemetry({ event: 'onboarding_started' }); }, []);

  if (attached) {
    if (attached.agentCount > 0) {
      const agentLabel = `${attached.agentCount} AgentUse ${attached.agentCount === 1 ? 'agent' : 'agents'}`;
      return (
        <section class={`onboarding-empty existing-project-found${props.compact ? ' is-compact' : ''}`} aria-labelledby="existing-project-title">
          <div class="onboarding-copy">
            <div class="eyebrow">Project ready</div>
            <h2 id="existing-project-title">This project already has {attached.agentCount} {attached.agentCount === 1 ? 'agent' : 'agents'}</h2>
            <p class="onboarding-lede">Open the dashboard to work with what’s already here, or scan the project for another useful agent grounded in its code and documentation.</p>
            <div class="onboarding-project">
              <span>Existing project</span>
              <strong>{attached.about?.name ?? attached.id}</strong>
              <code title={attached.path}>{attached.path}</code>
              <small>{agentLabel} found</small>
            </div>
            <div class="onboarding-actions existing-project-actions">
              <button type="button" class="onboarding-primary" onClick={() => { window.location.href = '/agents'; }}>Open agent dashboard</button>
              <button type="button" class="onboarding-secondary" onClick={() => {
                window.location.href = projectDiscoveryHref(attached.id);
              }}>Scan for new ideas</button>
            </div>
          </div>
          <ol class="onboarding-steps" aria-label="Existing project next steps">
            <li><span class="onboarding-step-number">01</span><span><strong>Project selected</strong><small>{attached.about?.name ?? attached.id}</small></span></li>
            <li><span class="onboarding-step-number">02</span><span><strong>Existing agents found</strong><small>{agentLabel} ready to use</small></span></li>
            <li class="is-current"><span class="onboarding-step-number">03</span><span><strong>Choose what’s next</strong><small>Open the dashboard or discover another idea</small></span></li>
          </ol>
        </section>
      );
    }
    return <ProjectAgentDiscovery projectId={attached.id} {...(attached.about?.name ? { projectName: attached.about.name } : {})} projectPath={attached.path} {...(props.compact ? { compact: true } : {})} />;
  }

  const createNew = async (event: Event) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createManagedProject(name.trim());
      reportOnboardingTelemetry({ event: 'onboarding_step_completed', step: 'project_created' });
      location.reload();
    } catch (err) {
      reportOnboardingTelemetry({ event: 'onboarding_step_failed', step: 'project_created', error_code: 'project_create_failed' });
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const attachExisting = async (event: Event) => {
    event.preventDefault();
    if (busy || !path.trim()) return;
    setBusy(true);
    setError(null);
    try {
      const result = await attachExistingProject(path.trim());
      reportOnboardingTelemetry({ event: 'onboarding_step_completed', step: 'project_created' });
      setAttached(result.project);
    } catch (err) {
      reportOnboardingTelemetry({ event: 'onboarding_step_failed', step: 'project_created', error_code: 'project_create_failed' });
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const chooseFolder = async () => {
    if (busy || choosing) return;
    setChoosing(true);
    setError(null);
    try {
      const selected = await pickProjectFolder();
      if (selected) setPath(selected);
    } catch (err) {
      setError((err as Error).message || 'Could not open the folder chooser.');
    } finally {
      setChoosing(false);
    }
  };

  return (
    <section class={`onboarding-empty first-project-empty${props.compact ? ' is-compact' : ''}`} aria-labelledby="first-project-title">
      <div class="onboarding-copy">
        <div class="eyebrow">Get started</div>
        {props.compact ? <h2 id="first-project-title">Start with real work</h2> : <h1 id="first-project-title">Start with real work</h1>}
        <p class="onboarding-lede">Choose where your first useful agent should live. AgentUse can start clean or learn from a project you already work on.</p>

        {!choice && (
          <div class="project-choice-grid">
            <button type="button" class="project-choice-card" onClick={() => setChoice('new')}>
              <strong>Create a new project</strong>
              <span>Start with an empty AgentUse workspace and shape the first agent yourself.</span>
              <small>Best for a new workflow</small>
            </button>
            <button type="button" class="project-choice-card is-recommended" onClick={() => setChoice('existing')}>
              <strong>Choose a project you already work on</strong>
              <span>Connect a provider, scan project context, and get three grounded agent ideas.</span>
              <small>Recommended for your first useful agent</small>
            </button>
          </div>
        )}

        {choice === 'new' && (
          <form class="first-project-form" onSubmit={createNew}>
            <label for="first-project-name">Project name</label>
            <div class="first-project-field-row">
              <input id="first-project-name" value={name} maxLength={80} autofocus disabled={busy} onInput={(event) => setName(event.currentTarget.value)} />
            </div>
            <div class="first-project-footer">
              <small>Stored under <code>~/.agentuse/projects</code>. Nothing is added to the folder where you started AgentUse.</small>
              <div class="first-project-actions">
                <button type="button" class="onboarding-secondary" onClick={() => setChoice(null)} disabled={busy}>Back to project choices</button>
                <button type="submit" class="onboarding-primary" disabled={busy || !name.trim()} aria-busy={busy}>{busy && <span class="btn-spinner" aria-hidden="true" />}{busy ? 'Creating…' : 'Create project'}</button>
              </div>
            </div>
          </form>
        )}

        {choice === 'existing' && (
          <form class="first-project-form" onSubmit={attachExisting}>
            <label for="existing-project-path">Project folder path</label>
            <div class="first-project-field-row">
              <input id="existing-project-path" value={path} placeholder="Choose a folder or enter its path" autofocus disabled={busy || choosing} onInput={(event) => setPath(event.currentTarget.value)} />
              {props.folderPickerAvailable && <button type="button" class="onboarding-secondary" disabled={busy || choosing} aria-busy={choosing} onClick={() => void chooseFolder()}>{choosing ? 'Choosing…' : 'Choose folder…'}</button>}
            </div>
            <div class="first-project-footer">
              <small>The project stays in place. AgentUse only saves the folder reference; the next step is a bounded, read-only scan.</small>
              <div class="first-project-actions">
                <button type="button" class="onboarding-secondary" onClick={() => setChoice(null)} disabled={busy || choosing}>Back to project choices</button>
                <button type="submit" class="onboarding-primary" disabled={busy || !path.trim()} aria-busy={busy}>{busy && <span class="btn-spinner" aria-hidden="true" />}{busy ? 'Opening…' : 'Use this project'}</button>
              </div>
            </div>
          </form>
        )}
        {error && <div class="onboarding-error" role="alert">{error}</div>}
      </div>

      <ol class="onboarding-steps" aria-label="First useful agent setup steps">
        <li class="is-current"><span class="onboarding-step-number">01</span><span><strong>Choose a project</strong><small>New or already in progress</small></span></li>
        <li><span class="onboarding-step-number">02</span><span><strong>Connect provider</strong><small>Required before project scan</small></span></li>
        <li><span class="onboarding-step-number">03</span><span><strong>Scan project</strong><small>Get three grounded suggestions</small></span></li>
        <li><span class="onboarding-step-number">04</span><span><strong>Create and run</strong><small>Review Source, then see the result</small></span></li>
      </ol>
    </section>
  );
}
