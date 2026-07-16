import { useEffect, useRef, useState } from 'preact/hooks';

export interface CountUpOptions {
  duration?: number;
  /** Start the very first render at the target instead of animating up from 0
   *  (live stats that should only animate on later updates, e.g. token cost). */
  startAtTarget?: boolean;
  /** Return whole numbers (integer stats); false keeps fractions for
   *  format callbacks like currency. */
  round?: boolean;
}

/**
 * Animate a numeric stat toward its latest value so counters visibly tick
 * instead of snapping: on load (from 0) and on each live update thereafter.
 */
export function useCountUp(target: number, options: CountUpOptions = {}): number {
  const { duration = 700, startAtTarget = false, round = true } = options;
  const initial = startAtTarget ? target : 0;
  const [display, setDisplay] = useState(initial);
  const fromRef = useRef(initial);
  useEffect(() => {
    const from = fromRef.current;
    if (from === target) return;
    let raf = 0;
    const start = performance.now();
    const tick = (t: number) => {
      const progress = Math.min(1, (t - start) / duration);
      const eased = 1 - Math.pow(1 - progress, 3);
      const value = from + (target - from) * eased;
      setDisplay(round ? Math.round(value) : value);
      if (progress < 1) {
        raf = requestAnimationFrame(tick);
      } else {
        fromRef.current = target;
      }
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, duration, round]);
  return display;
}
