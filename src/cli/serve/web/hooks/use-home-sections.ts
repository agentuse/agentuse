import { useEffect, useRef, useState } from 'preact/hooks';
import { termTitle } from '../lib/terms';

/** Every toggleable Home section, in page order. The hero is not listed: it is
 *  the page's identity and always renders. The projects label honors
 *  serve.terms; the map is injected before any module runs, so this is safe
 *  at module scope. */
export const HOME_SECTIONS = [
  { id: 'running', label: 'Running now' },
  { id: 'attention', label: 'Needs attention' },
  { id: 'results', label: 'Results' },
  { id: 'latest', label: 'Runs by agent' },
  { id: 'coming-up', label: 'Coming up' },
  { id: 'feed', label: 'Activity feed' },
  { id: 'cards', label: 'Navigation cards' },
  { id: 'projects', label: termTitle('project', 2) },
] as const;

export type HomeSectionId = (typeof HOME_SECTIONS)[number]['id'];

const STORAGE_KEY = 'agentuse-home-hidden-sections';
const CHANGE_EVENT = 'agentuse-home-hidden-sections-change';
/** The raw status-transition feed ships hidden: the outcome-first sections
 *  above it carry the same information in more useful form. */
const DEFAULT_HIDDEN: readonly HomeSectionId[] = ['feed'];

const VALID_IDS = new Set<string>(HOME_SECTIONS.map((s) => s.id));

function readHidden(): Set<HomeSectionId> {
  if (typeof localStorage === 'undefined') return new Set(DEFAULT_HIDDEN);
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return new Set(DEFAULT_HIDDEN);
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set(DEFAULT_HIDDEN);
    return new Set(parsed.filter((id): id is HomeSectionId => typeof id === 'string' && VALID_IDS.has(id)));
  } catch {
    return new Set(DEFAULT_HIDDEN);
  }
}

/**
 * Per-viewer show/hide state for Home sections, persisted in localStorage and
 * broadcast across components/tabs (same pattern as use-session-list-view).
 * Only deviations from the default are stored, so new sections default on.
 */
export function useHomeSections(): {
  isVisible: (id: HomeSectionId) => boolean;
  toggle: (id: HomeSectionId) => void;
} {
  const [hidden, setHiddenState] = useState<Set<HomeSectionId>>(() => readHidden());
  // Mirror the latest value in a ref: toggle() must read through it, or two
  // toggles before a re-render both start from the same stale state and the
  // second silently reverts the first.
  const hiddenRef = useRef(hidden);
  const setHidden = (next: Set<HomeSectionId>) => {
    hiddenRef.current = next;
    setHiddenState(next);
  };

  useEffect(() => {
    const sync = () => setHidden(readHidden());
    window.addEventListener('storage', sync);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  const toggle = (id: HomeSectionId) => {
    const next = new Set(hiddenRef.current);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    try {
      const isDefault = next.size === DEFAULT_HIDDEN.length && DEFAULT_HIDDEN.every((d) => next.has(d));
      if (isDefault) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify([...next]));
    } catch {
      // Browsers can deny localStorage in private/restricted contexts. The
      // current tab still gets the toggle even when it cannot persist.
    }
    setHidden(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  };

  return { isVisible: (id) => !hidden.has(id), toggle };
}
