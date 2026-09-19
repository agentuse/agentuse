import type { ComponentChildren } from 'preact';
import { useEffect, useRef, useState } from 'preact/hooks';

function DotsIcon() {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden="true">
      <circle cx="5" cy="12" r="1.6" /><circle cx="12" cy="12" r="1.6" /><circle cx="19" cy="12" r="1.6" />
    </svg>
  );
}

/**
 * The ⋯ overflow menu used by the session bar and the agents list. Both had
 * the same position:fixed popover and the same outside-click/Escape/scroll
 * teardown, and neither moved focus: a role="menu" that cannot be driven from
 * the keyboard is a menu in name only. Arrow keys walk the items here, Escape
 * closes, and focus returns to the trigger rather than falling back to the top
 * of the document.
 *
 * `children` receives the closer, since every item closes the menu when it
 * acts.
 */
export function MenuPopover(props: {
  /** Class on the positioning wrapper, e.g. `session-menu`. */
  wrapClass: string;
  /** Class on the trigger, given the open state. */
  triggerClass: (open: boolean) => string;
  label: string;
  title?: string;
  /** Kept out of the tab order while the bar holding it is still hidden. */
  tabIndex?: number;
  children: (close: () => void) => ComponentChildren;
}) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);
  // A pointer click outside should not yank focus back to the trigger; a
  // keyboard close should.
  const restoreFocus = useRef(false);

  const close = (restore = true) => {
    restoreFocus.current = restore;
    setPos(null);
  };

  useEffect(() => {
    if (!pos) {
      if (restoreFocus.current) {
        restoreFocus.current = false;
        btnRef.current?.focus();
      }
      return;
    }
    const onDown = (e: MouseEvent) => {
      const target = e.target as Node;
      if (popRef.current?.contains(target) || btnRef.current?.contains(target)) return;
      close(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { close(); return; }
      if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Home' && e.key !== 'End') return;
      const items = Array.from(popRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]') ?? [])
        .filter((item) => !(item as HTMLButtonElement).disabled);
      if (items.length === 0) return;
      e.preventDefault();
      const current = items.indexOf(document.activeElement as HTMLElement);
      const next = e.key === 'Home'
        ? 0
        : e.key === 'End'
          ? items.length - 1
          : e.key === 'ArrowDown'
            ? (current + 1) % items.length
            : (current <= 0 ? items.length - 1 : current - 1);
      items[next]?.focus();
    };
    const onScroll = () => close(false);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    window.addEventListener('scroll', onScroll, true);
    window.addEventListener('resize', onScroll);
    // Opening a menu puts the reader on its first item, as the menu pattern expects.
    requestAnimationFrame(() => {
      popRef.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus();
    });
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
      window.removeEventListener('scroll', onScroll, true);
      window.removeEventListener('resize', onScroll);
    };
  }, [pos]);

  const toggle = (event: Event) => {
    event.preventDefault();
    event.stopPropagation();
    if (pos) { close(); return; }
    const rect = btnRef.current!.getBoundingClientRect();
    setPos({ top: rect.bottom + 6, right: Math.max(8, window.innerWidth - rect.right) });
  };

  return (
    <div class={props.wrapClass}>
      <button
        type="button"
        ref={btnRef}
        class={props.triggerClass(Boolean(pos))}
        aria-haspopup="menu"
        aria-expanded={pos ? 'true' : 'false'}
        aria-label={props.label}
        {...(props.title ? { title: props.title } : {})}
        {...(props.tabIndex === undefined ? {} : { tabIndex: props.tabIndex })}
        onClick={toggle}
      >
        <DotsIcon />
      </button>
      {pos && (
        <div
          ref={popRef}
          class="menu-popover"
          role="menu"
          aria-label={props.label}
          style={{ top: `${pos.top}px`, right: `${pos.right}px` }}
        >
          {props.children(() => close())}
        </div>
      )}
    </div>
  );
}
