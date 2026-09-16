import { useRef, useState } from 'preact/hooks';
import { noAutofill } from '../lib/form';
import { Modal } from './modal';

export type DecisionDialogMode = 'comment' | 'reject';

const COPY: Record<DecisionDialogMode, {
  title: string;
  body?: string;
  placeholder: string;
  /** Rendered under the textarea: what to write and why it matters. Rejecting
   *  in silence is the common case and the expensive one - the run is discarded
   *  and the agent gets no signal, so the next run reproduces the same draft.
   *  The hint lowers the bar deliberately: a fragment naming which part is off
   *  beats the blank box people default to when they cannot articulate it. */
  hint: string;
  submitLabel: string;
  submitClass: string;
  requireText: boolean;
}> = {
  comment: {
    title: 'Comment',
    placeholder: 'explain your decision, ask for a tweak, or send context back to the agent',
    hint: 'Name the part to change and what it should be instead. The agent applies your comment literally, so a specific note produces a specific fix.',
    submitLabel: 'Send comment',
    submitClass: 'primary',
    requireText: true,
  },
  reject: {
    title: 'Reject this request?',
    body: 'The agent will stop this approval flow and apply any configured rejected-state updates.',
    placeholder: 'optional: which part is wrong is enough - the source, a fact, the angle, the tone',
    hint: 'This is the only thing the agent learns from. Reject in silence and the next run drafts the same way. It does not have to be articulate: naming which part is off is enough, and even "cannot say, just wrong" tells it more than nothing.',
    submitLabel: 'Reject',
    submitClass: 'danger',
    requireText: false,
  },
};

export function DecisionDialog(props: {
  open: boolean;
  mode: DecisionDialogMode;
  /** Label of the option currently picked on a pick gate, when there is one.
   *  The server accepts `choice` only alongside an approve — that contract is
   *  what lets the agent trust "approved implies a known id" — so a comment
   *  about one candidate has nowhere structured to put it and the reviewer
   *  ends up typing "the second one, but…" and hoping. Naming the option in
   *  the comment text is the part the agent can actually act on. */
  choiceLabel?: string | undefined;
  allowRemember?: boolean;
  /** Whether a saved rule will actually be injected into future runs
   *  (learning.apply). When false, the dialog notes the rule is stored but
   *  inert until learning.apply is enabled. */
  rememberApplies?: boolean;
  /** Strict automated review exhausted, so this dialog guides a revision or stops the action. */
  revisionGuidance?: boolean;
  onSubmit: (payload: { comment?: string; remember?: string }) => void;
  onClose: () => void;
}) {
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const [rememberChecked, setRememberChecked] = useState(false);
  // Default on: the reviewer opened this dialog while a candidate was picked,
  // so the note is about that candidate until they say otherwise. A checkbox
  // rather than a silent prefix, because feedback on the gate as a whole is a
  // real case and rewriting someone's words without showing them is not.
  const [aboutChoice, setAboutChoice] = useState(true);
  const copy = props.revisionGuidance
    ? props.mode === 'comment'
      ? {
          ...COPY.comment,
          title: 'Guide revision',
          placeholder: 'tell the agent what to change, remove, verify, or try instead',
          hint: 'Your earlier feedback is preserved. Add only what the next revision needs to resolve the automated review objection.',
          submitLabel: 'Revise again',
        }
      : {
          ...COPY.reject,
          title: 'Stop this action?',
          body: 'The blocked draft will not be published. The agent will record that you stopped this approval flow.',
          submitLabel: 'Stop action',
        }
    : COPY[props.mode];

  const submit = () => {
    const raw = (inputRef.current?.value ?? '').trim();
    if (copy.requireText && !raw) {
      inputRef.current?.focus();
      return;
    }
    // Scoped to the candidate the reviewer had picked. The agent reads the
    // comment literally, so the option has to be named in the text itself —
    // there is no structured field for it on a non-approve decision.
    const text = props.choiceLabel && aboutChoice && raw
      ? `About option "${props.choiceLabel}": ${raw}`
      : raw;
    // Ticking the box saves the comment itself as a durable instruction; the
    // server distills it into a grounded instruction. No separate field — comment
    // mode already requires text, so a checked box always has a comment.
    const remember = rememberChecked ? text : '';
    if (inputRef.current) inputRef.current.value = '';
    setRememberChecked(false);
    props.onSubmit({
      ...(text && { comment: text }),
      ...(remember && { remember }),
    });
  };

  return (
    <Modal
      id="decision-dialog"
      form
      open={props.open}
      onClose={props.onClose}
      title={copy.title}
      titleClass={props.mode}
      {...(copy.body ? { describedBy: 'decision-dialog-description' } : {})}
      onOpened={() => {
        if (inputRef.current) inputRef.current.value = '';
        setRememberChecked(false);
        setAboutChoice(true);
        requestAnimationFrame(() => inputRef.current?.focus());
      }}
    >
      <>
        {copy.body && <p id="decision-dialog-description" class="dialog-description">{copy.body}</p>}
        <div class="dialog-body">
          <span class="prefix">&gt;</span>
          <textarea
            id={`${props.mode}-comment`}
            ref={inputRef}
            placeholder={copy.placeholder}
            {...noAutofill}
            onKeyDown={(event) => {
              if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
                event.preventDefault();
                submit();
              }
            }}
          />
          <p class="dialog-hint">{copy.hint}</p>
          {props.choiceLabel && (
            <div class="remember-learning">
              <label class="remember-toggle">
                <input
                  type="checkbox"
                  checked={aboutChoice}
                  onChange={(event) => setAboutChoice((event.currentTarget as HTMLInputElement).checked)}
                />
                <span>This is about option “{props.choiceLabel}”</span>
              </label>
            </div>
          )}
          {props.mode === 'comment' && props.allowRemember && (
            <div class="remember-learning">
              <label class="remember-toggle">
                <input
                  type="checkbox"
                  checked={rememberChecked}
                  onChange={(event) => setRememberChecked((event.currentTarget as HTMLInputElement).checked)}
                />
                <span>Learn from this comment</span>
              </label>
              {rememberChecked && !props.rememberApplies && (
                <p class="remember-hint">
                  Saved as guidance for similar future runs. It takes effect once <code>learning.apply</code> is enabled.
                </p>
              )}
            </div>
          )}
        </div>
        <div class="dialog-foot">
          <span class="hint"><span class="kbd">⌘⏎</span> {props.mode === 'reject' ? 'reject' : 'send'} <span class="kbd">esc</span> cancel</span>
          <span class="actions">
            <button type="button" onClick={props.onClose}>Cancel</button>
            <button type="button" class={copy.submitClass} onClick={submit}>{copy.submitLabel}</button>
          </span>
        </div>
      </>
    </Modal>
  );
}
