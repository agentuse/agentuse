import { useEffect, useRef, useState } from 'preact/hooks';
import { noAutofill } from '../lib/form';
import { fetchAgentCreationOptions } from '../lib/api';

export interface RunCustomization {
  /** One-off instruction appended to the agent's prompt; absent = none. */
  instruction?: string;
  /** Model to run on instead of the agent's own; absent = the agent's default. */
  model?: string;
}

interface ModelOption { value: string; label: string }

/**
 * Collects the one-off customizations for a run — an instruction appended to
 * the agent's prompt, a different model, or both — before kicking it off.
 * Mirrors the decision-dialog pattern (native <dialog>, ⌘⏎ submit,
 * click-backdrop / Esc to close) for consistency with the approval flow.
 *
 * Both fields are optional individually, but the run needs at least one of
 * them: with neither, the plain "Run agent" button already does the job.
 */
export function RunCustomDialog(props: {
  open: boolean;
  agentName: string;
  /** The agent's own model, shown as the "keep" option; unknown on some surfaces. */
  agentModel?: string;
  busy?: boolean;
  error?: string | null;
  onSubmit: (customization: RunCustomization) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [instruction, setInstruction] = useState('');
  const [model, setModel] = useState('');
  const [models, setModels] = useState<ModelOption[]>([]);
  const [modelsError, setModelsError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      setInstruction('');
      setModel('');
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
      requestAnimationFrame(() => inputRef.current?.focus());
    } else if (!props.open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [props.open]);

  // The model list is fetched once, on first open: it is the same catalog the
  // creator and revision dialogs use (every configured provider's models).
  useEffect(() => {
    if (!props.open || models.length > 0 || loadingModels) return;
    let cancelled = false;
    setLoadingModels(true);
    setModelsError(null);
    fetchAgentCreationOptions()
      .then((payload) => {
        if (cancelled) return;
        setModels(payload.providers.flatMap((provider) => provider.models.map((value) => ({
          value,
          label: `${provider.name} · ${value.startsWith(`${provider.id}:`) ? value.slice(provider.id.length + 1) : value}`,
        }))));
      })
      .catch((caught: Error) => { if (!cancelled) setModelsError(caught.message || 'Could not load models.'); })
      .finally(() => { if (!cancelled) setLoadingModels(false); });
    return () => { cancelled = true; };
  }, [props.open]);

  const trimmed = instruction.trim();
  // Picking the agent's own model is the same as picking nothing.
  const modelChange = model && model !== props.agentModel ? model : undefined;
  const canSubmit = !props.busy && Boolean(trimmed || modelChange);

  const submit = () => {
    if (!canSubmit) { inputRef.current?.focus(); return; }
    props.onSubmit({
      ...(trimmed ? { instruction: trimmed } : {}),
      ...(modelChange ? { model: modelChange } : {}),
    });
  };

  const keepLabel = props.agentModel ? `Agent default · ${props.agentModel}` : 'Agent default';

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
          <span id="run-dialog-title" class="title">run with custom</span>
          <button type="button" class="dialog-close" aria-label="Close" onClick={props.onClose}>×</button>
        </div>
        <p id="run-dialog-description" class="dialog-description">
          Applies to <strong>{props.agentName}</strong> for this run only. Leave a field alone to keep the agent's default.
        </p>
        <div class="dialog-body run-custom-body">
          <label class="run-custom-label" for="run-instruction">Instruction</label>
          <div class="run-custom-field">
            <span class="prefix">&gt;</span>
            <textarea
              id="run-instruction"
              ref={inputRef}
              value={instruction}
              placeholder="e.g. focus on the EU region this time and skip the email step"
              disabled={props.busy}
              {...noAutofill}
              onInput={(event) => setInstruction((event.target as HTMLTextAreaElement).value)}
              onKeyDown={(event) => {
                if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                  event.preventDefault();
                  submit();
                }
              }}
            />
          </div>
          <label class="run-custom-label" for="run-model">Model</label>
          <select
            id="run-model"
            class="run-custom-select"
            value={model}
            disabled={props.busy || loadingModels}
            onChange={(event) => setModel((event.target as HTMLSelectElement).value)}
          >
            <option value="">{loadingModels ? 'Loading models…' : keepLabel}</option>
            {models.map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
          </select>
          {modelsError && <p class="dialog-hint run-custom-models-error" role="alert">{modelsError}</p>}
        </div>
        {props.error && <p class="dialog-error">{props.error}</p>}
        <div class="dialog-foot">
          <span class="hint"><span class="kbd">⌘⏎</span> run <span class="kbd">esc</span> cancel</span>
          <span class="actions">
            <button type="button" onClick={props.onClose}>Cancel</button>
            <button type="button" class={`primary${props.busy ? ' btn-busy' : ''}`} disabled={!canSubmit} aria-busy={props.busy} onClick={submit}>
              {props.busy ? <><span class="btn-spinner" aria-hidden="true" />Starting…</> : 'Run agent'}
            </button>
          </span>
        </div>
      </form>
    </dialog>
  );
}
