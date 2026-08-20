import { useEffect, useRef, useState } from 'preact/hooks';
import { useRunAgent } from '../hooks/use-run-agent';
import { agentDetailHref } from '../lib/links';
import { RunInstructionDialog } from './run-instruction-dialog';

/**
 * ⋯ overflow menu in the session bar. Holds actions about the agent behind the
 * session rather than the session itself — "Go to agent" (its detail hub),
 * "Run new session" (a fresh detached run of the same agent, navigating to its
 * live view) and the same run with a one-off instruction appended. Mirrors the
 * agents-page menu pattern: a position:fixed popover that closes on outside
 * click, Escape, scroll, or resize.
 *
 * The diagnostic subpage is reached from the context table in the header, not
 * from here: it is about this run, not about the agent.
 */
export function SessionMenu(props: {
  agentName: string;
  agentFilePath: string;
  /** Scope-relative agent path; absent when the agent has no detail hub. */
  agentRunPath?: string;
  projectId?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  const [runOpen, setRunOpen] = useState(false);
  const { run, busy, error } = useRunAgent(props.agentFilePath, props.projectId);

  useEffect(() => {
    if (!pos) return;
    const close = () => setPos(null);
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      close();
    };
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') close(); };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', close, true);
    window.addEventListener('resize', close);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', close, true);
      window.removeEventListener('resize', close);
    };
  }, [pos]);

  const toggle = (e: Event) => {
    e.preventDefault();
    e.stopPropagation();
    if (pos) { setPos(null); return; }
    const r = btnRef.current!.getBoundingClientRect();
    setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };

  return (
    <div class="session-menu">
      <button
        type="button"
        ref={btnRef}
        // icon-btn opts out of the page's broad `button` styling (see the
        // .page-approval-detail button rule in app.css); menu-btn re-skins it.
        class={pos ? 'icon-btn menu-btn open' : 'icon-btn menu-btn'}
        aria-haspopup="menu"
        aria-expanded={pos ? 'true' : 'false'}
        aria-label="Session actions"
        title="Session actions"
        onClick={toggle}
      >
        <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
          <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
        </svg>
      </button>
      {pos && (
        <div ref={popRef} class="menu-popover" role="menu" style={{ top: `${pos.top}px`, right: `${pos.right}px` }}>
          <div class="menu-name">{props.agentName}</div>
          <div class="menu-sep" />
          {props.agentRunPath && props.projectId && (
            <a
              class="menu-item"
              role="menuitem"
              href={agentDetailHref(props.projectId, props.agentRunPath)}
              title="Open this agent's detail page"
              onClick={() => setPos(null)}
            >
              <svg class="menu-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
                <path d="M3.5 2.5h6l3 3v8h-9z" /><path d="M5.75 8.5h4.5" /><path d="M5.75 11h4.5" />
              </svg>
              <span>Go to agent</span>
            </a>
          )}
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
            title="Start a fresh run with a one-off instruction appended to the agent's prompt"
            onClick={(e) => { e.preventDefault(); e.stopPropagation(); setPos(null); setRunOpen(true); }}
          >
            <svg class="menu-icon" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
              <path d="M3 4.5 6.5 8 3 11.5" /><path d="M8.5 11.5H13" />
            </svg>
            <span>Run new session with custom instruction</span>
          </button>
          {error && !runOpen && <p class="menu-error" role="alert">{error}</p>}
        </div>
      )}
      <RunInstructionDialog
        open={runOpen}
        agentName={props.agentName}
        busy={busy}
        error={error}
        onSubmit={(instruction) => { void run(instruction); }}
        onClose={() => { if (!busy) setRunOpen(false); }}
      />
    </div>
  );
}
