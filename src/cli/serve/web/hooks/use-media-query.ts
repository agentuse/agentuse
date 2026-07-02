import { useEffect, useState } from 'preact/hooks';

/**
 * Reactive CSS media-query match. Used to collapse the Agents tree's data
 * columns on narrow screens (the grid template is computed in JS, so it can't
 * be overridden by a stylesheet media query alone).
 */
export function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState<boolean>(() => {
    try {
      return window.matchMedia(query).matches;
    } catch {
      return false;
    }
  });

  useEffect(() => {
    let mql: MediaQueryList;
    try {
      mql = window.matchMedia(query);
    } catch {
      return;
    }
    const onChange = () => setMatches(mql.matches);
    onChange();
    mql.addEventListener('change', onChange);
    return () => mql.removeEventListener('change', onChange);
  }, [query]);

  return matches;
}
