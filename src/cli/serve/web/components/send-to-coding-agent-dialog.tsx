import { useEffect, useRef, useState } from 'preact/hooks';

async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * A ready-to-paste prompt for handing work to a coding agent (Claude Code,
 * Codex, …), shown in a terminal-styled preview with a copy button and an
 * optional "more detail" note. The caller owns the prompt via `buildPrompt`,
 * which is re-run live as the operator types so the preview always reflects
 * what Copy will produce. Reused by the agent hub (source → implement) and the
 * session view (run → debug).
 */
export function SendToCodingAgentDialog(props: {
  open: boolean;
  buildPrompt: (detail: string) => string;
  detailLabel?: string;
  placeholder?: string;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [detail, setDetail] = useState('');
  const [copied, setCopied] = useState(false);
  const prompt = props.buildPrompt(detail);

  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (props.open && !dialog.open) {
      if (typeof dialog.showModal === 'function') dialog.showModal();
      else dialog.setAttribute('open', '');
    } else if (!props.open && dialog.open) {
      if (typeof dialog.close === 'function') dialog.close();
      else dialog.removeAttribute('open');
    }
  }, [props.open]);

  const copy = () => {
    void copyText(prompt).then((ok) => {
      if (!ok) return;
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <dialog
      class="cca-dialog"
      ref={dialogRef}
      aria-labelledby="cca-title"
      onClick={(event) => { if (event.target === dialogRef.current) props.onClose(); }}
      onClose={props.onClose}
    >
      <div class="dialog-head">
        <span id="cca-title" class="title">send to coding agent</span>
        <button type="button" class="dialog-close" aria-label="Close" onClick={props.onClose}>×</button>
      </div>
      <div class="cca-body">
        <div class="cca-terminal">
          <div class="cca-chrome">
            <span class="cca-dot red" /><span class="cca-dot yellow" /><span class="cca-dot green" />
            <span class="cca-chrome-title">Coding Agent</span>
          </div>
          <pre class="cca-prompt">{prompt}</pre>
        </div>
        <button type="button" class="cca-copy" onClick={copy}>
          <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
            <path d="M5.5 1.5A1.5 1.5 0 0 0 4 3v8a1.5 1.5 0 0 0 1.5 1.5h6A1.5 1.5 0 0 0 13 11V5.62a1.5 1.5 0 0 0-.44-1.06l-2.12-2.12a1.5 1.5 0 0 0-1.06-.44H5.5Z" /><path d="M2.5 4.5A1.5 1.5 0 0 0 1 6v8A1.5 1.5 0 0 0 2.5 15.5h6A1.5 1.5 0 0 0 10 14h-6a.5.5 0 0 1-.5-.5V4.5h-1Z" opacity="0.55" />
          </svg>
          {copied ? 'Copied' : 'Copy prompt'}
        </button>
        <div class="cca-detail">
          <label for="cca-detail-input">
            {props.detailLabel ?? 'Give the agent more detail'} <span class="opt">(optional)</span>
          </label>
          <textarea
            id="cca-detail-input"
            placeholder={props.placeholder}
            value={detail}
            onInput={(e) => setDetail((e.target as HTMLTextAreaElement).value)}
          />
        </div>
      </div>
    </dialog>
  );
}
