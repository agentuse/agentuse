import { useState } from 'preact/hooks';
import { useFetch } from '../hooks/use-fetch';
import { fetchCloudState } from '../lib/api';
import { CodingAgentList, useCodingAgents } from './coding-agent-list';
import { SettingsGroup as Group } from './settings-layout';

export function CopyField(props: { value: string }) {
  const [copied, setCopied] = useState(false);
  const copy = () => {
    void navigator.clipboard?.writeText(props.value).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    }, () => { /* the value stays visible to copy by hand */ });
  };
  return (
    <div class="no-agents-copy">
      <code>{props.value}</code>
      <button type="button" onClick={copy}>{copied ? 'Copied' : 'Copy'}</button>
    </div>
  );
}

/**
 * Settings › Connect apps: every way into AgentUse in one place. Coding agents
 * on this computer are set up with a button and always use the local address.
 * With AgentUse Cloud turned on, chat apps on the web reach this computer
 * through it. Other apps on this computer get the local address to paste.
 */
export function ConnectAppsSettingsGroup() {
  const agents = useCodingAgents();
  const cloud = useFetch('settings-cloud', () => fetchCloudState());
  const isDesktop = typeof window !== 'undefined' && Boolean(window.agentuseDesktop);
  const mcpUrl = cloud.data?.mcpUrl;
  const localUrl = `${location.origin}/mcp`;

  return (
    <div class="connect-apps">
      {!agents.error && (
        <Group title="Claude Code and Codex">
          <p class="settings-group-hint">Set up once, then say “Use AgentUse to…” in either one. Works in their apps and in the terminal. {agents.via === 'cloud' ? 'They use AgentUse Cloud, like your chat apps.' : 'They use this Mac directly.'}</p>
          <CodingAgentList agents={agents} />
        </Group>
      )}

      {cloud.data?.enabled && <Group title="Claude, ChatGPT and other chat apps">
        {mcpUrl
          ? <>
              <p class="settings-group-hint">
                They reach this machine through AgentUse Cloud{cloud.data?.account ? `, signed in as ${cloud.data.account}` : ''}. Add this address as a connector, sign in, then ask it to automate something.
              </p>
              <CopyField value={mcpUrl} />
            </>
          : <>
              <p class="settings-group-hint">They reach this machine through AgentUse Cloud, which isn't connected yet.</p>
              {isDesktop
                ? <div><button type="button" class="settings-item" onClick={() => void window.agentuseDesktop?.openSettings()}>Connect in Mac Settings…</button></div>
                : <p class="settings-group-hint">Run <code>agentuse setup</code> on this machine to connect it.</p>}
            </>}
      </Group>}

      {!agents.error && (
        <Group title="Another app on this Mac">
          <p class="settings-group-hint">Cursor, Windsurf or any app that supports MCP: add this address to it.</p>
          <CopyField value={localUrl} />
        </Group>
      )}
    </div>
  );
}
