import { useEffect, useRef } from 'preact/hooks';

/**
 * Collects a one-off instruction to append to an agent's prompt before kicking
 * off a run. Mirrors the decision-dialog pattern (native <dialog>, ⌘⏎ submit,
 * click-backdrop / Esc to close) for consistency with the approval flow.
 */
export function RunInstructionDialog(props: {
  open: boolean;
  agentName: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (instruction: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

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
    if (props.busy) return;
    const text = (inputRef.current?.value ?? '').trim();
    if (!text) { inputRef.current?.focus(); return; }
    props.onSubmit(text);
  };

  return (
    <dialog
      class="run-dialog"
      ref={dialogRef}
      aria-labelledby="run-dialog-title"
      aria-describedby="run-dialog-description"
      onClick={(event) => { if (event.target === dialogRef.current) props.onClose(); }}
      onClose={props.onClose}
    >
      <form method="dialog">
        <div class="dialog-head">
          <span id="run-dialog-title" class="title">run with custom instruction</span>
          <button type="button" class="dialog-close" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        <p id="run-dialog-description" class="dialog-description">
          Appended to <strong>{props.agentName}</strong>'s instructions for this run only.
        </p>
        <div class="dialog-body">
          <span class="prefix">&gt;</span>
          <textarea
            id="run-instruction"
            ref={inputRef}
            placeholder="e.g. focus on the EU region this time and skip the email step"
            disabled={props.busy}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        {props.error && <p class="dialog-error">{props.error}</p>}
        <div class="dialog-foot">
          <span class="hint"><span class="kbd">⌘⏎</span> run <span class="kbd">esc</span> cancel</span>
          <span class="actions">
            <button type="button" onClick={props.onClose}>Cancel</button>
            <button type="button" class="primary" disabled={props.busy} onClick={submit}>
              {props.busy ? 'Starting…' : 'Run agent'}
            </button>
          </span>
        </div>
      </form>
    </dialog>
  );
}
