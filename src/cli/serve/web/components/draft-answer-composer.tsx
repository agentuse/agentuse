import { useRef, useState } from 'preact/hooks';
import type { ApprovalLogEntry, ApprovalPageInfo } from '../../types';
import { OptionsBlock } from './log-entry';
import { InlineMarkdown } from './content';
import { DecisionDialog } from './comment-dialog';
import { postSessionDecision } from '../lib/api';

export function isDraftApprovalActionable(entry: ApprovalLogEntry, approval?: Omit<ApprovalPageInfo, 'logs'> | null, status?: string): boolean {
  return status === 'waiting' && !approval?.viewOnly && Boolean(approval?.currentResumeToken)
    && (entry.type === 'approval' || entry.tool === 'await_human') && entry.status === 'pending'
    && entry.details?.resumeToken === approval?.currentResumeToken;
}

export function pendingDraftQuestion(entries: ApprovalLogEntry[], approval: Omit<ApprovalPageInfo, 'logs'> | null, status: string): ApprovalLogEntry | undefined {
  return [...entries].reverse().find((entry) => isDraftApprovalActionable(entry, approval, status));
}

/** Mounted by gate token, outside the tabs, so selections survive browsing evidence. */
export function DraftAnswerComposer(props: {
  entry: ApprovalLogEntry;
  sessionId: string;
  projectId: string | undefined;
  token: string | undefined;
  onAnswered: () => void;
  onShowContext: () => void;
}) {
  const [choice, setChoice] = useState<string | undefined>(undefined);
  const [custom, setCustom] = useState(false);
  const [note, setNote] = useState('');
  const [pending, setPending] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submitting = useRef(false);
  const details = props.entry.details!;
  const options = details.options ?? [];
  const selected = custom ? undefined : options.some((option) => option.id === choice)
    ? choice : options.find((option) => option.recommended)?.id;
  const canSend = custom ? Boolean(note.trim()) : options.length === 0 || Boolean(selected);
  const groupName = `draft-answer-${props.entry.id}`;

  const submit = async (action: 'approve' | 'comment' | 'reject', comment = note.trim()) => {
    if (submitting.current || !details.resumeToken || (action !== 'reject' && !canSend)) return;
    submitting.current = true;
    setPending(true);
    setError(null);
    setRejectOpen(false);
    try {
      await postSessionDecision(props.sessionId, props.token, {
        status: action,
        resumeToken: details.resumeToken,
        ...(props.projectId && { project: props.projectId }),
        ...(comment && { comment }),
        ...(action === 'approve' && selected && { choice: selected }),
      });
      props.onAnswered();
    } catch (caught) {
      submitting.current = false;
      setPending(false);
      setError((caught as Error).message || 'Could not send your answer. Try again.');
    }
  };
  const send = () => void submit(custom ? 'comment' : 'approve');

  return <section class="draft-composer draft-answer" aria-labelledby="draft-answer-title" aria-busy={pending}
    onKeyDown={(event) => {
      if (event.key === 'Enter' && (event.metaKey || event.ctrlKey) && !rejectOpen) {
        event.preventDefault();
        send();
      }
    }}>
    <div class="draft-answer-heading">
      <span class="draft-composer-label">Answer to continue</span>
      <button type="button" class="draft-answer-context" onClick={props.onShowContext}>View context</button>
    </div>
    <div class="draft-answer-body">
      <h3 id="draft-answer-title"><InlineMarkdown value={details.prompt || details.summary || 'How would you like to proceed?'} /></h3>
      {options.length > 0 && <OptionsBlock groupName={groupName} options={options}
        changes={(details.changes ?? []).filter((change) => Boolean(change.optionId))}
        selected={selected} disabled={pending}
        onSelect={(id) => { setChoice(id); setCustom(false); }} />}
      <label class={`draft-answer-custom${custom ? ' is-selected' : ''}`}>
        <input type="radio" name={groupName} checked={custom} disabled={pending} onChange={() => setCustom(true)} />
        {options.length > 0 ? 'Write a different answer' : 'Reply with feedback'}
      </label>
      {!options.length && custom && <button type="button" class="draft-answer-context" disabled={pending} onClick={() => setCustom(false)}>Approve this request instead</button>}
      <label class="draft-answer-note" for="draft-answer-note">{custom ? 'Your answer' : 'Add a note (optional)'}</label>
      <textarea id="draft-answer-note" value={note} rows={2} disabled={pending}
        placeholder={custom ? 'Tell the agent what you would like instead…' : 'Anything else the agent should know…'}
        onInput={(event) => setNote(event.currentTarget.value)} />
      {error && <p class="draft-answer-error" role="alert">{error}</p>}
    </div>
    <div class="draft-composer-foot">
      <span class="draft-composer-hint">{custom ? 'Sends feedback without approving.' : options.length > 0 ? 'Sends and approves your selected option.' : 'Approves this request.'} <kbd>⌘⏎</kbd></span>
      <div class="draft-answer-actions">
        <button type="button" class="draft-secondary" disabled={pending} onClick={() => setRejectOpen(true)}>Reject</button>
        <button type="button" class="draft-primary" disabled={!canSend || pending} onClick={send}>
          {pending ? 'Sending…' : !custom && !options.length ? 'Approve' : 'Send answer'}
        </button>
      </div>
    </div>
    <DecisionDialog open={rejectOpen} mode="reject" onClose={() => setRejectOpen(false)}
      onSubmit={({ comment }) => void submit('reject', comment ?? '')} />
  </section>;
}
