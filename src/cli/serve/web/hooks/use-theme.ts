import { useEffect, useState } from 'preact/hooks';

export type ThemePref = 'light' | 'dark' | 'system';

function readPref(): ThemePref {
  const stored = localStorage.getItem('agentuse-theme');
  return stored === 'light' || stored === 'dark' ? stored : 'system';
}

function applyTheme(pref: ThemePref, lightMql: MediaQueryList): void {
  const resolved = pref === 'light' || pref === 'dark'
    ? pref
    : (lightMql.matches ? 'light' : 'dark');
  document.documentElement.setAttribute('data-theme', resolved);
  document.documentElement.setAttribute('data-theme-pref', pref);
}

export function useTheme(): { pref: ThemePref; setPref: (pref: ThemePref) => void } {
  const [pref, setPrefState] = useState<ThemePref>(() => readPref());

  useEffect(() => {
    const lightMql = window.matchMedia('(prefers-color-scheme: light)');
    applyTheme(pref, lightMql);
    const onChange = () => {
      if (readPref() === 'system') applyTheme('system', lightMql);
    };
    lightMql.addEventListener('change', onChange);
    return () => lightMql.removeEventListener('change', onChange);
  }, [pref]);

  const setPref = (next: ThemePref) => {
    if (next === 'system') localStorage.removeItem('agentuse-theme');
    else localStorage.setItem('agentuse-theme', next);
    setPrefState(next);
  };

  return { pref, setPref };
}
