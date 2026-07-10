import { useEffect, useState } from 'preact/hooks';

/**
 * The Agents tree's visible columns, as an ordered list of column ids. Columns
 * are user-managed (built-in `schedule`/`run` plus `meta:<key>` per metadata
 * key), so the choice lives in localStorage. Order is preserved (append on add)
 * and kept in sync across tabs like pins.
 *
 * Absent storage means "never customized" -> the default set. An explicit empty
 * array is respected (the user removed every column).
 */
const STORAGE_KEY = 'agentuse-agents-columns-v2';
const LEGACY_STORAGE_KEY = 'agentuse-agents-columns';
const DEFAULT_COLUMNS = ['lastRun', 'schedule', 'run'];

function parseColumns(raw: string | null): string[] | null {
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : null;
  } catch {
    return null;
  }
}

function read(): string[] {
  try {
    const stored = parseColumns(localStorage.getItem(STORAGE_KEY));
    if (stored !== null) return stored;
    // One-time migration: a v1 customization keeps its set and gains the new
    // default "Last run" column up front (removable like any other column).
    // An explicit v1 empty array stays empty — the user removed every column.
    const legacy = parseColumns(localStorage.getItem(LEGACY_STORAGE_KEY));
    if (legacy !== null) {
      return legacy.length === 0 || legacy.includes('lastRun') ? legacy : ['lastRun', ...legacy];
    }
    return [...DEFAULT_COLUMNS];
  } catch {
    return [...DEFAULT_COLUMNS];
  }
}

function write(columns: string[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(columns));
  } catch {
    /* storage unavailable (private mode); choice stays in-memory for the session */
  }
}

export function useAgentColumns(): {
  columns: string[];
  addColumn: (id: string) => void;
  removeColumn: (id: string) => void;
} {
  const [columns, setColumns] = useState<string[]>(() => read());

  useEffect(() => {
    const onStorage = (e: StorageEvent) => {
      if (e.key === STORAGE_KEY) setColumns(read());
    };
    window.addEventListener('storage', onStorage);
    return () => window.removeEventListener('storage', onStorage);
  }, []);

  const addColumn = (id: string) => {
    setColumns((prev) => {
      if (prev.includes(id)) return prev;
      const next = [...prev, id];
      write(next);
      return next;
    });
  };

  const removeColumn = (id: string) => {
    setColumns((prev) => {
      const next = prev.filter((c) => c !== id);
      write(next);
      return next;
    });
  };

  return { columns, addColumn, removeColumn };
}
