import { useState } from 'preact/hooks';
import { useFetch } from '../hooks/use-fetch';
import { fetchCloudState } from '../lib/api';
import { CodingAgentList, useCodingAgents } from './coding-agent-list';
import { SettingsGroup as Group } from './settings-layout';

function CopyField(props: { value: string }) {
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
 * Chat apps on the web reach this computer through AgentUse Cloud. Other apps
 * on this computer get the local address to paste.
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
          <p class="settings-group-hint">Set up once, then type /automate in Claude Code or $automate in Codex. Works in their apps and in the terminal.</p>
          <CodingAgentList agents={agents} />
        </Group>
      )}

      <Group title="Claude, ChatGPT and other chat apps">
        {mcpUrl
          ? <>
              <p class="settings-group-hint">
                They reach this computer through AgentUse Cloud{cloud.data?.account ? `, signed in as ${cloud.data.account}` : ''}. Add this address as a connector, sign in, then ask it to automate something.
              </p>
              <CopyField value={mcpUrl} />
              {!agents.error && <p>Claude Code on this Mac already has AgentUse. If it shows up twice there, turn off the claude.ai one in Claude Code's /mcp.</p>}
            </>
          : <>
              <p class="settings-group-hint">They reach this computer through AgentUse Cloud, which isn't connected yet.</p>
              {isDesktop
                ? <div><button type="button" class="settings-item" onClick={() => void window.agentuseDesktop?.openSettings()}>Connect in Mac Settings…</button></div>
                : <p class="settings-group-hint">Run <code>agentuse setup</code> on this computer to connect it.</p>}
            </>}
      </Group>

      {!agents.error && (
        <Group title="Another app on this Mac">
          <p class="settings-group-hint">Cursor, Windsurf or any app that supports MCP: add this address to it.</p>
          <CopyField value={localUrl} />
        </Group>
      )}
    </div>
  );
}
