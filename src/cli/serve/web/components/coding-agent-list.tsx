import { useEffect, useState } from 'preact/hooks';
import { useFetch } from '../hooks/use-fetch';
import { fetchCodingAgents, setUpCodingAgent, type CodingAgentStatus } from '../lib/api';

/**
 * Claude Code and Codex on this computer, and adding AgentUse to one. They
 * always use this computer's own address, in both local and cloud setups, so
 * no address is shown. A remote AgentUse answers 403 and `error` is set.
 */
export function useCodingAgents() {
  const listed = useFetch('coding-agents', () => fetchCodingAgents());
  const [updated, setUpdated] = useState<CodingAgentStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  // Installed Claude Code or Codex in another window: check again on coming back.
  const { refetch } = listed;
  useEffect(() => {
    if (busy) return;
    window.addEventListener('focus', refetch);
    return () => window.removeEventListener('focus', refetch);
  }, [busy, refetch]);
  // A fresh list replaces the rows a Set up updated.
  useEffect(() => setUpdated(null), [listed.data]);
  const rows = updated ?? listed.data?.agents ?? [];

  const setUp = async (agent: CodingAgentStatus) => {
    setBusy(agent.id);
    setFailed(null);
    try {
      const { agent: next } = await setUpCodingAgent(agent.id);
      setUpdated(rows.map((row) => row.id === next.id ? next : row));
    } catch (err) {
      setFailed(`${agent.name}: ${(err as Error).message}`);
    } finally {
      setBusy(null);
    }
  };
  return { rows, via: listed.data?.via, error: listed.error, busy, failed, setUp };
}

export function CodingAgentList(props: { agents: ReturnType<typeof useCodingAgents> }) {
  const { rows, via, busy, failed, setUp } = props.agents;
  return (
    <>
      <ul class="coding-agents">
        {rows.map((agent) => (
          <li key={agent.id} class={agent.state === 'not-installed' ? 'is-missing' : undefined}>
            <span class="coding-agents-name">
              <strong>{agent.name}</strong>
              <span>{agent.where}</span>
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
      {rows.length > 0 && rows.every((agent) => agent.state === 'not-installed') && (
        <p>Install <a href="https://claude.com/download" target="_blank" rel="noreferrer">the Claude app</a> or <a href="https://developers.openai.com/codex" target="_blank" rel="noreferrer">Codex</a> and open it once. This list updates when you come back.</p>
      )}
      {rows.some((agent) => agent.state === 'outdated') && (
        <p>{via === 'cloud'
          ? 'This Mac is now connected to AgentUse Cloud. Press Update to switch to it.'
          : 'AgentUse has a new address on this Mac. Press Update to switch to it.'}</p>
      )}
      {via === 'cloud' && rows.some((agent) => agent.state === 'set-up') && (
        <p>They reach AgentUse through AgentUse Cloud, so each asks you to sign in once. In Claude Code, open <code>/mcp</code> or run <code>claude mcp login agentuse</code>. In Codex, run <code>codex mcp login agentuse</code>, or sign in when the Codex app asks.</p>
      )}
      {failed && <p class="no-agents-error" role="alert">{failed}</p>}
    </>
  );
}
