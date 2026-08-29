import { useEffect } from 'preact/hooks';
import type { SessionRow } from '../lib/api';
import { reportOnboardingTelemetry } from '../lib/api';
import { useOnboardingRun } from '../hooks/use-onboarding-run';

function sessionHref(session: SessionRow): string {
  const params = new URLSearchParams({ project: session.project });
  if (session.status === 'running') params.set('pending', '1');
  return `/sessions/${encodeURIComponent(session.sessionId)}?${params.toString()}`;
}

export function OnboardingEmptyState(props: {
  projectId?: string;
  projectName?: string;
  projectPath?: string;
  session?: SessionRow;
  compact?: boolean;
}) {
  const { run, busy, error } = useOnboardingRun(props.projectId);
  useEffect(() => {
    reportOnboardingTelemetry({ event: 'onboarding_started' });
  }, []);
  // A completed sample is not onboarding state users need to return to. Only
  // keep the link while it is live; afterward the empty state is ready to run
  // the sample again rather than becoming a permanent "review demo" screen.
  const activeSession = props.session?.status === 'running' ? props.session : undefined;
  const actionLabel = activeSession ? 'View sample run' : busy ? 'Starting…' : 'Run sample agent';

  return (
    <section class={`onboarding-empty${props.compact ? ' is-compact' : ''}`} aria-labelledby="onboarding-title">
      <div class="onboarding-copy">
        <div class="eyebrow">First run</div>
        {props.compact
          ? <h2 id="onboarding-title">Create your first agent</h2>
          : <h1 id="onboarding-title">Create your first agent</h1>}
        <p class="onboarding-lede">
          Watch a sample agent produce a useful result, then create one for your own work.
        </p>
        {(props.projectName || props.projectId) && (
          <div class="onboarding-project">
            <span>Project ready</span>
            <strong>{props.projectName ?? props.projectId}</strong>
            {props.projectPath && <code title={props.projectPath}>{props.projectPath}</code>}
          </div>
        )}
        <div class="onboarding-actions">
          {activeSession
            ? <a class="onboarding-primary" href={sessionHref(activeSession)}>{actionLabel}</a>
            : <button type="button" class="onboarding-primary" disabled={busy} aria-busy={busy} onClick={() => void run()}>
                {busy && <span class="btn-spinner" aria-hidden="true" />}
                {actionLabel}
              </button>}
          <span class="onboarding-assurance">Uses sample data · Won’t create an agent</span>
        </div>
        {error && <div class="onboarding-error" role="alert">{error}</div>}
      </div>

      <ol class="onboarding-steps" aria-label="First agent setup steps">
        <li>
          <span class="onboarding-step-number">01</span>
          <span><strong>Project created</strong><small>{props.projectName ?? props.projectId ?? 'Ready for your first agent'}</small></span>
        </li>
        <li class="is-current">
          <span class="onboarding-step-number">02</span>
          <span><strong>Run a sample</strong><small>See a result stream in this dashboard</small></span>
        </li>
        <li>
          <span class="onboarding-step-number">03</span>
          <span><strong>Connect a provider</strong><small>Choose how your real agents run</small></span>
        </li>
        <li>
          <span class="onboarding-step-number">04</span>
          <span><strong>Create your agent</strong><small>Use your coding agent, then run it here</small></span>
        </li>
      </ol>
    </section>
  );
}
