import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { ThemeToggle } from './theme-toggle';
import { openAgentPalette } from './agent-palette';
import { useFetch } from '../hooks/use-fetch';
import { fetchApprovals } from '../lib/api';
import { WORDMARK_SVG } from '../../brand';
import { brandName, hasCustomBrand } from '../lib/brand';
import { useSessionListView } from '../hooks/use-session-list-view';

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
      class="icon-btn header-refresh"
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

/** Gear button that opens a small popover of app settings (theme + a
 *  clear-cache-and-reload recovery action for stale installed PWAs). */
function SettingsMenu() {
  const [open, setOpen] = useState(false);
  const [clearing, setClearing] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  const sessionList = useSessionListView();

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

  // Purge the service worker's Cache Storage, then reload. The reliable recovery
  // path for an installed iOS PWA that keeps serving a stale build even across a
  // normal reload. Push subscriptions live on the SW registration (not in Cache
  // Storage), so notifications survive.
  const clearCacheAndReload = async () => {
    if (clearing) return;
    setClearing(true);
    try {
      if ('caches' in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if ('serviceWorker' in navigator) {
        const reg = await navigator.serviceWorker.getRegistration();
        if (reg) await reg.update();
      }
    } catch {
      // best-effort — reload regardless
    }
    location.reload();
  };

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
          <div class="settings-section-label">Session list</div>
          <span class="session-view-toggle" role="group" aria-label="Session list view">
            <button
              type="button"
              aria-pressed={sessionList.view === 'summary'}
              onClick={() => sessionList.setView('summary')}
            >Summary</button>
            <button
              type="button"
              aria-pressed={sessionList.view === 'feed'}
              onClick={() => sessionList.setView('feed')}
            >Feed</button>
          </span>
          <div class="settings-section-label">Maintenance</div>
          <button
            type="button"
            class="settings-item settings-reload-item"
            role="menuitem"
            onClick={() => location.reload()}
          >
            Reload app
          </button>
          <button
            type="button"
            class={`settings-item${clearing ? ' btn-busy' : ''}`}
            role="menuitem"
            onClick={clearCacheAndReload}
            disabled={clearing}
            aria-busy={clearing}
            title="Clear the cached app and reload the latest build"
          >
            {clearing ? <><span class="btn-spinner" aria-hidden="true" />Clearing…</> : 'Clear cache & reload'}
          </button>
        </div>
      )}
    </div>
  );
}

export type TopbarPage = 'home' | 'agents' | 'sessions' | 'schedules' | 'stores' | 'approvals';

export function Topbar(props: { currentPage?: TopbarPage; right?: ComponentChildren }) {
  const navWrapRef = useRef<HTMLDivElement>(null);
  const activeNavRef = useRef<HTMLAnchorElement>(null);
  const [navEdges, setNavEdges] = useState({ left: false, right: false });

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

  // Keep the current destination visible on narrow screens and expose overflow
  // cues only on edges that actually have more navigation available.
  useEffect(() => {
    const wrap = navWrapRef.current;
    if (!wrap) return;

    const updateEdges = () => {
      const maxScroll = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
      const next = {
        left: wrap.scrollLeft > 2,
        right: wrap.scrollLeft < maxScroll - 2,
      };
      setNavEdges((current) => (
        current.left === next.left && current.right === next.right ? current : next
      ));
    };

    const revealActive = () => {
      const active = activeNavRef.current;
      if (active && window.matchMedia('(max-width: 640px)').matches) {
        const target = active.offsetLeft - (wrap.clientWidth - active.offsetWidth) / 2;
        wrap.scrollTo({ left: Math.max(0, target), behavior: 'auto' });
      }
      updateEdges();
    };

    const frame = requestAnimationFrame(revealActive);
    wrap.addEventListener('scroll', updateEdges, { passive: true });
    window.addEventListener('resize', revealActive);

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(revealActive);
    observer?.observe(wrap);
    if (wrap.firstElementChild) observer?.observe(wrap.firstElementChild);

    return () => {
      cancelAnimationFrame(frame);
      wrap.removeEventListener('scroll', updateEdges);
      window.removeEventListener('resize', revealActive);
      observer?.disconnect();
    };
  }, [props.currentPage, pending]);

  const navItem = (page: TopbarPage, label: string) => {
    const active = props.currentPage === page;
    const badge = page === 'approvals' && pending > 0 ? pending : null;
    const href = page === 'home' ? '/' : `/${page}`;
    return (
      <a
        class={`nav-item${active ? ' active' : ''}`}
        href={href}
        aria-current={active ? 'page' : undefined}
        ref={(element) => {
          if (active) activeNavRef.current = element;
        }}
      >
        {label}
        {badge !== null && (
          <span class="nav-badge" aria-label={`${badge} pending`}>{badge > 99 ? '99+' : badge}</span>
        )}
      </a>
    );
  };
  // Keyboard/screen-reader users can jump past the nav straight to the page
  // body. main is not focusable by default, so give it tabindex=-1 on demand.
  const skipToContent = (event: Event) => {
    event.preventDefault();
    const main = document.querySelector('main');
    if (!main) return;
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    (main as HTMLElement).focus();
  };

  return (
    <header class="topbar">
      <a class="skip-link" href="#" onClick={skipToContent}>Skip to content</a>
      <a class="brand" href="/" aria-label={`${brandName()} home`}>
        {hasCustomBrand() && (
          <>
            <span class="brand-name">{brandName()}</span>
            <span class="brand-sep" aria-hidden="true">·</span>
          </>
        )}
        <span class="brand-wordmark" dangerouslySetInnerHTML={{ __html: WORDMARK_SVG }} />
      </a>

      <div
        class={`nav-wrap${navEdges.left ? ' has-overflow-left' : ''}${navEdges.right ? ' has-overflow-right' : ''}`}
        ref={navWrapRef}
      >
        <nav class="nav" aria-label="AgentUse serve">
          {navItem('home', 'home')}
          {navItem('agents', 'agents')}
          {navItem('sessions', 'sessions')}
          {navItem('schedules', 'schedules')}
          {navItem('stores', 'stores')}
          {navItem('approvals', 'approvals')}
        </nav>
      </div>
      <div class="right">
        {props.right && <span class="topbar-context">{props.right}</span>}
        <PaletteButton />
        <RefreshButton />
        <SettingsMenu />
      </div>
    </header>
  );
}
