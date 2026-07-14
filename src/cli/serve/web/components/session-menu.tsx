import { useEffect, useRef, useState } from 'preact/hooks';
import { useRunAgent } from '../hooks/use-run-agent';

/**
 * ⋯ overflow menu in the session bar. Holds actions about the agent behind the
 * session rather than the session itself — currently "Run new session", which
 * kicks off a fresh detached run of the same agent and navigates to its live
 * view. Mirrors the agents-page menu pattern: a position:fixed popover that
 * closes on outside click, Escape, scroll, or resize.
 */
export function SessionMenu(props: {
  agentName: string;
  agentFilePath: string;
  projectId?: string;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
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
          {error && <p class="menu-error" role="alert">{error}</p>}
        </div>
      )}
    </div>
  );
}
