import { useEffect, useState } from 'preact/hooks';
import { useFetch } from '../hooks/use-fetch';
import { fetchCloudState, fetchCodingAgents, setUpCodingAgent, type CodingAgentStatus } from '../lib/api';

/**
 * Home with no agents yet. Agents come from the person's coding agent or AI
 * assistant, so this adds AgentUse to the coding agents on this computer and
 * gives the address for chat apps, instead of starting a guided flow here.
 */
export function NoAgentsYet(props: { noProjects: boolean }) {
  const cloud = useFetch('home-cloud', () => fetchCloudState());
  // A remote AgentUse answers 403: it cannot write this computer's configs, so the list stays hidden.
  const listed = useFetch('home-coding-agents', () => fetchCodingAgents());
  const [agents, setAgents] = useState<CodingAgentStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  // Installed Claude Code or Codex in another window: check again on coming back.
  const { refetch } = listed;
  useEffect(() => {
    if (busy) return;
    window.addEventListener('focus', refetch);
    return () => window.removeEventListener('focus', refetch);
  }, [busy, refetch]);
  // A fresh list replaces the rows a Set up updated.
  useEffect(() => setAgents(null), [listed.data]);
  const rows = agents ?? listed.data?.agents ?? [];
  const mcpUrl = cloud.data?.mcpUrl;
  const localUrl = `${location.origin}/mcp`;

  const copy = (value: string) => {
    void navigator.clipboard?.writeText(value).then(() => {
      setCopied(value);
      setTimeout(() => setCopied(null), 1500);
    }, () => { /* the value stays visible to copy by hand */ });
  };
  const setUp = async (agent: CodingAgentStatus) => {
    setBusy(agent.id);
    setFailed(null);
    try {
      const { agent: updated } = await setUpCodingAgent(agent.id);
      setAgents(rows.map((row) => row.id === updated.id ? updated : row));
    } catch (err) {
      setFailed(`${agent.name}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };

  return (
    <section class="no-agents" aria-labelledby="no-agents-title">
      <h1 id="no-agents-title">No agents yet</h1>
      <p class="no-agents-lede">
        Ask your coding agent or AI assistant to automate a job. It writes the agent, and the agent runs here on schedule.
      </p>
      {props.noProjects && (
        <p class="no-agents-note">There's no project yet. <a href="/settings">Add one in Settings</a>, or ask your assistant to make one.</p>
      )}
      {!listed.error && (
        <div class="no-agents-way">
          <h2>Connect your coding agents</h2>
          <p>AgentUse adds itself to each one. Then type /automate in Claude Code, or $automate in Codex.</p>
          <ul class="coding-agents">
            {rows.map((agent) => (
              <li key={agent.id} class={agent.state === 'not-installed' ? 'is-missing' : undefined}>
                <span class="coding-agents-name">
                  <strong>{agent.name}</strong>
                  {agent.state !== 'not-installed' && <code>{agent.configPath}</code>}
                </span>
                {agent.state === 'not-installed'
                  ? <span class="coding-agents-state">Not installed</span>
                  : agent.state === 'set-up'
                    ? <span class="coding-agents-state is-done">✓ Set up</span>
                    : <button type="button" disabled={busy !== null} onClick={() => void setUp(agent)}>
                        {busy === agent.id ? 'Setting up…' : agent.state === 'outdated' ? 'Update' : 'Set up'}
                      </button>}
              </li>
            ))}
          </ul>
          {failed && <p class="no-agents-error" role="alert">{failed}</p>}
          <p>
            Another app, like Cursor? Add this address to it:{' '}
            <button type="button" class="no-agents-link" onClick={() => copy(localUrl)}>{copied === localUrl ? 'Copied' : localUrl}</button>
          </p>
        </div>
      )}
      <div class="no-agents-way">
        <h2>Claude, ChatGPT or another chat app</h2>
        {mcpUrl
          ? <>
              <p>Add this address as a connector and sign in, then ask it to automate something.</p>
              <div class="no-agents-copy">
                <code>{mcpUrl}</code>
                <button type="button" onClick={() => copy(mcpUrl)}>{copied === mcpUrl ? 'Copied' : 'Copy'}</button>
              </div>
            </>
          : <p>Connect this computer to AgentUse Cloud first: in the Mac app open Settings › AgentUse Cloud, or run <code>agentuse setup</code>.</p>}
      </div>
    </section>
  );
}
