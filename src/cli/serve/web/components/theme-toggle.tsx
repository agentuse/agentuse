import type { JSX } from 'preact';
import { useTheme, type ThemePref } from '../hooks/use-theme';

const OPTIONS: Array<{ pref: ThemePref; title: string; icon: JSX.Element }> = [
  {
    pref: 'light',
    title: 'Light',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round">
        <circle cx="8" cy="8" r="3" />
        <path d="M8 1.5v1.5M8 13v1.5M14.5 8H13M3 8H1.5M12.6 3.4l-1.06 1.06M4.46 11.54L3.4 12.6M12.6 12.6l-1.06-1.06M4.46 4.46L3.4 3.4" />
      </svg>
    ),
  },
  {
    pref: 'system',
    title: 'System',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5">
        <rect x="2" y="3" width="12" height="8" rx="1.5" />
        <path d="M5.5 13.5h5M8 11v2.5" stroke-linecap="round" />
      </svg>
    ),
  },
  {
    pref: 'dark',
    title: 'Dark',
    icon: (
      <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round">
        <path d="M13.5 9.5A5.5 5.5 0 1 1 6.5 2.5a4.5 4.5 0 0 0 7 7Z" />
      </svg>
    ),
  },
];

export function ThemeToggle() {
  const { pref, setPref } = useTheme();
  return (
    <span class="theme-toggle" role="group" aria-label="Theme">
      {OPTIONS.map((option) => (
        <button
          key={option.pref}
          type="button"
          title={option.title}
          aria-label={`${option.title} theme`}
          aria-pressed={pref === option.pref}
          onClick={() => setPref(option.pref)}
        >
          {option.icon}
        </button>
      ))}
    </span>
  );
}
