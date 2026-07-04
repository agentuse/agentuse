import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ThemeToggle } from './theme-toggle';
import { openAgentPalette } from './agent-palette';
import { useFetch } from '../hooks/use-fetch';
import { fetchApprovals } from '../lib/api';
import { WORDMARK_SVG } from '../../brand';

const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);

/** Tappable entry to the agent palette — the only way in on touch devices (no ⌘K). */
function PaletteButton() {
  return (
    <button
      type="button"
      class="palette-trigger"
      aria-label="Go to agent"
      title={`Go to agent (${IS_APPLE ? '⌘' : 'Ctrl+'}K)`}
      onClick={() => openAgentPalette()}
    >
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="7" cy="7" r="4.5" /><path d="m11 11 3 3" />
      </svg>
      <span class="palette-trigger-label">Go to agent</span>
      <kbd class="palette-trigger-kbd">{IS_APPLE ? '⌘' : 'Ctrl'}K</kbd>
    </button>
  );
}

/**
 * Full-reload button. In an installed PWA (standalone, no browser chrome) this
 * is the only reliable way to pick up a new build: location.reload() does a
 * real navigation, which the service worker serves network-first, pulling the
 * latest shell + hashed assets.
 */
function RefreshButton() {
  return (
    <button
      type="button"
      class="icon-btn"
      aria-label="Reload"
      title="Reload the app"
      onClick={() => location.reload()}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <path d="M21 12a9 9 0 1 1-2.64-6.36" />
        <polyline points="21 3 21 9 15 9" />
      </svg>
    </button>
  );
}

/** Gear button that opens a small popover of app settings (currently theme). */
function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointer = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) setOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setOpen(false);
    };
    document.addEventListener('mousedown', onPointer);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointer);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  return (
    <div class="settings-menu" ref={ref}>
      <button
        type="button"
        class="icon-btn"
        aria-label="Settings"
        title="Settings"
        aria-haspopup="true"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
      >
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      </button>
      {open && (
        <div class="settings-popover" role="menu">
          <div class="settings-section-label">Theme</div>
          <ThemeToggle />
        </div>
      )}
    </div>
  );
}

export type TopbarPage = 'agents' | 'sessions' | 'schedules' | 'stores' | 'approvals';

export function Topbar(props: { currentPage?: TopbarPage; right?: ComponentChildren }) {
  // Pending-approvals count for the approvals tab badge, visible on every page.
  // A capability-scoped session view (?token=) has no operator access to the
  // approvals endpoint, so skip the poll there — it would only 401.
  const scoped = typeof location !== 'undefined' && new URLSearchParams(location.search).has('token');
  const approvals = useFetch(
    'topbar-approvals',
    () => (scoped ? Promise.resolve(null) : fetchApprovals()),
    scoped ? {} : { refreshMs: 30_000 }
  );
  const pending = approvals.data?.buckets.pending.length ?? 0;

  const navItem = (page: TopbarPage, label: string) => {
    const active = props.currentPage === page;
    const badge = page === 'approvals' && pending > 0 ? pending : null;
    return (
      <a
        class={`nav-item${active ? ' active' : ''}`}
        href={`/${page}`}
        aria-current={active ? 'page' : undefined}
      >
        {label}
        {badge !== null && (
          <span class="nav-badge" aria-label={`${badge} pending`}>{badge > 99 ? '99+' : badge}</span>
        )}
      </a>
    );
  };
  return (
    <div class="topbar">
      <a
        class="brand"
        href="/"
        aria-label="AgentUse home"
        dangerouslySetInnerHTML={{ __html: WORDMARK_SVG }}
      />

      <span class="nav-wrap">
        <span class="nav" role="navigation" aria-label="AgentUse serve">
          {navItem('agents', 'agents')}
          {navItem('sessions', 'sessions')}
          {navItem('schedules', 'schedules')}
          {navItem('stores', 'stores')}
          {navItem('approvals', 'approvals')}
        </span>
      </span>
      <span class="right">
        {props.right}
        <PaletteButton />
        <RefreshButton />
        <SettingsMenu />
      </span>
    </div>
  );
}
