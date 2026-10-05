import { useRef, useState } from 'preact/hooks';
import type { ApprovalLogEntry, ApprovalPageInfo } from '../../types';
import { OptionsBlock } from './log-entry';
import { InlineMarkdown } from './content';
import { DecisionDialog } from './comment-dialog';
import { postSessionDecision } from '../lib/api';
import { ApprovalFailurePanel, approvalFailureCopy, decisionRequestFailure, decisionStillPending } from './approval-failure';
import type { ApprovalActionFailure, ApprovalDecisionAction } from '../../../../session/approval-action-failure';

type KeptAnswer = { choice: string | undefined; custom: boolean; note: string; last?: { action: ApprovalDecisionAction; comment: string } };
/**
 * Answers in progress, by gate token. The composer unmounts while a sent
 * answer resumes the session; if that resume fails the gate comes back and the
 * remounted composer picks up exactly what the reviewer had.
 */
const keptAnswers = new Map<string, KeptAnswer>();

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
  /** The server's account of why the last answer on this gate did not take effect. */
  failure?: ApprovalActionFailure | undefined;
}) {
  const details = props.entry.details!;
  const gateToken = details.resumeToken ?? '';
  const kept = keptAnswers.get(gateToken);
  const [choice, setChoiceState] = useState<string | undefined>(kept?.choice);
  const [custom, setCustomState] = useState(kept?.custom ?? false);
  const [note, setNoteState] = useState(kept?.note ?? '');
  const [last, setLast] = useState<KeptAnswer['last']>(kept?.last);
  const [pending, setPending] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [requestFailure, setRequestFailure] = useState<ApprovalActionFailure | null>(null);
  const submitting = useRef(false);
  const keep = (patch: Partial<KeptAnswer>) => {
    if (gateToken) keptAnswers.set(gateToken, { ...(keptAnswers.get(gateToken) ?? { choice, custom, note }), ...patch });
  };
  const setChoice = (next: string | undefined) => { setChoiceState(next); keep({ choice: next }); };
  const setCustom = (next: boolean) => { setCustomState(next); keep({ custom: next }); };
  const setNote = (next: string) => { setNoteState(next); keep({ note: next }); };
  const failure = requestFailure ?? props.failure ?? null;
  const locked = failure ? approvalFailureCopy(failure, undefined).locksDecision : false;
  const options = details.options ?? [];
  const selected = custom ? undefined : options.some((option) => option.id === choice)
    ? choice : options.find((option) => option.recommended)?.id;
  const canSend = custom ? Boolean(note.trim()) : options.length === 0 || Boolean(selected);
  const groupName = `draft-answer-${props.entry.id}`;

  const submit = async (action: ApprovalDecisionAction, comment = note.trim()) => {
    if (submitting.current || !details.resumeToken || locked || (action !== 'reject' && !canSend)) return;
    submitting.current = true;
    setPending(true);
    setRequestFailure(null);
    setRejectOpen(false);
    setLast({ action, comment });
    keep({ last: { action, comment } });
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
      setRequestFailure(decisionRequestFailure(caught, action));
    }
  };
  const send = () => void submit(custom ? 'comment' : 'approve');
  const retry = async (previous: NonNullable<KeptAnswer['last']>) => {
    if (failure?.kind === 'unreachable') {
      const pending = await decisionStillPending(props.sessionId, props.token, props.projectId, gateToken).catch(() => null);
      if (pending === null) return;
      if (!pending) {
        setRequestFailure(null);
        props.onAnswered();
        return;
      }
    }
    void submit(previous.action, previous.comment);
  };

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
      {failure && <ApprovalFailurePanel
        key={`${failure.action}:${failure.code}:${failure.message}`}
        failure={failure}
        comment={last?.action === failure.action ? last.comment : undefined}
        onRetry={failure.retryable && last?.action === failure.action ? () => void retry(last) : undefined}
      />}
    </div>
    <div class="draft-composer-foot">
      <span class="draft-composer-hint">{custom ? 'Sends feedback without approving.' : options.length > 0 ? 'Sends and approves your selected option.' : 'Approves this request.'} <kbd>⌘⏎</kbd></span>
      <div class="draft-answer-actions">
        <button type="button" class="draft-secondary" disabled={pending || locked} onClick={() => setRejectOpen(true)}>Reject</button>
        <button type="button" class="draft-primary" disabled={!canSend || pending || locked} onClick={send}>
          {pending ? 'Sending…' : !custom && !options.length ? 'Approve' : 'Send answer'}
        </button>
      </div>
    </div>
    <DecisionDialog open={rejectOpen} mode="reject" initialText={last?.action === 'reject' ? last.comment : undefined} onClose={() => setRejectOpen(false)}
      onSubmit={({ comment }) => void submit('reject', comment ?? '')} />
  </section>;
}
