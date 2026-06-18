import { useEffect, useRef } from 'preact/hooks';

export type DecisionDialogMode = 'comment' | 'reject';

const COPY: Record<DecisionDialogMode, {
  title: string;
  body?: string;
  placeholder: string;
  submitLabel: string;
  submitClass: string;
  requireText: boolean;
}> = {
  comment: {
    title: 'leave a comment',
    placeholder: 'explain your decision, ask for a tweak, or send context back to the agent',
    submitLabel: 'Send comment',
    submitClass: 'primary',
    requireText: true,
  },
  reject: {
    title: 'reject this request?',
    body: 'The agent will stop this approval flow and apply any configured rejected-state updates.',
    placeholder: 'optional: tell the agent why this should be rejected',
    submitLabel: 'Reject',
    submitClass: 'danger',
    requireText: false,
  },
};

export function DecisionDialog(props: {
  open: boolean;
  mode: DecisionDialogMode;
  onSubmit: (comment?: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const copy = COPY[props.mode];

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      if (inputRef.current) inputRef.current.value = '';
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!props.open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [props.open]);

  const submit = () => {
    const text = (inputRef.current?.value ?? '').trim();
    if (copy.requireText && !text) {
      inputRef.current?.focus();
      return;
    }
    if (inputRef.current) inputRef.current.value = '';
    props.onSubmit(text || undefined);
  };

  return (
    <dialog
      id="decision-dialog"
      ref={dialogRef}
      aria-labelledby="decision-dialog-title"
      aria-describedby={copy.body ? 'decision-dialog-description' : undefined}
      onClick={(event) => {
        if (event.target === dialogRef.current) props.onClose();
      }}
      onClose={props.onClose}
    >
      <form method="dialog">
        <div class="dialog-head">
          <span id="decision-dialog-title" class={`title ${props.mode}`}>{copy.title}</span>
          <button type="button" class="dialog-close" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        {copy.body && <p id="decision-dialog-description" class="dialog-description">{copy.body}</p>}
        <div class="dialog-body">
          <span class="prefix">&gt;</span>
          <textarea
            id={`${props.mode}-comment`}
            ref={inputRef}
            placeholder={copy.placeholder}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div class="dialog-foot">
          <span class="hint"><span class="kbd">⌘⏎</span> {props.mode === 'reject' ? 'reject' : 'send'} <span class="kbd">esc</span> cancel</span>
          <span class="actions">
            <button type="button" onClick={props.onClose}>Cancel</button>
            <button type="button" class={copy.submitClass} onClick={submit}>{copy.submitLabel}</button>
          </span>
        </div>
      </form>
    </dialog>
  );
}
