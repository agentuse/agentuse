import { useEffect, useRef } from 'preact/hooks';

export function CommentDialog(props: {
  open: boolean;
  onSubmit: (comment: string) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
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
    if (!text) {
      inputRef.current?.focus();
      return;
    }
    if (inputRef.current) inputRef.current.value = '';
    props.onSubmit(text);
  };

  return (
    <dialog
      id="comment-dialog"
      ref={dialogRef}
      aria-labelledby="comment-dialog-title"
      onClick={(event) => {
        if (event.target === dialogRef.current) props.onClose();
      }}
      onClose={props.onClose}
    >
      <form method="dialog">
        <div class="dialog-head">
          <span id="comment-dialog-title" class="title">leave a comment</span>
          <button type="button" class="dialog-close" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        <div class="dialog-body">
          <span class="prefix">&gt;</span>
          <textarea
            id="comment"
            ref={inputRef}
            placeholder="explain your decision, ask for a tweak, or send context back to the agent"
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
        </div>
        <div class="dialog-foot">
          <span class="hint"><span class="kbd">⌘⏎</span> send <span class="kbd">esc</span> cancel</span>
          <span class="actions">
            <button type="button" onClick={props.onClose}>Cancel</button>
            <button type="button" class="primary" onClick={submit}>Send comment</button>
          </span>
        </div>
      </form>
    </dialog>
  );
}
