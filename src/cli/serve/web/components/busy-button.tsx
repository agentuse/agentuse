import type { ComponentChildren, Ref } from 'preact';

/**
 * A button that is doing something. The pattern was rebuilt at a dozen call
 * sites — `btn-busy` on the class, a spinner span, `aria-busy`, a swapped
 * label — and the copies drifted: several announced nothing to a screen
 * reader while visibly spinning. One component keeps the four parts together.
 */
export function BusyButton(props: {
  busy: boolean | undefined;
  /** Contents while idle. */
  label: ComponentChildren;
  /** Contents while busy, after the spinner. Omit for a spinner alone. */
  busyLabel?: ComponentChildren;
  /** Base class; `btn-busy` is appended while busy. */
  class?: string;
  disabled?: boolean | undefined;
  title?: string;
  ariaDisabled?: boolean;
  describedBy?: string;
  buttonRef?: Ref<HTMLButtonElement>;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      {...(props.buttonRef ? { ref: props.buttonRef } : {})}
      class={props.class ? `${props.class}${props.busy ? ' btn-busy' : ''}` : (props.busy ? 'btn-busy' : undefined)}
      disabled={props.disabled ?? Boolean(props.busy)}
      aria-busy={Boolean(props.busy)}
      {...(props.ariaDisabled !== undefined ? { 'aria-disabled': props.ariaDisabled } : {})}
      {...(props.describedBy ? { 'aria-describedby': props.describedBy } : {})}
      {...(props.title ? { title: props.title } : {})}
      onClick={props.onClick}
    >
      {props.busy
        ? <><span class="btn-spinner" aria-hidden="true" />{props.busyLabel}</>
        : props.label}
    </button>
  );
}
