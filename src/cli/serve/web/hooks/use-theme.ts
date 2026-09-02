import { useState } from 'preact/hooks';

export type ThemePref = 'light' | 'dark' | 'system';

const lightMql = typeof window === 'undefined'
  ? undefined
  : window.matchMedia('(prefers-color-scheme: light)');

function readPref(): ThemePref {
  if (typeof localStorage === 'undefined') return 'system';
  const stored = localStorage.getItem('agentuse-theme');
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function applyTheme(pref: ThemePref): void {
  if (typeof document === 'undefined') return;
  const resolved = pref === 'light' || pref === 'dark'
    ? pref
    : (lightMql?.matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-pref', pref);
}

// Installed once from main.tsx so system light/dark flips reach every route,
// not just the Settings page where the toggle (and useTheme) is mounted.
export function initSystemThemeSync(): void {
  lightMql?.addEventListener('change', () => {
    if (readPref() === 'system') applyTheme('system');
  });
}

export function useTheme(): { pref: ThemePref; setPref: (pref: ThemePref) => void } {
  const [pref, setPrefState] = useState<ThemePref>(() => readPref());

  const setPref = (next: ThemePref) => {
    if (next === 'system') localStorage.removeItem('agentuse-theme');
    else localStorage.setItem('agentuse-theme', next);
    applyTheme(next);
    setPrefState(next);
  };

  return { pref, setPref };
}
