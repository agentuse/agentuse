import type { ChangesetRecord } from '../../../../agents/changeset-types';
import { DraftComposer } from './draft-panel';

/** Failed authoring turns can continue through the same change-request API. */
export function ChangesetComposer(props: {
  changeset: Pick<ChangesetRecord, 'status' | 'pendingRequest' | 'instruction'>;
  busy: boolean;
  onSend: (request: string) => Promise<boolean>;
}) {
  const { changeset, busy, onSend } = props;
  const failed = changeset.status === 'error';
  const running = changeset.status === 'running';
  if (!failed && !running && changeset.status !== 'proposed' && changeset.status !== 'no-change') return null;
  const retryRequest = changeset.pendingRequest?.trim() || changeset.instruction.trim();

  return (
    <>
      {failed && (
        <div class="changeset-decision">
          <p class="changeset-decision-note" role="status">
            The author stopped before completing this request. Retry it or send updated instructions below. Your conversation and staged files are kept.
          </p>
          <button
            type="button"
            class="draft-primary"
            disabled={busy || !retryRequest}
            aria-busy={busy}
            onClick={() => { if (!busy && retryRequest) void onSend(retryRequest); }}
          >
            {busy ? 'Retrying…' : 'Retry'}
          </button>
        </div>
      )}
      <DraftComposer
        placeholder="Tell the author what to change in this proposal…"
        hint="to send · same session, keeps context"
        busy={busy || running}
        onSend={onSend}
      />
    </>
  );
}
