import { createPortal } from 'preact/compat';
import { useEffect, useId, useRef, useState } from 'preact/hooks';

export interface DashboardSelectOption {
  value: string;
  label: string;
  group?: string;
  description?: string;
  meta?: string;
  badge?: string;
}

export interface DashboardSelectMenuPosition {
  left: number;
  width: number;
  maxHeight: number;
  top?: number;
  bottom?: number;
}

/** Keep a portalled listbox inside the viewport and anchor it to its trigger. */
export function getDashboardSelectMenuPosition(
  trigger: Pick<DOMRect, 'left' | 'top' | 'bottom' | 'width'>,
  viewportWidth: number,
  viewportHeight: number,
): DashboardSelectMenuPosition {
  const viewportGap = 8;
  const triggerGap = 5;
  const preferredMaxHeight = 320;
  const availableBelow = Math.max(0, viewportHeight - trigger.bottom - triggerGap - viewportGap);
  const availableAbove = Math.max(0, trigger.top - triggerGap - viewportGap);
  const openAbove = availableAbove > availableBelow && availableBelow < 240;
  const availableHeight = openAbove ? availableAbove : availableBelow;
  const width = Math.max(0, Math.min(trigger.width, viewportWidth - viewportGap * 2));
  const left = Math.min(
    Math.max(viewportGap, trigger.left),
    Math.max(viewportGap, viewportWidth - viewportGap - width),
  );

  return {
    left,
    width,
    maxHeight: Math.min(preferredMaxHeight, availableHeight),
    ...(openAbove
      ? { bottom: viewportHeight - trigger.top + triggerGap }
      : { top: trigger.bottom + triggerGap }),
  };
}

/** Find the next case-insensitive prefix match, wrapping once through the list. */
export function findTypeaheadOption(
  options: readonly DashboardSelectOption[],
  query: string,
  startIndex: number,
): number {
  const normalized = query.trim().toLocaleLowerCase();
  if (!normalized || options.length === 0) return -1;
  for (let offset = 1; offset <= options.length; offset++) {
    const index = (startIndex + offset + options.length) % options.length;
    if (options[index]?.label.toLocaleLowerCase().startsWith(normalized)) return index;
  }
  return -1;
}

/** Theme-consistent single select for dashboard dialogs. Native select menus
 * are painted by the host WebView and ignore the dashboard color scheme. */
export function DashboardSelect(props: {
  value: string;
  options: readonly DashboardSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const [menuPosition, setMenuPosition] = useState<DashboardSelectMenuPosition | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeaheadRef = useRef({ query: '', timestamp: 0 });
  const listboxId = useId();
  const selected = Math.max(0, props.options.findIndex((option) => option.value === props.value));

  const positionMenu = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    setMenuPosition(getDashboardSelectMenuPosition(rect, window.innerWidth, window.innerHeight));
  };

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (!rootRef.current?.contains(target) && !listRef.current?.contains(target)) setOpen(false);
    };
    const onViewportChange = () => positionMenu();
    document.addEventListener('mousedown', onPointerDown);
    window.addEventListener('resize', onViewportChange);
    window.addEventListener('scroll', onViewportChange, true);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      window.removeEventListener('resize', onViewportChange);
      window.removeEventListener('scroll', onViewportChange, true);
    };
  }, [open]);

  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('.dashboard-select-option.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  useEffect(() => {
    if (!open) return;
    const menu = listRef.current;
    if (!menu || typeof menu.showPopover !== 'function') return;
    try {
      menu.showPopover();
    } catch {
      // The menu may already be open if the viewport position changed.
    }
    return () => {
      if (typeof menu.hidePopover !== 'function') return;
      try {
        menu.hidePopover();
      } catch {
        // Removing an already-closed popover is harmless.
      }
    };
  }, [open]);

  const openList = () => {
    if (props.disabled || props.options.length === 0) return;
    positionMenu();
    setActive(selected);
    setOpen(true);
  };
  const closeList = (restoreFocus = false) => {
    setOpen(false);
    if (restoreFocus) buttonRef.current?.focus();
  };
  const choose = (index: number) => {
    const option = props.options[index];
    if (!option) return;
    props.onChange(option.value);
    closeList(true);
  };
  const move = (delta: number) => {
    if (!open) {
      openList();
      return;
    }
    setActive((index) => (index + delta + props.options.length) % props.options.length);
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); move(1); }
    else if (event.key === 'ArrowUp') { event.preventDefault(); move(-1); }
    else if (event.key === 'Home' && open) { event.preventDefault(); setActive(0); }
    else if (event.key === 'End' && open) { event.preventDefault(); setActive(props.options.length - 1); }
    else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (open) choose(active);
      else openList();
    } else if (event.key === 'Escape' && open) {
      event.preventDefault();
      closeList(true);
    } else if (event.key === 'Tab') {
      setOpen(false);
    } else if (event.key.length === 1 && event.key !== ' ' && !event.altKey && !event.ctrlKey && !event.metaKey) {
      const now = Date.now();
      const previous = typeaheadRef.current;
      const query = now - previous.timestamp > 700 ? event.key : `${previous.query}${event.key}`;
      let next = findTypeaheadOption(props.options, query, open ? active : selected);
      const cycling = query.length > 1 && [...query].every((character) => character.toLocaleLowerCase() === query[0]?.toLocaleLowerCase());
      if (next < 0 && cycling) next = findTypeaheadOption(props.options, event.key, open ? active : selected);
      typeaheadRef.current = { query, timestamp: now };
      if (next >= 0) {
        event.preventDefault();
        if (!open) {
          positionMenu();
          setOpen(true);
        }
        setActive(next);
      }
    }
  };

  const label = props.options.find((option) => option.value === props.value)?.label
    ?? props.placeholder
    ?? props.value;
  const activeOptionId = open && props.options[active] ? `${listboxId}-option-${active}` : undefined;
  const portalTarget = rootRef.current?.closest('dialog') ?? (typeof document !== 'undefined' ? document.body : null);

  return (
    <div class={`dashboard-select${open ? ' is-open' : ''}`} ref={rootRef}>
      <button
        ref={buttonRef}
        type="button"
        class="dashboard-select-trigger"
        role="combobox"
        aria-label={props.ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-controls={listboxId}
        aria-activedescendant={activeOptionId}
        disabled={props.disabled}
        onClick={() => open ? closeList() : openList()}
        onKeyDown={onKeyDown}
      >
        <span>{label}</span><span class="dashboard-select-chevron" aria-hidden="true" />
      </button>
      {open && menuPosition && portalTarget && createPortal(
        <div
          class="dashboard-select-menu"
          id={listboxId}
          ref={listRef}
          role="listbox"
          aria-label={props.ariaLabel}
          popover="manual"
          style={{
            left: `${menuPosition.left}px`,
            width: `${menuPosition.width}px`,
            maxHeight: `${menuPosition.maxHeight}px`,
            top: menuPosition.top === undefined ? 'auto' : `${menuPosition.top}px`,
            bottom: menuPosition.bottom === undefined ? 'auto' : `${menuPosition.bottom}px`,
          }}
        >
          {props.options.map((option, index) => (
            <div class="dashboard-select-option-wrap" role="presentation" key={option.value}>
              {option.group && props.options[index - 1]?.group !== option.group && (
                <div class="dashboard-select-group" role="presentation">{option.group}</div>
              )}
              <button
                type="button"
                id={`${listboxId}-option-${index}`}
                class={`dashboard-select-option${index === active ? ' is-active' : ''}${option.value === props.value ? ' is-selected' : ''}`}
                role="option"
                aria-selected={option.value === props.value}
                onMouseEnter={() => setActive(index)}
                onMouseDown={(event) => { event.preventDefault(); choose(index); }}
              >
                <span class="dashboard-select-option-copy">
                  <span class="dashboard-select-option-label">{option.label}</span>
                  {(option.meta || option.description) && <span class="dashboard-select-option-meta">{option.meta ?? option.description}</span>}
                </span>
                {option.badge && <span class="dashboard-select-option-badge">{option.badge}</span>}
                <span class="dashboard-select-check" aria-hidden="true">✓</span>
              </button>
            </div>
          ))}
        </div>,
        portalTarget,
      )}
    </div>
  );
}
