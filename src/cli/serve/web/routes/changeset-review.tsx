import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation, useRoute } from 'preact-iso';
import type { ChangesetRecord } from '../../../../agents/changeset-types';
import {
  fetchChangeset,
  postChangesetAction,
  requestChangesetChanges,
  restoreChangeset,
  startChangesetTestRun,
  type ChangesetSkippedFile,
} from '../lib/api';
import { useSessionLog } from '../hooks/use-session-log';
import { useTitle } from '../hooks/use-title';
import { Loading } from '../components/loading';
import { CopyButton } from '../components/copy-button';
import { DraftUsageLine } from '../components/token-usage-strip';
import { DraftComposer, DraftStatusPill } from '../components/draft-panel';
import { DraftAnswerComposer, pendingDraftQuestion } from '../components/draft-answer-composer';
import { DraftThread } from '../components/draft-thread';
import { ChangesetFileList } from '../components/changeset-file-list';
import { ChangesetFileView, type ChangesetFileTab } from '../components/changeset-file-view';
import { changesetNeedsFileReview } from '../lib/changeset-view';
import { agentDetailHref } from '../lib/links';
import { pageTitle } from '../lib/brand';

/**
 * Reviewing a changeset: one page for both create and revise.
 *
 * A changeset is a set of files that lands all at once, so the page is built
 * around the set rather than around one file. The left rail says what is in the
 * set and where the surprises are, the main pane opens one file at a time, and
 * the thread underneath keeps the conversation that produced it. Nothing
 * reaches the project until the operator presses Apply.
 */

const POLL_MS = 1200;

/** Statuses where the operator can still steer this changeset. */
const OPEN_STATUSES = new Set(['running', 'proposed', 'no-change']);

type BusyAction = 'apply' | 'discard' | 'restore' | 'cancel' | 'request' | 'test';

/** The two halves of the review: the conversation, and the files it produced. */
type ChangesetTab = 'changes' | 'files';

export default function ChangesetReview() {
  const location = useLocation();
  const { params } = useRoute();
  const projectId = decodeURIComponent(params.projectId ?? '');
  const sessionId = decodeURIComponent(params.sessionId ?? '');
  const token = location.query.token || undefined;

  const [changeset, setChangeset] = useState<ChangesetRecord | null>(null);
  const [sessionToken, setSessionToken] = useState<string | undefined>(undefined);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<BusyAction | null>(null);
  const [selectedPath, setSelectedPath] = useState<string | undefined>(undefined);
  const [fileTab, setFileTab] = useState<ChangesetFileTab>('diff');
  const [tab, setTab] = useState<ChangesetTab>('changes');
  // The reviewer picked a tab; stop steering it for them.
  const [tabPinned, setTabPinned] = useState(false);
  // Replies that landed while the reviewer was reading files, so Changes can
  // say there is something new without stealing the tab.
  const [seenReplies, setSeenReplies] = useState(0);
  const [diagnosisOpen, setDiagnosisOpen] = useState(false);
  const [skipped, setSkipped] = useState<ChangesetSkippedFile[] | null>(null);
  // The Test run gate: a proposal carrying a runnable script is only testable
  // once the reviewer has opened a file, so the script cannot run unseen.
  const [openedAFile, setOpenedAFile] = useState(false);
  const [pricing, setPricing] = useState<typeof import('../lib/pricing') | null>(null);

  useEffect(() => {
    let cancelled = false;
    void import('../lib/pricing').then((mod) => { if (!cancelled) setPricing(mod); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useTitle(pageTitle('Agents', changeset?.target?.name ?? 'Changes', 'Review'));

  const refresh = async () => {
    try {
      const payload = await fetchChangeset(projectId, sessionId);
      setChangeset(payload.changeset);
      if (payload.sessionToken) setSessionToken(payload.sessionToken);
      setLoadError(null);
    } catch (caught) {
      setLoadError((caught as Error).message || 'Could not load this changeset.');
    }
  };

  useEffect(() => {
    if (!projectId || !sessionId) {
      setLoadError('This link is missing its project or changeset.');
      return;
    }
    void refresh();
  }, [projectId, sessionId]);

  // Poll only while the author is working; a settled changeset is idle and the
  // page stops touching the daemon until the operator asks for something.
  useEffect(() => {
    if (!changeset || changeset.status !== 'running') return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [changeset?.sessionId, changeset?.status]);

  const authorSession = useSessionLog({
    sessionId,
    token: sessionToken ?? token,
    project: projectId,
    enabled: Boolean(sessionId && projectId),
  });

  const proposal = changeset?.proposals[changeset.proposals.length - 1];
  const files = proposal?.files ?? [];

  // Open on the entry agent, which is the file the change is really about.
  useEffect(() => {
    if (!proposal || files.length === 0) return;
    if (selectedPath && files.some((file) => file.path === selectedPath)) return;
    const entry = proposal.entry ? files.find((file) => file.path === proposal.entry) : undefined;
    setSelectedPath((entry ?? files.find((file) => file.kind === 'agent') ?? files[0]!).path);
  }, [proposal?.index, files.length]);

  const selectedFile = useMemo(
    () => files.find((file) => file.path === selectedPath),
    [files, selectedPath],
  );

  // This page is a workspace, not a document: it claims the space the shell has
  // left and scrolls inside itself, so the composer can stay pinned to the
  // bottom of the viewport. The flag turns the whole chain above it into
  // height-constrained flex boxes for as long as this page is mounted.
  useEffect(() => {
    document.documentElement.setAttribute('data-page', 'draft-panel');
    return () => document.documentElement.removeAttribute('data-page');
  }, []);

  const replyCount = (changeset?.exchange ?? []).filter((turn) => turn.reply).length;

  // Files is the default the moment there is something to look at; while the
  // author is still working, the conversation is the only thing there is.
  useEffect(() => {
    if (tabPinned || !changeset) return;
    setTab(changeset.status !== 'running' && files.length > 0 ? 'files' : 'changes');
  }, [tabPinned, changeset?.status, files.length]);

  // Reading the thread clears the "new reply" badge.
  useEffect(() => {
    if (tab === 'changes') setSeenReplies(replyCount);
  }, [tab, replyCount]);

  if (loadError) {
    return <div class="page-draft"><main><p class="empty" role="alert">{loadError}</p></main></div>;
  }
  if (!changeset) return <Loading label="Loading changes" />;

  const question = pendingDraftQuestion(authorSession.entries, authorSession.approval, authorSession.status);
  const running = changeset.status === 'running';
  const open = OPEN_STATUSES.has(changeset.status);
  const needsReview = changesetNeedsFileReview(proposal);
  const testBlocked = needsReview && !openedAFile;

  const act = async (action: 'apply' | 'discard' | 'cancel') => {
    setBusy(action);
    setActionError(null);
    try {
      const payload = await postChangesetAction(projectId, sessionId, action);
      setChangeset(payload.changeset);
      if (action === 'apply') {
        const entry = proposal?.entry ?? changeset.target?.path;
        if (entry) location.route(agentDetailHref(projectId, entry, { tab: 'source' }));
      }
      if (action === 'discard' && changeset.status === 'no-change') {
        location.route(`/agents/${encodeURIComponent(projectId)}`);
      }
    } catch (caught) {
      setActionError((caught as Error).message || `Could not ${action} these changes.`);
    } finally {
      setBusy(null);
    }
  };

  const restore = async () => {
    setBusy('restore');
    setActionError(null);
    try {
      const payload = await restoreChangeset(projectId, sessionId);
      setChangeset(payload.changeset);
      setSkipped(payload.skipped ?? []);
    } catch (caught) {
      setActionError((caught as Error).message || 'Could not restore these files.');
    } finally {
      setBusy(null);
    }
  };

  const testRun = async () => {
    setBusy('test');
    setActionError(null);
    try {
      const payload = await startChangesetTestRun(projectId, sessionId);
      const query = new URLSearchParams({ project: projectId });
      if (payload.testRun.sessionToken) query.set('token', payload.testRun.sessionToken);
      location.route(`/sessions/${encodeURIComponent(payload.testRun.sessionId)}?${query.toString()}`);
    } catch (caught) {
      setActionError((caught as Error).message || 'Could not start a test run.');
    } finally {
      setBusy(null);
    }
  };

  const requestChange = async (request: string) => {
    setBusy('request');
    setActionError(null);
    try {
      await requestChangesetChanges(projectId, sessionId, request);
      // The answer arrives in the thread, so go where it will show up.
      setTabPinned(true);
      setTab('changes');
      await refresh();
    } catch (caught) {
      setActionError((caught as Error).message || 'Could not send that change request.');
    } finally {
      setBusy(null);
    }
  };

  const selectFile = (path: string) => {
    setOpenedAFile(true);
    setSelectedPath(path);
  };

  const selectTab = (next: ChangesetTab) => {
    setTabPinned(true);
    setTab(next);
  };

  const sessionHref = (() => {
    const query = new URLSearchParams({ project: projectId });
    const streamToken = sessionToken ?? token;
    if (streamToken) query.set('token', streamToken);
    return `/sessions/${encodeURIComponent(sessionId)}?${query.toString()}`;
  })();

  const subject = changeset.mode === 'revise'
    ? changeset.target?.path ?? changeset.target?.name ?? 'an agent'
    : proposal?.entry ?? 'a new agent';

  // One action group in one place: the header's right end, same order in every
  // state. Test run is the quietest of the three, Apply carries the weight.
  const actions = changeset.status === 'applied'
    ? (
      <button type="button" class="draft-secondary" disabled={busy !== null} onClick={() => void restore()}>
        {busy === 'restore' ? 'Restoring…' : 'Restore'}
      </button>
    )
    : open && (
      <>
        {running && (
          <button type="button" class="draft-secondary" disabled={busy !== null} onClick={() => void act('cancel')}>
            {busy === 'cancel' ? 'Stopping…' : 'Cancel'}
          </button>
        )}
        {changeset.status === 'proposed' && (
          <>
            {/* A disabled button swallows its own hover, so the reason for the
                block sits on a wrapper that still receives it. */}
            <span
              class="changeset-action-slot"
              title={testBlocked ? 'Open a file first: this proposal includes a script the test run will execute.' : undefined}
            >
              <button
                type="button"
                class="draft-secondary"
                disabled={busy !== null || testBlocked}
                title={testBlocked ? 'Open a file first: this proposal includes a script the test run will execute.' : undefined}
                onClick={() => void testRun()}
              >
                {busy === 'test' ? 'Starting…' : 'Test run'}
              </button>
            </span>
            <button type="button" class="draft-secondary" disabled={busy !== null} onClick={() => void act('discard')}>
              {busy === 'discard' ? 'Discarding…' : 'Discard'}
            </button>
            <button type="button" class="draft-primary" disabled={busy !== null} onClick={() => void act('apply')}>
              {busy === 'apply' ? 'Applying…' : 'Apply'}
            </button>
          </>
        )}
        {changeset.status === 'no-change' && (
          <button type="button" class="draft-primary" disabled={busy !== null} onClick={() => void act('discard')}>
            {busy === 'discard' ? 'Accepting…' : 'Accept'}
          </button>
        )}
      </>
    );

  const sources = [
    ...(proposal?.externalReads ?? []).map((url) => ({ key: `url:${url}`, label: url, href: url })),
    ...(proposal?.loadedSkills ?? []).map((skill) => ({ key: `skill:${skill}`, label: skill, href: undefined })),
  ];

  return (
    <div class="page-draft page-changeset">
      <header class="draft-header">
        <div class="draft-header-row">
          <div class="draft-identity">
            <span class="changeset-mode">{changeset.mode === 'revise' ? 'Revise' : 'Create'}</span>
            <code>{subject}</code>
            <span class="draft-file-version">
              {question ? 'awaiting answer' : proposal ? `proposal ${proposal.index}` : running ? 'working…' : '—'}
            </span>
            <DraftStatusPill
              label={question ? 'Needs answer' : changeset.status}
              tone={question ? 'draft'
                : changeset.status === 'applied' || changeset.status === 'restored' ? 'done'
                : changeset.status === 'error' ? 'error'
                : running ? 'running' : 'draft'}
            />
          </div>
          {actions && (
            <div class="draft-header-actions">
              <div class="changeset-actions">{actions}</div>
            </div>
          )}
        </div>
        <div class="draft-header-row is-meta">
          <div class="draft-meta">
            <span><span class="draft-meta-key">Project</span> {changeset.projectId}</span>
            <span><span class="draft-meta-key">Files</span> {files.length}</span>
            <span><span class="draft-meta-key">Model</span> {changeset.authoringModel}</span>
            <span class="changeset-session-id">
              <span class="draft-meta-key">Session</span>{' '}
              <a class="draft-quiet-link" href={sessionHref} title="Open the full session log">{sessionId}</a>
              <CopyButton text={sessionId} label="session id" />
            </span>
          </div>
          <DraftUsageLine
            tokenUsage={authorSession.approval?.tokenUsage}
            estimatedCost={pricing && authorSession.approval
              ? pricing.estimateSessionCostUsd(authorSession.approval.model, authorSession.approval.tokenUsage)
              : undefined}
            formatUsd={pricing?.formatUsd}
          />
        </div>
        {authorSession.status === 'waiting' && !question && (
          <p class="draft-waiting" role="status">
            This session is waiting for an answer. <a href={sessionHref}>Open full session log</a>
          </p>
        )}
        {skipped && (
          <p class="draft-waiting" role="status">
            {skipped.length === 0
              ? 'Every file was restored.'
              : `Kept as they are, edited since Apply: ${skipped.map((file) => `${file.path} (${file.reason})`).join('; ')}`}
          </p>
        )}
      </header>

      <div class="draft-tabs" role="tablist" aria-label="Changeset view">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'changes'}
          class={tab === 'changes' ? 'is-active' : ''}
          onClick={() => selectTab('changes')}
        >
          Changes
          {running && !question
            ? <span class="draft-tab-dot" aria-label="running" />
            : replyCount > seenReplies
              ? <span class="draft-tab-badge" aria-label="new reply">new</span>
              : null}
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'files'}
          class={tab === 'files' ? 'is-active' : ''}
          onClick={() => selectTab('files')}
        >
          Files
          {files.length > 0 && <span class="draft-tab-badge">{files.length}</span>}
        </button>
      </div>

      <div class={`draft-file-scroll${tab === 'changes' ? ' is-changes' : ''}`}>
        {tab === 'changes' ? (
          <DraftThread
            turns={changeset.exchange ?? []}
            entries={authorSession.entries}
            approval={authorSession.approval}
            status={authorSession.status}
            running={running && !question}
            sessionId={sessionId}
            projectId={projectId}
            token={sessionToken ?? token}
            leadRequest={changeset.instruction}
            emptyHint="The author is working. Its steps appear here as it goes."
          />
        ) : (
      <div class="changeset-body">
        <div class="changeset-rail">
          <ChangesetFileList files={files} selected={selectedPath} onSelect={selectFile} />
        </div>
        <div class="changeset-main">
          {proposal?.reply && <p class="changeset-summary">{proposal.reply}</p>}
          {proposal?.diagnosis && (
            <div class={`changeset-diagnosis${diagnosisOpen ? ' is-open' : ''}`}>
              <button
                type="button"
                class="changeset-diagnosis-summary"
                aria-expanded={diagnosisOpen}
                onClick={() => setDiagnosisOpen((value) => !value)}
              >
                <span aria-hidden="true">{diagnosisOpen ? '▾' : '▸'}</span> Diagnosis
              </button>
              {diagnosisOpen && <p class="changeset-diagnosis-body">{proposal.diagnosis}</p>}
            </div>
          )}
          {sources.length > 0 && (
            <div class="changeset-sources">
              <span class="changeset-sources-label">Sources this proposal used</span>
              <ul>
                {sources.map((source) => (
                  <li key={source.key}>
                    {source.href
                      ? <a href={source.href} rel="noreferrer noopener" target="_blank">{source.label}</a>
                      : <code>{source.label}</code>}
                  </li>
                ))}
              </ul>
            </div>
          )}

          {selectedFile
            ? <ChangesetFileView file={selectedFile} tab={fileTab} onTab={setFileTab} />
            : <p class="empty">{running ? 'The author is working. Files appear here as they are written.' : 'This changeset proposes no file changes.'}</p>}
        </div>
      </div>
        )}
      </div>

      {actionError || authorSession.streamError || changeset.error?.message
        ? <p class="draft-error" role="alert">{actionError ?? authorSession.streamError ?? changeset.error?.message}</p>
        : null}

      {question ? (
        <DraftAnswerComposer
          key={`${sessionId}:${question.details?.resumeToken}`}
          entry={question}
          sessionId={sessionId}
          projectId={projectId}
          token={sessionToken ?? token}
          onAnswered={authorSession.onAnswered}
          onShowContext={() => selectTab('changes')}
        />
      ) : open && (
        <DraftComposer
          placeholder="Tell the author what to change in this proposal…"
          hint="to send · same session, keeps context"
          busy={busy === 'request' || running}
          onSend={requestChange}
        />
      )}
    </div>
  );
}
