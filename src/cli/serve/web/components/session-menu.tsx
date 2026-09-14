import { useState } from 'preact/hooks';
import type { ComponentChildren } from 'preact';
import { useRunAgent } from '../hooks/use-run-agent';
import { agentDetailHref } from '../lib/links';
import { RunCustomDialog } from './run-custom-dialog';
import { MenuPopover } from './menu-popover';

/**
 * ⋯ overflow menu in the session bar. Holds actions about the agent behind the
 * session rather than the session itself — "Go to agent" (its detail hub),
 * "Run new session" (a fresh detached run of the same agent, navigating to its
 * live view) and the same run with a one-off instruction and/or a different
 * model. Mirrors the
 * agents-page menu pattern: a position:fixed popover that closes on outside
 * click, Escape, scroll, or resize.
 *
 * The diagnostic subpage is reached from the context table in the header, not
 * from here: it is about this run, not about the agent.
 */
/** An action on this run (not the agent) that the page parks in the menu
 *  while the decision card needs the foot of the page to itself. */
export type SessionMenuRunAction = {
  label: string;
  title?: string;
  icon: 'edit' | 'stop' | 'retry' | 'resume';
  disabled?: boolean;
  busy?: boolean;
  onSelect: () => void;
};

function RunActionIcon(props: { icon: SessionMenuRunAction['icon'] }): ComponentChildren {
  if (props.icon === 'retry' || props.icon === 'resume') {
    return (
      <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 4v5h-5" />
      </svg>
    );
  }
  return props.icon === 'edit'
    ? (
      <svg class="menu-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M12 20h9" /><path d="M16.5 3.5a2.1 2.1 0 0 1 3 3L8 18l-4 1 1-4Z" />
      </svg>
    )
    : (
      <svg class="menu-icon menu-icon-stop" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <rect x="6" y="6" width="12" height="12" rx="2" />
      </svg>
    );
}

export function SessionMenu(props: {
  agentName: string;
  /** Scope-relative path of a currently loaded project agent. */
  agentRunPath: string;
  projectId: string;
  /** Run-level actions listed after the agent actions, under their own rule. */
  runActions?: SessionMenuRunAction[];
}) {
  const [runOpen, setRunOpen] = useState(false);
  const { run, busy, error } = useRunAgent(props.agentRunPath, props.projectId);

  return (
    <>
      <MenuPopover
        wrapClass="session-menu"
        label="Session actions"
        title="Session actions"
        // icon-btn opts out of the page's broad `button` styling (see the
        // .page-approval-detail button rule in app.css); menu-btn re-skins it.
        triggerClass={(open) => (open ? 'icon-btn menu-btn open' : 'icon-btn menu-btn')}
      >
        {(close) => (
          <>
          <div class="menu-name">{props.agentName}</div>
          <div class="menu-sep" />
          <a
            class="menu-item"
            role="menuitem"
            href={agentDetailHref(props.projectId, props.agentRunPath)}
            title="Open this agent's detail page"
            onClick={() => close()}
          >
            <svg class="menu-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3.5 2.5h6l3 3v8h-9z" /><path d="M5.75 8.5h4.5" /><path d="M5.75 11h4.5" />
            </svg>
            <span>Go to agent</span>
          </a>
          <button
            type="button"
            class="menu-item"
            role="menuitem"
            disabled={busy}
            aria-busy={busy}
            title="Start a fresh run of this agent and open its live session"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); void run(); }}
          >
            {busy ? (
              <span class="btn-spinner" aria-hidden="true" />
            ) : (
              <svg class="menu-icon" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                <path d="M5 3.5v9a.75.75 0 0 0 1.14.64l7.25-4.5a.75.75 0 0 0 0-1.28l-7.25-4.5A.75.75 0 0 0 5 3.5Z" />
              </svg>
            )}
            <span>{busy ? 'Starting…' : 'Run new session'}</span>
          </button>
          <button
            type="button"
            class="menu-item"
            role="menuitem"
            disabled={busy}
            title="Start a fresh run with a one-off instruction, a different model, or both"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); close(); setRunOpen(true); }}
          >
            <svg class="menu-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 4.5 6.5 8 3 11.5" /><path d="M8.5 11.5H13" />
            </svg>
            <span>Run new session with custom…</span>
          </button>
            {error && !runOpen && <p class="menu-error" role="alert">{error}</p>}
            {props.runActions && props.runActions.length > 0 && (
              <>
                <div class="menu-sep" />
                {props.runActions.map((action) => (
                  <button
                    key={action.label}
                    type="button"
                    class="menu-item"
                    role="menuitem"
                    disabled={action.disabled || action.busy}
                    aria-busy={action.busy}
                    {...(action.title ? { title: action.title } : {})}
                    onClick={(e) => { e.preventDefault(); e.stopPropagation(); close(); action.onSelect(); }}
                  >
                    {action.busy ? <span class="btn-spinner" aria-hidden="true" /> : <RunActionIcon icon={action.icon} />}
                    <span>{action.label}</span>
                  </button>
                ))}
              </>
            )}
          </>
        )}
      </MenuPopover>
      <RunCustomDialog
        open={runOpen}
        agentName={props.agentName}
        busy={busy}
        error={error}
        onSubmit={(custom) => { void run(custom); }}
        onClose={() => { if (!busy) setRunOpen(false); }}
      />
    </>
  );
}
