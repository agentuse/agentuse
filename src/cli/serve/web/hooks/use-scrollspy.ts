import { useEffect, useState } from 'preact/hooks';

/** Roughly clears the sticky topbar; the reference line a section must cross to count as "current". */
const REFERENCE_Y = 110;

/**
 * Tracks which of the given element ids is the current section: the last one
 * whose top has crossed the reference line near the top of the viewport, or
 * the very last id once the page is scrolled to its end (its heading may
 * never reach the reference line if there's nothing left to scroll). Recomputed
 * directly from bounding rects on scroll/resize rather than via
 * IntersectionObserver, which needs a narrow viewport band tuned just right
 * and still leaves the top-of-page and bottom-of-page edges ambiguous.
 */
export function useScrollspy(ids: string[]): string | null {
  const key = ids.join(' ');
  const [activeId, setActiveId] = useState<string | null>(ids[0] ?? null);

  useEffect(() => {
    const elements = ids
      .map((id) => document.getElementById(id))
      .filter((el): el is HTMLElement => el !== null);
    if (elements.length === 0) {
      setActiveId(ids[0] ?? null);
      return;
    }

    const update = () => {
      const atBottom = window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) {
        setActiveId(elements[elements.length - 1]!.id);
        return;
      }
      let current = elements[0]!.id;
      for (const el of elements) {
        if (el.getBoundingClientRect().top <= REFERENCE_Y) current = el.id;
        else break;
      }
      setActiveId(current);
    };

    update();
    window.addEventListener('scroll', update, { passive: true });
    window.addEventListener('resize', update);
    return () => {
      window.removeEventListener('scroll', update);
      window.removeEventListener('resize', update);
    };
  }, [key]);

  return activeId;
}
