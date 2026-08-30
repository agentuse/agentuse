import { useEffect, useId, useRef, useState } from 'preact/hooks';

export interface DashboardSelectOption {
  value: string;
  label: string;
}

/** Theme-consistent single select for dashboard dialogs. Native select menus
 * are painted by the host WebView and ignore the dashboard color scheme. */
export function DashboardSelect(props: {
  value: string;
  options: readonly DashboardSelectOption[];
  onChange: (value: string) => void;
  ariaLabel: string;
  disabled?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const listboxId = useId();
  const selected = Math.max(0, props.options.findIndex((option) => option.value === props.value));

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: MouseEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onPointerDown);
    return () => document.removeEventListener('mousedown', onPointerDown);
  }, [open]);

  useEffect(() => {
    if (props.disabled) setOpen(false);
  }, [props.disabled]);

  useEffect(() => {
    if (open) listRef.current?.querySelector<HTMLElement>('.dashboard-select-option.is-active')?.scrollIntoView({ block: 'nearest' });
  }, [active, open]);

  const openList = () => {
    if (props.disabled || props.options.length === 0) return;
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
    }
  };

  const label = props.options.find((option) => option.value === props.value)?.label ?? props.value;
  const activeOptionId = open && props.options[active] ? `${listboxId}-option-${active}` : undefined;

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
      {open && (
        <div class="dashboard-select-menu" id={listboxId} ref={listRef} role="listbox" aria-label={props.ariaLabel}>
          {props.options.map((option, index) => (
            <button
              type="button"
              id={`${listboxId}-option-${index}`}
              key={option.value}
              class={`dashboard-select-option${index === active ? ' is-active' : ''}${option.value === props.value ? ' is-selected' : ''}`}
              role="option"
              aria-selected={option.value === props.value}
              onMouseEnter={() => setActive(index)}
              onMouseDown={(event) => { event.preventDefault(); choose(index); }}
            >
              <span>{option.label}</span><span class="dashboard-select-check" aria-hidden="true">✓</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
