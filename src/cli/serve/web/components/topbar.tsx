import type { ComponentChildren } from 'preact';
import { ThemeToggle } from './theme-toggle';
import { WORDMARK_SVG } from '../../brand';

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
        <ThemeToggle />
      </span>
    </div>
  );
}
