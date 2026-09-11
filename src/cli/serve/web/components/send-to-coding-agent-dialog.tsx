import { useEffect, useState } from 'preact/hooks';
import { noAutofill } from '../lib/form';
import { Modal } from './modal';
import { CopyButton } from './copy-button';


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
  title?: string;
  detailFirst?: boolean;
  detailLabel?: string;
  placeholder?: string;
  copyHint?: string;
  copyLabel?: string;
  promptCollapsed?: boolean;
  contextLabel?: string;
  contextValue?: string;
  contextHint?: string;
  initialDetail?: string;
  onCopied?: () => void;
  onClose: () => void;
}) {
  const [detail, setDetail] = useState('');
  const prompt = props.buildPrompt(detail);

  useEffect(() => {
    if (props.open) setDetail(props.initialDetail ?? '');
  }, [props.open, props.initialDetail]);


  const detailField = (
    <div class="cca-detail">
      <label for="cca-detail-input">
        {props.detailLabel ?? 'Give the agent more detail'} <span class="opt">(optional)</span>
      </label>
      <textarea
        id="cca-detail-input"
        placeholder={props.placeholder}
        value={detail}
        {...noAutofill}
        onInput={(e) => setDetail((e.target as HTMLTextAreaElement).value)}
      />
    </div>
  );

  const promptPreview = (
    <div class="cca-terminal">
      <div class="cca-chrome">
        <span class="cca-dot red" /><span class="cca-dot yellow" /><span class="cca-dot green" />
        <span class="cca-chrome-title">Coding Agent</span>
      </div>
      <pre class="cca-prompt">{prompt}</pre>
    </div>
  );

  const copyControls = (
    <>
      <CopyButton
        text={prompt}
        label={props.copyLabel ?? 'the prompt'}
        variant="button"
        class="cca-copy"
        {...(props.onCopied ? { onCopied: props.onCopied } : {})}
      >
        {props.copyLabel ?? 'Copy prompt'}
      </CopyButton>
      {props.copyHint && <p class="cca-copy-hint">{props.copyHint}</p>}
    </>
  );

  return (
    <Modal
      class="cca-dialog"
      open={props.open}
      onClose={props.onClose}
      title={props.title ?? 'send to coding agent'}
    >
      <div class="cca-body">
        {props.contextValue && (
          <div class="cca-context">
            <span>{props.contextLabel ?? 'Project'}</span>
            <code>{props.contextValue}</code>
            {props.contextHint && <small>{props.contextHint}</small>}
          </div>
        )}
        {props.detailFirst && detailField}
        {props.promptCollapsed ? (
          <>
            {copyControls}
            <details class="cca-preview">
              <summary>Preview instructions</summary>
              {promptPreview}
            </details>
          </>
        ) : (
          <>{promptPreview}{copyControls}</>
        )}
        {!props.detailFirst && detailField}
      </div>
    </Modal>
  );
}
