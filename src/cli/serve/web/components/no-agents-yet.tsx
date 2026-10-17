import { useEffect, useState } from 'preact/hooks';
import { useFetch } from '../hooks/use-fetch';
import { fetchCloudState, fetchCodingAgents, setUpCodingAgent, type CodingAgentStatus } from '../lib/api';

/** Jobs to start from. The person edits the copied text in their coding agent. */
const IDEAS = [
  { label: 'Inbox summary', job: 'every weekday at 9am, read my new email and send me a short list of what needs a reply' },
  { label: 'GitHub check', job: 'every Monday morning, list the issues in my GitHub repo that nobody has answered yet' },
  { label: 'Price watch', job: 'every evening, check these pricing pages and tell me what changed: ' },
];

/**
 * Home with no agents yet: a short tutorial for making the first one. Agents
 * come from the person's coding agent, so step 1 adds AgentUse to the coding
 * agents on this computer, step 2 hands over a prompt to paste there, and step
 * 3 says where the result shows up. Chat apps and other MCP apps sit below.
 */
export function NoAgentsYet(props: { noProjects: boolean }) {
  const cloud = useFetch('home-cloud', () => fetchCloudState());
  // A remote AgentUse answers 403: it cannot write this computer's configs, so the list stays hidden.
  const listed = useFetch('home-coding-agents', () => fetchCodingAgents());
  const [agents, setAgents] = useState<CodingAgentStatus[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [failed, setFailed] = useState<string | null>(null);
  const [copied, setCopied] = useState<string | null>(null);
  const [idea, setIdea] = useState(0);
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

  const ready = rows.filter((agent) => agent.state === 'set-up');
  const connected = ready.length > 0;
  // The command of the first coding agent that is set up; Claude Code's until one is.
  const command = ready[0]?.command ?? rows[0]?.command ?? '/automate';
  const prompt = `${command} ${IDEAS[idea].job}`;
  const where = ready.length === 1 ? ready[0].name : 'Claude Code or Codex';

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
      <header class="no-agents-head">
        <p class="no-agents-eyebrow">No agents yet</p>
        <h1 id="no-agents-title">Make your first agent</h1>
        <p class="no-agents-lede">
          Tell your coding agent which job to take off your hands. It writes the agent, you say yes, and the agent runs here on schedule.
        </p>
        {props.noProjects && (
          <p class="no-agents-note">There's no project yet. <a href="/settings">Add one in Settings</a>, or your coding agent makes one for you.</p>
        )}
      </header>

      <ol class="tutorial">
        {!listed.error && (
          <li class={connected ? 'tutorial-step is-done' : 'tutorial-step is-current'}>
            <span class="tutorial-mark" aria-hidden="true">{connected ? '✓' : '1'}</span>
            <div class="tutorial-body">
              <h2>Connect a coding agent</h2>
              <p>AgentUse adds itself to the coding agents on this computer.</p>
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
              {rows.length > 0 && rows.every((agent) => agent.state === 'not-installed') && (
                <p>Install <a href="https://claude.com/product/claude-code" target="_blank" rel="noreferrer">Claude Code</a> or <a href="https://developers.openai.com/codex" target="_blank" rel="noreferrer">Codex</a> and open it once. This list updates when you come back.</p>
              )}
              {failed && <p class="no-agents-error" role="alert">{failed}</p>}
            </div>
          </li>
        )}

        <li class={connected || listed.error ? 'tutorial-step is-current' : 'tutorial-step'}>
          <span class="tutorial-mark" aria-hidden="true">2</span>
          <div class="tutorial-body">
            <h2>Ask it to automate a job</h2>
            <p>Open {where} in any folder and paste this. Change the job to your own.</p>
            <div class="tutorial-ideas" role="group" aria-label="Example jobs">
              {IDEAS.map((item, index) => (
                <button key={item.label} type="button" aria-pressed={index === idea} onClick={() => setIdea(index)}>{item.label}</button>
              ))}
            </div>
            <div class="tutorial-prompt">
              <code>{prompt}</code>
              <button type="button" onClick={() => copy(prompt)}>{copied === prompt ? 'Copied' : 'Copy'}</button>
            </div>
            {ready.length > 1 && <p>In Codex, it starts with $automate instead.</p>}
          </div>
        </li>

        <li class="tutorial-step">
          <span class="tutorial-mark" aria-hidden="true">3</span>
          <div class="tutorial-body">
            <h2>Say yes</h2>
            <p>It shows you a draft first. Say yes in the chat, or press Apply on the review page it links. The agent then appears here, under Agents.</p>
          </div>
        </li>
      </ol>

      <details class="no-agents-more">
        <summary>Using Cursor, Claude, ChatGPT or another app?</summary>
        <div class="no-agents-more-body">
          <div class="no-agents-way">
            <h3>Cursor or another app on this computer</h3>
            <p>Add this MCP address to it.</p>
            <div class="no-agents-copy">
              <code>{localUrl}</code>
              <button type="button" onClick={() => copy(localUrl)}>{copied === localUrl ? 'Copied' : 'Copy'}</button>
            </div>
          </div>
          <div class="no-agents-way">
            <h3>Claude, ChatGPT or another chat app</h3>
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
        </div>
      </details>
    </section>
  );
}
