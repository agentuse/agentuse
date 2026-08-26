import { useState } from 'preact/hooks';
import { FIRST_PROJECT_DEFAULT_NAME } from '../../../../onboarding';
import { createManagedProject } from '../lib/api';

export function FirstProjectEmptyState(props: { compact?: boolean }) {
  const [name, setName] = useState(FIRST_PROJECT_DEFAULT_NAME);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (event: Event) => {
    event.preventDefault();
    if (busy || !name.trim()) return;
    setBusy(true);
    setError(null);
    try {
      await createManagedProject(name.trim());
      location.reload();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <section class={`onboarding-empty first-project-empty${props.compact ? ' is-compact' : ''}`} aria-labelledby="first-project-title">
      <div class="onboarding-copy">
        <div class="eyebrow">Get started</div>
        {props.compact
          ? <h2 id="first-project-title">Create your first project</h2>
          : <h1 id="first-project-title">Create your first project</h1>}
        <p class="onboarding-lede">
          A project keeps your agents and their run history together. Name it now; you can change it later.
        </p>
        <form class="first-project-form" onSubmit={submit}>
          <label for="first-project-name">Project name</label>
          <div class="first-project-input-row">
            <input
              id="first-project-name"
              value={name}
              maxLength={80}
              autofocus
              disabled={busy}
              onInput={(event) => setName(event.currentTarget.value)}
            />
            <button type="submit" class="onboarding-primary" disabled={busy || !name.trim()} aria-busy={busy}>
              {busy && <span class="btn-spinner" aria-hidden="true" />}
              {busy ? 'Creating…' : 'Create project'}
            </button>
          </div>
          <small>Stored for you under <code>~/.agentuse/projects</code>. Nothing is added to the folder where you started AgentUse.</small>
        </form>
        {error && <div class="onboarding-error" role="alert">{error}</div>}
      </div>

      <ol class="onboarding-steps" aria-label="First agent setup steps">
        <li class="is-current">
          <span class="onboarding-step-number">01</span>
          <span><strong>Create a project</strong><small>Choose a simple name</small></span>
        </li>
        <li>
          <span class="onboarding-step-number">02</span>
          <span><strong>Run a sample</strong><small>See an agent result in this dashboard</small></span>
        </li>
        <li>
          <span class="onboarding-step-number">03</span>
          <span><strong>Create your agent</strong><small>Use your coding agent, then run it here</small></span>
        </li>
      </ol>
    </section>
  );
}
