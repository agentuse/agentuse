import type { ComponentChildren } from 'preact';
import { useEffect, useRef } from 'preact/hooks';

let titleSeq = 0;

/**
 * Native <dialog> wrapper. Six dialogs had each rebuilt the same open/close
 * effect, the same backdrop-click test and the same head row, and one of them
 * had no accessible name because its title was a bare <strong> with no id. The
 * title is labelled here so that cannot happen again.
 *
 * `open` drives the dialog; Escape and the backdrop both report back through
 * `onClose` rather than closing behind the caller's state.
 */
export function Modal(props: {
  open: boolean;
  onClose: () => void;
  /** Head row title. Labels the dialog via aria-labelledby. */
  title: ComponentChildren;
  /** Extra classes on the title span, e.g. the comment dialog's mode. */
  titleClass?: string;
  class?: string;
  id?: string;
  describedBy?: string;
  /** Run once the dialog has opened, for focusing the first field. */
  onOpened?: () => void;
  /** Wrap the head and body in a method="dialog" form, as two dialogs do. */
  form?: boolean;
  children: ComponentChildren;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const titleIdRef = useRef<string>('');
  if (!titleIdRef.current) titleIdRef.current = `modal-title-${++titleSeq}`;

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      // showModal is missing in the older webviews the dashboard still runs in.
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      props.onOpened?.();
    } else if (!props.open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [props.open]);

  const head = (
    <div class="dialog-head">
      <span id={titleIdRef.current} class={props.titleClass ? `title ${props.titleClass}` : 'title'}>{props.title}</span>
      <button type="button" class="dialog-close" aria-label="Close" onClick={props.onClose}>×</button>
    </div>
  );

  return (
    <dialog
      {...(props.id ? { id: props.id } : {})}
      {...(props.class ? { class: props.class } : {})}
      ref={dialogRef}
      aria-labelledby={titleIdRef.current}
      {...(props.describedBy ? { 'aria-describedby': props.describedBy } : {})}
      onClick={(event) => { if (event.target === dialogRef.current) props.onClose(); }}
      onClose={props.onClose}
    >
      {props.form
        ? <form method="dialog">{head}{props.children}</form>
        : <>{head}{props.children}</>}
    </dialog>
  );
}
