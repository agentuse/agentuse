import { useRef } from 'preact/hooks';

export function ContinuePanel(props: {
  hidden: boolean;
  disabled: boolean;
  onSubmit: (prompt: string) => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);

  const submit = () => {
    if (props.disabled) return;
    const prompt = (inputRef.current?.value ?? '').trim();
    if (!prompt) {
      inputRef.current?.focus();
      return;
    }
    props.onSubmit(prompt);
    if (inputRef.current) inputRef.current.value = '';
  };

  return (
    <div class="continue-panel" hidden={props.hidden}>
      <div class="continue-label">continue session</div>
      <textarea
        id="continue-prompt"
        ref={inputRef}
        placeholder="tell the agent what to do next"
        disabled={props.disabled}
        onKeyDown={(event) => {
          if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
            event.preventDefault();
            submit();
          }
        }}
      />
      <div class="continue-actions">
        <span class="continue-hint"><span class="kbd">⌘⏎</span> continue with this instruction</span>
        <button type="button" class="primary" disabled={props.disabled} onClick={submit}>Continue session</button>
      </div>
    </div>
  );
}
