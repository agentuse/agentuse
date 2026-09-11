import { useEffect, useState } from 'preact/hooks';

/**
 * One 1s ticker for the whole page. Four components each ran their own
 * setInterval, one of them per running card, so a busy session list woke the
 * main thread several times a second on unsynchronised schedules. Subscribers
 * share a single timer that starts with the first of them and stops with the
 * last.
 */
const subscribers = new Set<(now: number) => void>();
let timer: ReturnType<typeof setInterval> | null = null;

function subscribe(notify: (now: number) => void): () => void {
  subscribers.add(notify);
  if (!timer) {
    timer = setInterval(() => {
      const now = Date.now();
      for (const fn of subscribers) fn(now);
    }, 1000);
  }
  return () => {
    subscribers.delete(notify);
    if (subscribers.size === 0 && timer) {
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Current time, refreshed every second while `enabled`. */
export function useNow(enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    return subscribe(setNow);
  }, [enabled]);
  return now;
}
