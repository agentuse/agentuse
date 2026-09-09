import { useCallback, useRef, useState } from 'preact/hooks';

/**
 * The measured width of an element, kept live with a ResizeObserver.
 *
 * A viewport media query is the wrong signal for a page that lives inside the
 * app shell: the sidebar takes 224px (56px collapsed, and it is user-resizable),
 * so the same viewport width leaves wildly different room for the content. This
 * measures the box that actually holds the layout instead.
 *
 * `estimate` is the first-render value, before the element exists. Pick one
 * that lands on the same side of the caller's threshold in the common case, so
 * the layout does not visibly flip on mount.
 *
 * Returns a callback ref: attach it to the element to measure. It re-attaches
 * cleanly when the caller swaps one element for another (a layout that renders
 * a different tree either side of its own threshold does exactly that).
 */
export function useElementWidth(estimate: number): [(el: HTMLElement | null) => void, number] {
  const observer = useRef<ResizeObserver | null>(null);
  const [width, setWidth] = useState(estimate);

  const ref = useCallback((el: HTMLElement | null) => {
    observer.current?.disconnect();
    observer.current = null;
    if (!el) return;
    if (typeof ResizeObserver === 'undefined') {
      setWidth(el.getBoundingClientRect().width);
      return;
    }
    const ro = new ResizeObserver((entries) => {
      const w = entries[0]?.contentRect.width;
      if (typeof w === 'number' && w > 0) setWidth(w);
    });
    ro.observe(el);
    observer.current = ro;
  }, []);

  return [ref, width];
}
