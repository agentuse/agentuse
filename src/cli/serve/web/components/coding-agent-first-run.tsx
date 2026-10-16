import { useEffect, useState } from 'preact/hooks';
import { fetchCodingAgents, reportOnboardingTelemetry, setUpCodingAgent, type CodingAgentId, type CodingAgentStatus } from '../lib/api';
import { projectDiscoveryHref } from '../lib/links';
import { OnboardingShell } from './onboarding-shell';

/**
 * The dashboard's first run on this computer: no agents yet, so connect a
 * coding agent and ask it to make one. Finding ideas or describing a job here
 * stay one link away for people without a coding agent.
 */
export function CodingAgentFirstRun(props: { projectId: string; projectName: string; projectPath: string }) {
  const [agents, setAgents] = useState<CodingAgentStatus[] | null>(null);
  const [busy, setBusy] = useState<CodingAgentId | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => { reportOnboardingTelemetry({ event: 'onboarding_started' }); }, []);
  useEffect(() => {
    fetchCodingAgents()
      .then((payload) => setAgents(payload.agents))
      .catch((err: unknown) => setError(err instanceof Error ? err.message : String(err)));
  }, []);

  const setUp = async (id: CodingAgentId) => {
    setBusy(id);
    setError(null);
    try {
      const { agent } = await setUpCodingAgent(id);
      setAgents((current) => current?.map((candidate) => candidate.id === agent.id ? agent : candidate) ?? [agent]);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(null);
    }
  };

  const connected = agents?.some((agent) => agent.state === 'set-up') ?? false;
  return (
    <OnboardingShell
      labelledBy="first-run-title"
      stepsLabel="Getting started"
      steps={[
        { number: '01', title: 'Project', detail: props.projectName },
        { number: '02', title: 'Connect a coding agent', detail: connected ? 'Ready' : 'Claude Code or Codex', current: !connected },
        { number: '03', title: 'Ask it to automate', detail: 'It makes the agent', current: connected },
      ]}
    >
      <div class="eyebrow">Your first agent</div>
      <h2 id="first-run-title">No agents yet</h2>
      <p class="onboarding-lede">Make your first one from your coding agent. AgentUse adds itself to the app, then you ask it to automate a job, like “every Monday, sum up last week's merged pull requests.”</p>
      <ul class="coding-agent-list" aria-label="Coding agents on this computer">
        {agents === null && !error && <li><span class="coding-agent-state">Looking for coding agents…</span></li>}
        {agents?.map((agent) => (
          <li key={agent.id}>
            <span class="coding-agent-name"><strong>{agent.name}</strong><code>{agent.configPath}</code></span>
            {agent.state === 'set-up'
              ? <span class="coding-agent-state is-ready">✓ Set up</span>
              : agent.state === 'not-installed'
                ? <span class="coding-agent-state">Not installed</span>
                : <button type="button" class="onboarding-primary" disabled={busy !== null} onClick={() => { void setUp(agent.id); }}>
                    {busy === agent.id ? 'Setting up…' : agent.state === 'outdated' ? 'Update' : 'Set up'}
                  </button>}
          </li>
        ))}
      </ul>
      {error && <p class="onboarding-error" role="alert">{error}</p>}
      {connected && <p class="onboarding-assurance">Open a new Claude Code or Codex session to use it.</p>}
      <div class="onboarding-project">
        <span>Agents go in</span>
        <strong>{props.projectName}</strong>
        <code title={props.projectPath}>{props.projectPath}</code>
      </div>
      <div class="onboarding-actions">
        <span class="onboarding-assurance">No coding agent?</span>
        <a class="onboarding-skip-link" href="/agents?new=1">Describe a job here</a>
        <a class="onboarding-skip-link" href={projectDiscoveryHref(props.projectId)}>Find agent ideas</a>
      </div>
    </OnboardingShell>
  );
}
