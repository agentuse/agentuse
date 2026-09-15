import { useEffect, useState } from 'preact/hooks';
import { LogContent } from './content';
import { loadRevisionSessionContext, revisionContextLoadError, revisionSessionSummary } from '../lib/revision-session-context';

type ContextState = { status: 'loading' } | { status: 'ready'; transcript: string } | { status: 'error'; message: string };

export function RevisionSessionContext(props: {
  projectId: string;
  sessionId: string;
  transcript?: string | undefined;
  originHref?: string | undefined;
}) {
  const [state, setState] = useState<ContextState>({ status: 'loading' });
  const [retry, setRetry] = useState(0);
  const saved = props.transcript?.trim();

  useEffect(() => {
    if (saved) return;
    let cancelled = false;
    setState({ status: 'loading' });
    void loadRevisionSessionContext(props.projectId, props.sessionId, props.originHref)
      .then((transcript) => { if (!cancelled) setState({ status: 'ready', transcript }); })
      .catch((error: unknown) => { if (!cancelled) setState({ status: 'error', message: revisionContextLoadError(error) }); });
    return () => { cancelled = true; };
  }, [props.projectId, props.sessionId, props.originHref, saved, retry]);

  const transcript = saved || (state.status === 'ready' ? state.transcript : undefined);
  const summary = transcript ? revisionSessionSummary(transcript) : undefined;
  const href = props.originHref ?? `/sessions/${encodeURIComponent(props.sessionId)}?${new URLSearchParams({ project: props.projectId })}`;

  return (
    <>
      <div class="changeset-context-meta">
        <span class="draft-meta-key">Original session</span>
        <a class="changeset-context-session" href={href} title="Open the original session">{props.sessionId}</a>
      </div>
      {summary ? (
        <LogContent value={`**${summary.label}**\n\n${summary.message}`} forceMarkdown />
      ) : (
        <div role="status">
          <LogContent value={state.status === 'error' ? state.message : 'Loading the original session…'} forceMarkdown />
          {state.status === 'error' && (
            <div class="changeset-context-actions">
              <button type="button" class="draft-secondary" onClick={() => setRetry((value) => value + 1)}>Try again</button>
            </div>
          )}
        </div>
      )}
    </>
  );
}
