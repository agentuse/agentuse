import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import { openAgentPalette } from './agent-palette';
import { useGlobalApprovals } from '../hooks/use-global-approvals';
import { useMediaQuery } from '../hooks/use-media-query';
import { WORDMARK_SVG } from '../../brand';

const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const SIDEBAR_PREF_KEY = 'agentuse-sidebar-collapsed';
const SIDEBAR_WIDTH_PREF_KEY = 'agentuse-sidebar-width';
export const DEFAULT_SIDEBAR_WIDTH = 224;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 360;

export type NavigationPage = 'home' | 'agents' | 'sessions' | 'schedules' | 'stores' | 'approvals';

export function navigationPageForPath(pathname: string): NavigationPage | undefined {
  if (pathname === '/') return 'home';
  if (pathname === '/agents' || pathname.startsWith('/agents/') || pathname.startsWith('/learnings/')) return 'agents';
  if (pathname === '/sessions' || pathname.startsWith('/sessions/')) return 'sessions';
  if (pathname === '/schedules' || pathname.startsWith('/schedules/')) return 'schedules';
  if (pathname === '/stores' || pathname.startsWith('/stores/')) return 'stores';
  if (pathname === '/approvals' || pathname.startsWith('/approvals/')) return 'approvals';
  return undefined;
}

export function clampSidebarWidth(width: number): number {
  return Math.min(MAX_SIDEBAR_WIDTH, Math.max(MIN_SIDEBAR_WIDTH, Math.round(width)));
}

export function isSidebarToggleShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey'>): boolean {
  return !event.altKey && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'b';
}

function readSidebarPreference(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_PREF_KEY) === 'true';
  } catch {
    return false;
  }
}

function writeSidebarPreference(collapsed: boolean): void {
  try {
    localStorage.setItem(SIDEBAR_PREF_KEY, String(collapsed));
  } catch {
    // Restricted browser contexts may deny storage. The current window still works.
  }
}

function readSidebarWidth(): number {
  try {
    const stored = Number(localStorage.getItem(SIDEBAR_WIDTH_PREF_KEY));
    return Number.isFinite(stored) && stored > 0 ? clampSidebarWidth(stored) : DEFAULT_SIDEBAR_WIDTH;
  } catch {
    return DEFAULT_SIDEBAR_WIDTH;
  }
}

function writeSidebarWidth(width: number): void {
  try {
    localStorage.setItem(SIDEBAR_WIDTH_PREF_KEY, String(clampSidebarWidth(width)));
  } catch {
    // Restricted browser contexts may deny storage. The current window still works.
  }
}

function SearchIcon() {
  return (
    <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="7" cy="7" r="4.5" /><path d="m11 11 3 3" />
    </svg>
  );
}

function MenuIcon() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><path d="M3 5.5h14M3 10h14M3 14.5h14" /></svg>;
}

function SidebarIcon() {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.4" aria-hidden="true"><rect x="2.75" y="3" width="14.5" height="14" rx="2" /><path d="M7.25 3v14" /></svg>;
}

function BackIcon({ forward = false }: { forward?: boolean }) {
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d={forward ? 'm8 5 5 5-5 5' : 'm12 5-5 5 5 5'} /></svg>;
}

function SettingsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
      <circle cx="12" cy="12" r="3" />
      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09A1.65 1.65 0 0 0 19.4 15z" />
    </svg>
  );
}

function NavIcon({ page }: { page: NavigationPage }) {
  if (page === 'home') return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="m3 9 7-6 7 6v8H6V9" /></svg>;
  if (page === 'agents') return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="14" height="11" rx="3" /><path d="M10 2v3M7 10h.01M13 10h.01M7 13h6" /></svg>;
  if (page === 'sessions') return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round" aria-hidden="true"><path d="M3 4.5h14v10H8l-4 3v-3H3z" /></svg>;
  if (page === 'schedules') return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" aria-hidden="true"><rect x="3" y="4" width="14" height="13" rx="2" /><path d="M6 2.5V6M14 2.5V6M3 8h14M10 11v3l2 1" /></svg>;
  if (page === 'stores') return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" aria-hidden="true"><ellipse cx="10" cy="5" rx="6.5" ry="2.5" /><path d="M3.5 5v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5V5M3.5 10v5c0 1.4 2.9 2.5 6.5 2.5s6.5-1.1 6.5-2.5v-5" /></svg>;
  return <svg viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><circle cx="10" cy="10" r="7" /><path d="m7 10 2 2 4-4" /></svg>;
}

function navHref(page: NavigationPage): string {
  return page === 'home' ? '/' : `/${page}`;
}

export function AppShell({ children }: { children: ComponentChildren }) {
  const location = useLocation();
  const pathname = new URL(location.url, 'https://agentuse.local').pathname;
  const currentPage = navigationPageForPath(pathname);
  const isDesktop = typeof window !== 'undefined' && Boolean(window.agentuseDesktop);
  const isMobile = useMediaQuery('(max-width: 720px)');
  const approvals = useGlobalApprovals();
  const pending = approvals.data?.buckets.pending.length ?? 0;
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(readSidebarPreference);
  const [sidebarWidth, setSidebarWidth] = useState(readSidebarWidth);
  const [navigationState, setNavigationState] = useState({ canGoBack: false, canGoForward: false });
  const drawerRef = useRef<HTMLElement>(null);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const resizeCleanupRef = useRef<(() => void) | null>(null);

  const toggleSidebar = () => {
    setSidebarCollapsed((current) => {
      const next = !current;
      writeSidebarPreference(next);
      return next;
    });
  };

  useEffect(() => () => resizeCleanupRef.current?.(), []);

  useEffect(() => {
    if (isMobile) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (!isSidebarToggleShortcut(event)) return;
      event.preventDefault();
      toggleSidebar();
    };
    const onNativeToggle = () => toggleSidebar();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('agentuse:toggle-sidebar', onNativeToggle);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('agentuse:toggle-sidebar', onNativeToggle);
    };
  }, [isMobile]);

  useEffect(() => {
    if (drawerOpen) {
      requestAnimationFrame(() => {
        const main = document.querySelector<HTMLElement>('main');
        if (!main) return;
        if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
        main.focus({ preventScroll: true });
      });
    }
    setDrawerOpen(false);
  }, [location.url]);

  useEffect(() => {
    if (!drawerOpen) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const drawer = drawerRef.current;
    const focusable = () => Array.from(drawer?.querySelectorAll<HTMLElement>('a[href], button:not(:disabled)') ?? []);
    drawer?.focus({ preventScroll: true });
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setDrawerOpen(false);
        menuButtonRef.current?.focus();
        return;
      }
      if (event.key !== 'Tab') return;
      const items = focusable();
      if (items.length === 0) return;
      const first = items[0];
      const last = items[items.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => {
      document.body.style.overflow = previousOverflow;
      document.removeEventListener('keydown', onKeyDown);
    };
  }, [drawerOpen]);

  useEffect(() => {
    if (!isDesktop || !window.agentuseDesktop?.getNavigationState) return;
    let active = true;
    void window.agentuseDesktop.getNavigationState().then((state) => {
      if (active) setNavigationState(state);
    });
    const unsubscribe = window.agentuseDesktop.onNavigationStateChange?.((state) => setNavigationState(state));
    return () => {
      active = false;
      unsubscribe?.();
    };
  }, [isDesktop]);

  const closeDrawer = (restoreMenuFocus = false) => {
    setDrawerOpen(false);
    if (restoreMenuFocus) requestAnimationFrame(() => menuButtonRef.current?.focus());
  };

  const startSidebarResize = (event: PointerEvent) => {
    if (isMobile || sidebarCollapsed) return;
    event.preventDefault();
    resizeCleanupRef.current?.();
    let nextWidth = sidebarWidth;
    const onMove = (moveEvent: PointerEvent) => {
      nextWidth = clampSidebarWidth(moveEvent.clientX);
      setSidebarWidth(nextWidth);
    };
    const cleanup = () => {
      document.removeEventListener('pointermove', onMove);
      document.removeEventListener('pointerup', finish);
      document.removeEventListener('pointercancel', finish);
      document.documentElement.classList.remove('is-resizing-sidebar');
      resizeCleanupRef.current = null;
    };
    const finish = () => {
      writeSidebarWidth(nextWidth);
      cleanup();
    };
    resizeCleanupRef.current = cleanup;
    document.documentElement.classList.add('is-resizing-sidebar');
    document.addEventListener('pointermove', onMove);
    document.addEventListener('pointerup', finish);
    document.addEventListener('pointercancel', finish);
  };

  const resizeSidebarWithKeyboard = (event: KeyboardEvent) => {
    let nextWidth: number | undefined;
    if (event.key === 'ArrowLeft') nextWidth = sidebarWidth - 12;
    if (event.key === 'ArrowRight') nextWidth = sidebarWidth + 12;
    if (event.key === 'Home') nextWidth = MIN_SIDEBAR_WIDTH;
    if (event.key === 'End') nextWidth = MAX_SIDEBAR_WIDTH;
    if (nextWidth === undefined) return;
    event.preventDefault();
    const clamped = clampSidebarWidth(nextWidth);
    setSidebarWidth(clamped);
    writeSidebarWidth(clamped);
  };

  const resetSidebarWidth = () => {
    setSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
    writeSidebarWidth(DEFAULT_SIDEBAR_WIDTH);
  };

  const skipToContent = (event: Event) => {
    event.preventDefault();
    const main = document.querySelector('main');
    if (!main) return;
    if (!main.hasAttribute('tabindex')) main.setAttribute('tabindex', '-1');
    (main as HTMLElement).focus();
  };

  const navItem = (page: NavigationPage, label: string) => {
    const active = currentPage === page;
    const badge = page === 'approvals' && pending > 0 ? pending : null;
    return (
      <a class={`sidebar-nav-item${active ? ' active' : ''}`} href={navHref(page)} aria-current={active ? 'page' : undefined}>
        <NavIcon page={page} />
        <span>{label}</span>
        {badge !== null && <span class="nav-badge" aria-label={`${badge} pending`}>{badge > 99 ? '99+' : badge}</span>}
      </a>
    );
  };

  return (
    <div
      class="app-shell"
      data-desktop={isDesktop ? 'true' : 'false'}
      data-sidebar-collapsed={sidebarCollapsed ? 'true' : 'false'}
      data-drawer-open={drawerOpen ? 'true' : 'false'}
      style={{ '--app-sidebar-width': `${sidebarWidth}px` }}
    >
      <a class="skip-link" href="#" onClick={skipToContent}>Skip to content</a>
      <header class="topbar app-toolbar">
        {isDesktop ? (
          <>
            <button type="button" class="toolbar-button sidebar-toggle" aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-keyshortcuts="Meta+B Control+B" aria-expanded={!sidebarCollapsed} title="Toggle sidebar (⌘B)" onClick={toggleSidebar}><SidebarIcon /></button>
            <button type="button" class="toolbar-button" aria-label="Back" disabled={!navigationState.canGoBack} onClick={() => window.agentuseDesktop?.goBack?.()}><BackIcon /></button>
            <button type="button" class="toolbar-button" aria-label="Forward" disabled={!navigationState.canGoForward} onClick={() => window.agentuseDesktop?.goForward?.()}><BackIcon forward /></button>
            <span class="toolbar-drag-region" aria-hidden="true" />
          </>
        ) : (
          <>
            <button
              ref={menuButtonRef}
              type="button"
              class="toolbar-button mobile-menu-button"
              aria-label={drawerOpen ? 'Close navigation' : 'Open navigation'}
              aria-expanded={drawerOpen}
              aria-controls="app-sidebar"
              onClick={() => setDrawerOpen((open) => !open)}
            ><MenuIcon /></button>
            <a class="mobile-brand" href="/" aria-label="AgentUse home"><span class="brand-wordmark" dangerouslySetInnerHTML={{ __html: WORDMARK_SVG }} /></a>
          </>
        )}
      </header>

      <button type="button" class={`sidebar-scrim${drawerOpen ? ' is-open' : ''}`} aria-label="Close navigation" onClick={() => closeDrawer(true)} />
      <aside
        ref={drawerRef}
        id="app-sidebar"
        class={`app-sidebar${drawerOpen ? ' is-open' : ''}`}
        aria-label="Primary navigation"
        tabIndex={-1}
        aria-hidden={(isMobile && !drawerOpen) || (!isMobile && isDesktop && sidebarCollapsed) ? 'true' : undefined}
        inert={(isMobile && !drawerOpen) || (!isMobile && isDesktop && sidebarCollapsed)}
      >
        <div class="sidebar-brand-row">
          <a class="sidebar-brand" href="/" aria-label="AgentUse home">
            <span class="brand-wordmark" dangerouslySetInnerHTML={{ __html: WORDMARK_SVG }} />
          </a>
        </div>
        <nav class="sidebar-nav" aria-label="AgentUse">
          {navItem('home', 'home')}
          {navItem('agents', 'agents')}
          {navItem('sessions', 'sessions')}
          <span class="sidebar-divider" aria-hidden="true" />
          {navItem('schedules', 'schedules')}
          {navItem('stores', 'stores')}
          {navItem('approvals', 'approvals')}
        </nav>
        <div class="sidebar-footer">
          <button type="button" class="palette-trigger sidebar-palette-trigger" aria-label="Go to agent" title={`Go to agent (${IS_APPLE ? '⌘' : 'Ctrl+'}K)`} onClick={() => openAgentPalette()}>
            <SearchIcon /><span class="palette-trigger-label">Go to agent</span><kbd class="palette-trigger-kbd">{IS_APPLE ? '⌘' : 'Ctrl'}K</kbd>
          </button>
          <a class={`sidebar-nav-item${pathname === '/settings' ? ' active' : ''}`} href="/settings" aria-current={pathname === '/settings' ? 'page' : undefined}>
            <SettingsIcon /><span>settings</span>
          </a>
        </div>
        <button
          type="button"
          class="sidebar-resize-handle"
          role="separator"
          aria-label="Resize sidebar"
          aria-controls="app-sidebar"
          aria-orientation="vertical"
          aria-valuemin={MIN_SIDEBAR_WIDTH}
          aria-valuemax={MAX_SIDEBAR_WIDTH}
          aria-valuenow={sidebarWidth}
          title="Drag to resize · double-click to reset"
          onPointerDown={startSidebarResize}
          onKeyDown={resizeSidebarWithKeyboard}
          onDblClick={resetSidebarWidth}
        />
      </aside>

      <div class="app-route">{children}</div>
    </div>
  );
}
