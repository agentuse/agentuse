import { useState } from 'preact/hooks';
import { useFetch } from '../hooks/use-fetch';
import { fetchCloudState } from '../lib/api';
import { outdatedNote, useCodingAgents } from './coding-agent-list';
import { CopyField } from './connect-apps-settings';

const CHAT_APPS = [
  {
    id: 'claude',
    name: 'Claude',
    steps: ['In Claude, open Settings › Connectors and choose Add custom connector.', 'Paste this address, then press Connect and sign in to AgentUse.'],
  },
  {
    id: 'chatgpt',
    name: 'ChatGPT',
    steps: ['In ChatGPT, turn on developer mode in Settings, then add a connector.', 'Paste this address, then sign in to AgentUse.'],
  },
] as const;

/**
 * Home step 1: one narrow card per assistant people know. Claude Code and
 * Codex set up with a button. With AgentUse Cloud turned on, Claude and
 * ChatGPT reach this machine through it, so Connect shows the address and
 * that app's two steps. Any other app copies the address.
 */
export function AssistantCards(props: { agents: ReturnType<typeof useCodingAgents> }) {
  const { rows, via, busy, failed, setUp, error } = props.agents;
  const cloud = useFetch('home-cloud', () => fetchCloudState());
  const [open, setOpen] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cloudUrl = cloud.data?.mcpUrl;
  const address = cloudUrl ?? `${location.origin}/mcp`;
  const chat = cloudUrl ? CHAT_APPS.find((app) => app.id === open) : undefined;
  const chatApps = cloud.data?.enabled ? CHAT_APPS : [];
  const isDesktop = typeof window !== 'undefined' && Boolean(window.agentuseDesktop);
  const note = error ? undefined : outdatedNote(rows, via);

  const copyAddress = () => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => { /* the address is also in Settings › Connect apps */ });
  };

  return (
    <>
      <ul class="assistant-cards">
        {!error && rows.map((agent) => (
          <li key={agent.id} class={agent.state === 'not-installed' ? 'is-missing' : undefined}>
            <span class="coding-agents-name">
              <strong>{agent.name}</strong>
              <span>{agent.where}</span>
            </span>
            <span class="assistant-cards-action">
              {agent.state === 'not-installed'
                ? <span class="coding-agents-state">Not installed</span>
                : agent.state === 'set-up'
                  ? <span class="coding-agents-state is-done">✓ Set up</span>
                  : <button type="button" class="is-primary" disabled={busy !== null} onClick={() => void setUp(agent)}>
                      {busy === agent.id ? 'Setting up…' : agent.state === 'outdated' ? 'Update' : 'Set up'}
                    </button>}
            </span>
          </li>
        ))}
        {chatApps.map((app) => (
          <li key={app.id}>
            <span class="coding-agents-name">
              <strong>{app.name}</strong>
              <span>Web, desktop, phone</span>
            </span>
            <span class="assistant-cards-action">
              {cloudUrl
                ? <button type="button" aria-expanded={open === app.id} onClick={() => setOpen(open === app.id ? null : app.id)}>Connect</button>
                : <span class="coding-agents-state">
                    Needs AgentUse Cloud{' '}
                    {isDesktop
                      ? <a href="#" onClick={(event) => { event.preventDefault(); void window.agentuseDesktop?.openSettings(); }}>Sign in</a>
                      : <a href="/settings?tab=apps">Sign in</a>}
                  </span>}
            </span>
          </li>
        ))}
      </ul>
      {chat && cloudUrl && (
        <div class="assistant-cards-steps">
          <ol>{chat.steps.map((step) => <li key={step}>{step}</li>)}</ol>
          <CopyField value={cloudUrl} />
        </div>
      )}
      <p>Using Cursor or another app? <button type="button" class="assistant-cards-copy" onClick={copyAddress}>{copied ? 'Copied' : 'Copy the address'}</button></p>
      {note && <p>{note}</p>}
      {via === 'cloud' && rows.some((agent) => agent.state === 'set-up') && (
        <p>Claude Code and Codex ask you to sign in to AgentUse once, the first time you use it.</p>
      )}
      {failed && <p class="no-agents-error" role="alert">{failed}</p>}
    </>
  );
}
