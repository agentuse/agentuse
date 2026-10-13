import { useEffect, useState } from 'preact/hooks';
import type { AgentMcpServer } from '../lib/api';
import { fetchAgentMcpServers, logoutAgentMcpServer, startAgentMcpLogin } from '../lib/api';
import { useFetch } from '../hooks/use-fetch';
import { errorText } from '../lib/format';
import { BusyButton } from './busy-button';

const AUTH_LABEL: Record<AgentMcpServer['auth'], string> = {
  'none': 'No login',
  'token': 'Token',
  'needs-token': 'Needs a token',
  'logged-in': 'Logged in',
  'needs-login': 'Needs login',
};

/**
 * The agent's MCP servers and their logins. Shown only when a server has a
 * login to manage or is refusing the agent, so plain setups stay quiet.
 * "Log in" opens the authorization page in the system browser (the desktop
 * app routes new windows there); the page re-checks while a login is open.
 */
export function McpServersPanel(props: { project: string; runPath: string }) {
  const [waiting, setWaiting] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const { data, refetch } = useFetch(
    `agent-mcp:${props.project}:${props.runPath}`,
    () => fetchAgentMcpServers(props.project, props.runPath),
    waiting ? { refreshMs: 2_000 } : {},
  );
  const servers = data?.servers ?? [];

  // Stop polling once nothing is waiting on a browser login any more.
  useEffect(() => {
    if (waiting && !servers.some((s) => s.auth === 'needs-login')) setWaiting(false);
  }, [waiting, servers]);
  useEffect(() => {
    if (!waiting) return;
    const stop = setTimeout(() => setWaiting(false), 5 * 60_000);
    return () => clearTimeout(stop);
  }, [waiting]);

  if (!servers.some((s) => s.auth === 'logged-in' || s.auth === 'needs-login' || s.auth === 'needs-token')) return null;

  const logIn = async (server: string) => {
    setError(null);
    setBusy(server);
    // Open the tab inside the click so a browser does not block it. The
    // desktop app refuses the blank window and opens the real URL instead.
    const tab = window.open('', '_blank');
    try {
      const { authorizationUrl } = await startAgentMcpLogin(props.project, props.runPath, server);
      if (tab) tab.location.href = authorizationUrl;
      else window.open(authorizationUrl, '_blank');
      setWaiting(true);
    } catch (err) {
      tab?.close();
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const logOut = async (server: string) => {
    setError(null);
    setBusy(server);
    try {
      await logoutAgentMcpServer(props.project, props.runPath, server);
      refetch();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(null);
    }
  };

  const needsLogin = servers.filter((s) => s.auth === 'needs-login').map((s) => s.name);

  return (
    <section class="mcp-panel" aria-label="MCP servers">
      <h2 class="mcp-title">MCP servers</h2>
      {needsLogin.length > 0 && (
        <p class="mcp-warn">
          This agent can't use {needsLogin.join(' or ')} until you log in.
          {waiting && ' Finish in your browser, then come back here.'}
        </p>
      )}
      <ul class="mcp-list">
        {servers.map((s) => (
          <li key={s.name} class="mcp-row">
            <div class="mcp-name">
              <strong>{s.name}</strong>
              <span>
                {s.host ?? 'local command'}
                {s.sharedWith ? ` · shared with ${s.sharedWith} other agent${s.sharedWith === 1 ? '' : 's'}` : ''}
              </span>
            </div>
            <span class={`mcp-state is-${s.auth}`}>{AUTH_LABEL[s.auth]}</span>
            {s.auth === 'needs-login' && (
              <BusyButton class="run-cta-alt" busy={busy === s.name} label="Log in" busyLabel="Opening…" onClick={() => void logIn(s.name)} />
            )}
            {s.auth === 'logged-in' && (
              <BusyButton class="run-cta-alt" busy={busy === s.name} label="Log out" onClick={() => void logOut(s.name)} />
            )}
          </li>
        ))}
      </ul>
      {error && <p class="mcp-error" role="alert">{error}</p>}
    </section>
  );
}
