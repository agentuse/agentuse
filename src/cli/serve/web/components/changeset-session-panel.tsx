import { useEffect, useState } from 'preact/hooks';
import type { ChangesetRecord } from '../../../../agents/changeset-types';
import { fetchChangeset } from '../lib/api';
import { changesetReviewHref } from '../lib/changeset-view';
import { changesetCountLine, changesetEntry, changesetStatusLabel } from '../lib/changeset-entry';

/**
 * The banner an internal creator or reviser session shows above its log.
 *
 * A changeset is keyed by the session that authored it, so the session page can
 * ask for one by its own id: a hit means this session is internal and its work
 * is reviewed on the changeset page, a 404 means it is an ordinary run. The
 * review itself deliberately lives on that page only, so the diff and the Apply
 * actions cannot drift into a second copy here.
 */
export function ChangesetSessionPanel(props: {
  sessionId: string;
  project?: string | undefined;
  token?: string | undefined;
  sessionStatus: string;
  onDetected?: ((changeset: ChangesetRecord) => void) | undefined;
}) {
  const [changeset, setChangeset] = useState<ChangesetRecord | null>(null);

  useEffect(() => {
    if (!props.project || !props.sessionId) return;
    let cancelled = false;
    const load = async () => {
      try {
        const payload = await fetchChangeset(props.project!, props.sessionId);
        if (cancelled) return;
        setChangeset(payload.changeset);
        props.onDetected?.(payload.changeset);
      } catch {
        // An ordinary run has no changeset. Nothing to say.
      }
    };
    void load();
    return () => { cancelled = true; };
  }, [props.sessionId, props.project]);

  useEffect(() => {
    if (!changeset || changeset.status !== 'running' || !props.project) return;
    const timer = setInterval(() => {
      void fetchChangeset(props.project!, props.sessionId)
        .then((payload) => setChangeset(payload.changeset))
        .catch(() => undefined);
    }, 1200);
    return () => clearInterval(timer);
  }, [changeset?.sessionId, changeset?.status, props.project]);

  if (!changeset) return null;
  const entry = changesetEntry(changeset);
  const counts = changesetCountLine(entry);
  const reviewable = changeset.status === 'proposed' || changeset.status === 'no-change';

  return (
    <section class={`agent-revision-session-panel is-${changeset.status}`}>
      <div class="agent-revision-session-head">
        <span>
          <strong>{changeset.mode === 'create' ? 'Creating an agent' : `Revising ${changeset.target?.name ?? 'an agent'}`}</strong>
          <small>{changesetStatusLabel(changeset.status)}{counts ? ` · ${counts}` : ''}</small>
        </span>
        <span class="agent-revision-state">{changeset.status}</span>
      </div>
      {changeset.status === 'running' && props.sessionStatus === 'preparing' && (
        <p>AgentUse is preparing a safe project view. The session will start automatically when its context is ready.</p>
      )}
      {changeset.status === 'running' && props.sessionStatus === 'waiting' && (
        <p>This session needs your decision below. Answering resumes the same internal session.</p>
      )}
      {changeset.status === 'running' && props.sessionStatus !== 'preparing' && props.sessionStatus !== 'waiting' && (
        <p>AgentUse is writing the files for this change. You can leave; the changes stay available from the agent page and Sessions.</p>
      )}
      {reviewable && (
        <div class="agent-revision-review-actions">
          <a class="agent-revision-primary" href={changesetReviewHref(changeset.projectId, changeset.sessionId, props.token)}>
            {changeset.status === 'proposed' ? 'Review these changes' : 'Review the diagnosis'}
          </a>
        </div>
      )}
    </section>
  );
}
