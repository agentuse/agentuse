import { useEffect, useRef, useState } from 'preact/hooks';

/** Minimum reveal speed so the tail always reads as active typing. */
const MIN_CHARS_PER_SECOND = 90;
/** Target time to drain the backlog after a snapshot lands. Kept under the
 *  500ms SSE live-poll cadence so the reveal stays within one chunk of the
 *  real text instead of trailing further behind on every update. */
const CATCH_UP_MS = 450;

/**
 * Progressively reveals a streamed string so the ~500ms full-text SSE
 * snapshots read as continuous typing instead of bursty replacements.
 *
 * The reveal rate scales with the backlog (backlog drained in ~CATCH_UP_MS,
 * never slower than MIN_CHARS_PER_SECOND), so it speeds up when a large chunk
 * arrives and settles into a typing pace when nearly caught up. When
 * `streaming` is false — or the user prefers reduced motion — the full text is
 * returned immediately with no animation state.
 */
export function useSmoothText(target: string, streaming: boolean): string {
  const [, bump] = useState(0);
  // Fractional char position survives across frames and target growth; state
  // only exists to trigger re-renders as the integer position advances.
  const shownRef = useRef(streaming ? 0 : target.length);

  useEffect(() => {
    if (!streaming) {
      shownRef.current = target.length;
      return;
    }
    if (window.matchMedia?.('(prefers-reduced-motion: reduce)').matches) {
      if (shownRef.current !== target.length) {
        shownRef.current = target.length;
        bump((v) => v + 1);
      }
      return;
    }
    // A replaced (non-appended) message can leave the position past the end.
    if (shownRef.current > target.length) shownRef.current = target.length;
    if (shownRef.current >= target.length) return;

    let raf = 0;
    let last = performance.now();
    const step = (now: number) => {
      const dt = Math.min((now - last) / 1000, 0.1);
      last = now;
      const backlog = target.length - shownRef.current;
      const rate = Math.max(MIN_CHARS_PER_SECOND, backlog / (CATCH_UP_MS / 1000));
      const before = Math.floor(shownRef.current);
      shownRef.current = Math.min(target.length, shownRef.current + rate * dt);
      if (Math.floor(shownRef.current) !== before) bump((v) => v + 1);
      if (shownRef.current < target.length) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [target, streaming]);

  if (!streaming) return target;
  const shown = Math.floor(shownRef.current);
  return shown >= target.length ? target : target.slice(0, shown);
}
