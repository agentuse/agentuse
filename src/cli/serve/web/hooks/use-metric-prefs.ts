import { useEffect, useRef, useState } from 'preact/hooks';

export type MetricDisplay = 'number' | 'bars' | 'line';

const DISPLAYS: readonly MetricDisplay[] = ['number', 'bars', 'line'];

/** Per-viewer customization of the Home Results tiles. Only deviations from
 *  the default are stored, so metrics recorded later default to visible,
 *  freshest-first, plain-number tiles. */
export interface MetricPrefs {
  /** Metric names hidden from the grid (still shown, dimmed, in edit mode). */
  hidden: string[];
  /** Manual tile order; metrics not listed sort after, freshest first. */
  order: string[];
  /** Per-metric display; anything unlisted renders as a plain number. */
  display: Record<string, MetricDisplay>;
}

const STORAGE_KEY = 'agentuse-home-metric-prefs';
const CHANGE_EVENT = 'agentuse-home-metric-prefs-change';
const EMPTY: MetricPrefs = { hidden: [], order: [], display: {} };

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((v) => typeof v === 'string');
}

function readPrefs(): MetricPrefs {
  if (typeof localStorage === 'undefined') return EMPTY;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw === null) return EMPTY;
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== 'object' || parsed === null) return EMPTY;
    const { hidden, order, display } = parsed as Record<string, unknown>;
    const cleanDisplay: Record<string, MetricDisplay> = {};
    if (typeof display === 'object' && display !== null) {
      for (const [metric, value] of Object.entries(display)) {
        if (DISPLAYS.includes(value as MetricDisplay)) cleanDisplay[metric] = value as MetricDisplay;
      }
    }
    return {
      hidden: isStringArray(hidden) ? hidden : [],
      order: isStringArray(order) ? order : [],
      display: cleanDisplay,
    };
  } catch {
    return EMPTY;
  }
}

function isDefault(prefs: MetricPrefs): boolean {
  return prefs.hidden.length === 0 && prefs.order.length === 0 && Object.keys(prefs.display).length === 0;
}

export function useMetricPrefs(): {
  prefs: MetricPrefs;
  setOrder: (order: string[]) => void;
  toggleHidden: (metric: string) => void;
  setDisplay: (metric: string, display: MetricDisplay) => void;
} {
  const [prefs, setPrefsState] = useState<MetricPrefs>(() => readPrefs());
  // Mutations read through a ref so rapid edits (two clicks before a
  // re-render) accumulate instead of the second reverting the first.
  const prefsRef = useRef(prefs);
  const setPrefs = (next: MetricPrefs) => {
    prefsRef.current = next;
    setPrefsState(next);
  };

  useEffect(() => {
    const sync = () => setPrefs(readPrefs());
    window.addEventListener('storage', sync);
    window.addEventListener(CHANGE_EVENT, sync);
    return () => {
      window.removeEventListener('storage', sync);
      window.removeEventListener(CHANGE_EVENT, sync);
    };
  }, []);

  const write = (next: MetricPrefs) => {
    try {
      if (isDefault(next)) localStorage.removeItem(STORAGE_KEY);
      else localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Browsers can deny localStorage in private/restricted contexts. The
      // current tab still gets the edit even when it cannot persist.
    }
    setPrefs(next);
    window.dispatchEvent(new CustomEvent(CHANGE_EVENT));
  };

  return {
    prefs,
    setOrder: (order) => write({ ...prefsRef.current, order }),
    toggleHidden: (metric) => {
      const current = prefsRef.current;
      const hidden = current.hidden.includes(metric)
        ? current.hidden.filter((m) => m !== metric)
        : [...current.hidden, metric];
      write({ ...current, hidden });
    },
    setDisplay: (metric, display) => {
      const current = prefsRef.current;
      const next = { ...current.display };
      if (display === 'number') delete next[metric];
      else next[metric] = display;
      write({ ...current, display: next });
    },
  };
}
