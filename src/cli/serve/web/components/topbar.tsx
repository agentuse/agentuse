import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';
import { openAgentPalette } from './agent-palette';
import { useGlobalApprovals } from '../hooks/use-global-approvals';
import { WORDMARK_SVG } from '../../brand';
import { brandName, hasCustomBrand } from '../lib/brand';

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

/** Gear link to Dashboard-local preferences and browser recovery controls. */
function SettingsLink() {
  return (
    <a class="icon-btn" href="/settings" aria-label="Dashboard preferences" title="Dashboard preferences">
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">
        <circle cx="12" cy="12" r="3" />
        <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
      </svg>
    </a>
  );
}

export type TopbarPage = 'home' | 'agents' | 'sessions' | 'schedules' | 'stores' | 'approvals';

export function Topbar(props: { currentPage?: TopbarPage; right?: ComponentChildren }) {
  const navWrapRef = useRef<HTMLDivElement>(null);
  const activeNavRef = useRef<HTMLAnchorElement>(null);
  const [navEdges, setNavEdges] = useState({ left: false, right: false });

  const approvals = useGlobalApprovals();
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
        <span class="brand-wordmark" dangerouslySetInnerHTML={{ __html: WORDMARK_SVG }} />
        {hasCustomBrand() && (
          <>
            <span class="brand-sep" aria-hidden="true">·</span>
            <span class="brand-name">{brandName()}</span>
          </>
        )}
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
        <SettingsLink />
      </div>
    </header>
  );
}
