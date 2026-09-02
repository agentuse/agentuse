import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  ArrowLeft,
  ArrowRight,
  Bot,
  CalendarDays,
  CircleCheck,
  Database,
  House,
  Menu,
  MessageSquare,
  PanelLeft,
  Search,
  Settings,
} from 'lucide-preact';
import { openAgentPalette } from './agent-palette';
import { useGlobalApprovals } from '../hooks/use-global-approvals';
import { useMediaQuery } from '../hooks/use-media-query';
import { useShellSessions } from '../hooks/use-shell-sessions';
import { displayAgentName, formatRelativeTime, isRunningStatus, runTone } from '../lib/format';
import { WORDMARK_SVG } from '../../brand';

const IS_APPLE = typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.platform);
const SIDEBAR_PREF_KEY = 'agentuse-sidebar-collapsed';
const SIDEBAR_WIDTH_PREF_KEY = 'agentuse-sidebar-width';
export const DEFAULT_SIDEBAR_WIDTH = 224;
export const MIN_SIDEBAR_WIDTH = 180;
export const MAX_SIDEBAR_WIDTH = 360;

export type NavigationPage = 'home' | 'agents' | 'sessions' | 'schedules' | 'stores' | 'approvals';

/** Nav order, and the ⌘1-⌘6 order. The Mac app binds the same list in its Go
 *  menu (apps/desktop/src/menus.ts); web registers the shortcuts itself only
 *  because there is no native menu there. Keep both lists in the same order. */
export const NAVIGATION_ORDER: readonly NavigationPage[] = [
  'home',
  'agents',
  'sessions',
  'schedules',
  'stores',
  'approvals',
];

export function navigationPageForShortcut(event: Pick<KeyboardEvent, 'key' | 'metaKey' | 'ctrlKey' | 'altKey' | 'shiftKey'>): NavigationPage | undefined {
  if (event.altKey || event.shiftKey || !(event.metaKey || event.ctrlKey)) return undefined;
  const index = Number(event.key) - 1;
  return Number.isInteger(index) ? NAVIGATION_ORDER[index] : undefined;
}

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

function NavIcon({ page }: { page: NavigationPage }) {
  if (page === 'home') return <House aria-hidden="true" strokeWidth={1.7} />;
  if (page === 'agents') return <Bot aria-hidden="true" strokeWidth={1.7} />;
  if (page === 'sessions') return <MessageSquare aria-hidden="true" strokeWidth={1.7} />;
  if (page === 'schedules') return <CalendarDays aria-hidden="true" strokeWidth={1.7} />;
  if (page === 'stores') return <Database aria-hidden="true" strokeWidth={1.7} />;
  return <CircleCheck aria-hidden="true" strokeWidth={1.7} />;
}

function sessionHref(session: { sessionId: string; project: string }): string {
  return `/sessions/${encodeURIComponent(session.sessionId)}?project=${encodeURIComponent(session.project)}`;
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
  // Capability-scoped deep links must not open operator-wide streams.
  const scoped = location.query.token !== undefined;
  const shellSessions = useShellSessions(!scoped);
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
      // The Mac app owns ⌘B and ⌘1-⌘6 through its native menus; registering
      // them again in the page would double-fire.
      if (isDesktop) return;
      if (isSidebarToggleShortcut(event)) {
        event.preventDefault();
        toggleSidebar();
        return;
      }
      const page = navigationPageForShortcut(event);
      if (!page) return;
      event.preventDefault();
      location.route(navHref(page));
    };
    const onNativeToggle = () => toggleSidebar();
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('agentuse:toggle-sidebar', onNativeToggle);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('agentuse:toggle-sidebar', onNativeToggle);
    };
  }, [isMobile, isDesktop]);

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
    const running = page === 'sessions' ? shellSessions.running : 0;
    const shortcutIndex = NAVIGATION_ORDER.indexOf(page);
    const shortcut = shortcutIndex >= 0 ? `${IS_APPLE ? '⌘' : 'Ctrl+'}${shortcutIndex + 1}` : undefined;
    return (
      <a
        class={`sidebar-nav-item${active ? ' active' : ''}`}
        href={navHref(page)}
        aria-current={active ? 'page' : undefined}
        title={shortcut ? `${label} (${shortcut})` : label}
        aria-keyshortcuts={shortcut ? `Meta+${shortcutIndex + 1} Control+${shortcutIndex + 1}` : undefined}
      >
        <NavIcon page={page} />
        <span class="sidebar-nav-label">{label}</span>
        {running > 0 && (
          <span class="sidebar-running-count" aria-label={`${running} running`}>
            <span class="sidebar-running-dot" aria-hidden="true" />{running}
          </span>
        )}
        {badge !== null && <span class="nav-badge" aria-label={`${badge} pending`}>{badge > 99 ? '99+' : badge}</span>}
      </a>
    );
  };

  const recentSessions = sidebarCollapsed && !isMobile ? [] : shellSessions.recent;

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
            <button type="button" class="toolbar-button sidebar-toggle" aria-label={sidebarCollapsed ? 'Show sidebar' : 'Hide sidebar'} aria-keyshortcuts="Meta+B Control+B" aria-expanded={!sidebarCollapsed} title="Toggle sidebar (⌘B)" onClick={toggleSidebar}><PanelLeft aria-hidden="true" strokeWidth={1.7} /></button>
            <button type="button" class="toolbar-button" aria-label="Back" disabled={!navigationState.canGoBack} onClick={() => window.agentuseDesktop?.goBack?.()}><ArrowLeft aria-hidden="true" strokeWidth={1.7} /></button>
            <button type="button" class="toolbar-button" aria-label="Forward" disabled={!navigationState.canGoForward} onClick={() => window.agentuseDesktop?.goForward?.()}><ArrowRight aria-hidden="true" strokeWidth={1.7} /></button>
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
            ><Menu aria-hidden="true" strokeWidth={1.7} /></button>
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
        aria-hidden={isMobile && !drawerOpen ? 'true' : undefined}
        inert={isMobile && !drawerOpen}
      >
        <div class="sidebar-brand-row">
          <a class="sidebar-brand" href="/" aria-label="AgentUse home">
            <span class="brand-wordmark" dangerouslySetInnerHTML={{ __html: WORDMARK_SVG }} />
          </a>
          {!isDesktop && !isMobile && (
            <button
              type="button"
              class="toolbar-button sidebar-inline-toggle"
              aria-label={sidebarCollapsed ? 'Expand sidebar' : 'Collapse sidebar'}
              aria-keyshortcuts="Meta+B Control+B"
              aria-expanded={!sidebarCollapsed}
              title={`${sidebarCollapsed ? 'Expand' : 'Collapse'} sidebar (${IS_APPLE ? '⌘' : 'Ctrl+'}B)`}
              onClick={toggleSidebar}
            ><PanelLeft aria-hidden="true" strokeWidth={1.7} /></button>
          )}
        </div>
        <nav class="sidebar-nav" aria-label="AgentUse">
          {navItem('home', 'Home')}
          {navItem('agents', 'Agents')}
          {navItem('sessions', 'Sessions')}
          <span class="sidebar-divider" aria-hidden="true" />
          {navItem('schedules', 'Schedules')}
          {navItem('stores', 'Stores')}
          {navItem('approvals', 'Approvals')}
        </nav>
        {recentSessions.length > 0 && (
          <nav class="sidebar-recent" aria-label="Recent sessions">
            <p class="sidebar-section-label">Recent</p>
            {recentSessions.map((session) => (
              <a
                key={`${session.project}:${session.sessionId}`}
                class={`sidebar-recent-item${pathname === `/sessions/${session.sessionId}` ? ' active' : ''}`}
                href={sessionHref(session)}
                title={`${displayAgentName(session.agent.name, session.agent.filePath, session.agent.id)} · ${session.status}`}
              >
                <span class={`sidebar-recent-dot tone-${runTone(session.status)}`} aria-hidden="true" />
                <span class="sidebar-recent-name">{displayAgentName(session.agent.name, session.agent.filePath, session.agent.id)}</span>
                <span class="sidebar-recent-time">{isRunningStatus(session.status) ? 'now' : formatRelativeTime(session.updatedAt).replace(' ago', '')}</span>
              </a>
            ))}
          </nav>
        )}
        <div class="sidebar-footer">
          <button type="button" class="palette-trigger sidebar-palette-trigger" aria-label="Search" title={`Search (${IS_APPLE ? '⌘' : 'Ctrl+'}K)`} onClick={() => openAgentPalette()}>
            <Search aria-hidden="true" strokeWidth={1.7} /><span class="palette-trigger-label">Search</span><kbd class="palette-trigger-kbd">{IS_APPLE ? '⌘' : 'Ctrl'}K</kbd>
          </button>
          <span class="sidebar-divider" aria-hidden="true" />
          <a class={`sidebar-nav-item${pathname === '/settings' ? ' active' : ''}`} href="/settings" aria-current={pathname === '/settings' ? 'page' : undefined}>
            <Settings aria-hidden="true" strokeWidth={1.7} /><span class="sidebar-nav-label">Settings</span>
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
