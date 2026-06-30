import type { ComponentChildren } from 'preact';
import { ThemeToggle } from './theme-toggle';
import { openAgentPalette } from './agent-palette';
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

export type TopbarPage = 'agents' | 'sessions' | 'schedules' | 'stores' | 'approvals';

export function Topbar(props: { currentPage?: TopbarPage; right?: ComponentChildren }) {
  const navItem = (page: TopbarPage, label: string) => {
    const active = props.currentPage === page;
    return (
      <a
        class={`nav-item${active ? ' active' : ''}`}
        href={`/${page}`}
        aria-current={active ? 'page' : undefined}
      >
        {label}
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
        <ThemeToggle />
      </span>
    </div>
  );
}
