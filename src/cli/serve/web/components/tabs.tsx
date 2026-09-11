import type { ComponentChildren, Ref } from 'preact';
import { useRef } from 'preact/hooks';

export interface TabItem<Id extends string> {
  id: Id;
  /** Button contents. Rich children are fine — badges, dots, counts. */
  label: ComponentChildren;
  panel: ComponentChildren;
  panelClass?: string;
  /** Ref handed to the panel element, for call sites that scroll it. */
  panelRef?: Ref<HTMLDivElement>;
  /**
   * 'always' keeps the panel mounted (hidden while inactive) so whatever it
   * loaded survives a tab switch; 'active' mounts it only while selected, for
   * panels that are expensive or stream.
   */
  mount?: 'always' | 'active';
}

/**
 * Tablist plus its panels, wired together. Hand-rolled tab bars kept shipping
 * role="tab" without the id/aria-controls/tabpanel half, which leaves a screen
 * reader announcing a tab that controls nothing — so the two halves live in one
 * component and cannot drift apart. Arrow keys move between tabs, as the ARIA
 * tabs pattern expects, with a roving tabindex so Tab itself lands on the
 * selected one.
 */
export function Tabs<Id extends string>(props: {
  /** Prefix for the generated element ids; needed when two tablists share a page. */
  idPrefix?: string;
  /** aria-label for the tablist. */
  label: string;
  value: Id;
  onChange: (id: Id) => void;
  tabs: Array<TabItem<Id>>;
  /** Class for the tablist itself; defaults to the dashboard's `tabs`. */
  listClass?: string;
  /** Optional wrapper around the tablist, when the design frames it. */
  listWrapClass?: string;
  /** Rendered inside the wrapper before the tablist. */
  head?: ComponentChildren;
  /** Rendered inside the tablist, for notes the bar's own layout positions. */
  listExtra?: ComponentChildren;
  /** Rendered after the tablist, inside the wrapper. */
  afterList?: ComponentChildren;
  /** Rendered between the tablist and the panels. */
  beforePanels?: ComponentChildren;
  tabClass?: (active: boolean) => string | undefined;
}) {
  const prefix = props.idPrefix ? `${props.idPrefix}-` : '';
  const tabId = (id: Id) => `${prefix}tab-${id}`;
  const panelId = (id: Id) => `${prefix}panel-${id}`;
  const listRef = useRef<HTMLDivElement | null>(null);

  const onKeyDown = (event: KeyboardEvent) => {
    const keys = ['ArrowLeft', 'ArrowRight', 'Home', 'End'];
    if (!keys.includes(event.key)) return;
    const index = props.tabs.findIndex((tab) => tab.id === props.value);
    if (index < 0) return;
    const last = props.tabs.length - 1;
    const next = event.key === 'ArrowLeft'
      ? (index === 0 ? last : index - 1)
      : event.key === 'ArrowRight'
        ? (index === last ? 0 : index + 1)
        : event.key === 'Home' ? 0 : last;
    event.preventDefault();
    props.onChange(props.tabs[next].id);
    // The newly selected tab is the only tabbable one, so move focus with it.
    const buttons = listRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]');
    buttons?.[next]?.focus();
  };

  const list = (
    <div
      class={props.listClass ?? 'tabs'}
      role="tablist"
      aria-label={props.label}
      ref={listRef}
      onKeyDown={onKeyDown}
    >
      {props.tabs.map((tab) => {
        const active = tab.id === props.value;
        return (
          <button
            key={tab.id}
            type="button"
            role="tab"
            id={tabId(tab.id)}
            aria-controls={panelId(tab.id)}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            class={props.tabClass ? props.tabClass(active) : (active ? 'is-active' : '')}
            onClick={() => props.onChange(tab.id)}
          >
            {tab.label}
          </button>
        );
      })}
      {props.listExtra}
    </div>
  );

  return (
    <>
      {props.listWrapClass || props.head || props.afterList
        ? <div class={props.listWrapClass}>{props.head}{list}{props.afterList}</div>
        : list}
      {props.beforePanels}
      {props.tabs.map((tab) => {
        const active = tab.id === props.value;
        if (!active && tab.mount === 'active') return null;
        return (
          <div
            key={tab.id}
            id={panelId(tab.id)}
            class={tab.panelClass}
            {...(tab.panelRef ? { ref: tab.panelRef } : {})}
            role="tabpanel"
            aria-labelledby={tabId(tab.id)}
            hidden={!active}
          >
            {tab.panel}
          </div>
        );
      })}
    </>
  );
}
