import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import {
  discardAgentDraft,
  fetchAgentDraft,
  requestAgentDraftChanges,
  saveAgentDraft,
  startAgentDraftTestRun,
  type AgentDraftPayload,
} from '../lib/api';
import { useSessionLog } from '../hooks/use-session-log';
import { useTitle } from '../hooks/use-title';
import { Loading } from '../components/loading';
import { DraftUsageLine } from '../components/token-usage-strip';
import {
  DraftComposer,
  DraftPanel,
  DraftStatusPill,
  diffChangeCounts,
  type DraftFileTab,
} from '../components/draft-panel';
import { DraftTestRun } from '../components/draft-test-run';
import { DraftThread } from '../components/draft-thread';
import { revisionLineDiff } from '../lib/revision-diff';
import { agentDetailHref } from '../lib/links';
import { pageTitle } from '../lib/brand';

const POLL_MS = 1200;

export default function AgentDraft() {
  const location = useLocation();
  const project = location.query.project ?? '';
  const jobId = location.query.job ?? '';

  const [draft, setDraft] = useState<AgentDraftPayload | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'save' | 'discard' | 'request' | 'test' | null>(null);
  const [tab, setTab] = useState<DraftFileTab>('changes');
  // The operator picked a tab; stop steering it for them.
  const [tabPinned, setTabPinned] = useState(false);
  const [testSession, setTestSession] = useState<{ sessionId: string; sessionToken?: string; draftIndex: number } | null>(null);
  // The models.dev pricing registry is large generated data, so it loads on
  // demand exactly as the session page does.
  const [pricing, setPricing] = useState<typeof import('../lib/pricing') | null>(null);
  useEffect(() => {
    let cancelled = false;
    void import('../lib/pricing').then((mod) => { if (!cancelled) setPricing(mod); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  useTitle(pageTitle('Agents', 'New agent', 'Draft'));

  const refresh = async () => {
    try {
      const payload = await fetchAgentDraft(jobId, project);
      setDraft(payload.draft);
      setLoadError(null);
      return payload.draft;
    } catch (caught) {
      setLoadError((caught as Error).message || 'Could not load this draft.');
      return null;
    }
  };

  useEffect(() => {
    if (!project || !jobId) {
      setLoadError('This link is missing its project or draft.');
      return;
    }
    void refresh();
  }, [project, jobId]);

  // Poll only while the creator is working. A drafted record is idle, so the
  // page stops touching the daemon until the operator asks for something.
  useEffect(() => {
    if (!draft || draft.status !== 'running') return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [draft?.jobId, draft?.status]);

  // The panel outlives any single creator turn, so it follows the session log
  // directly rather than a job that settles after the first draft.
  const creatorSession = useSessionLog({
    sessionId: draft?.jobId ?? '',
    token: draft?.sessionToken,
    project: draft?.projectId,
  });

  const latest = draft?.drafts[draft.drafts.length - 1];
  const previous = draft && draft.drafts.length > 1 ? draft.drafts[draft.drafts.length - 2] : undefined;

  // Changes is the default while the creator is working or once a request has
  // been answered. A first draft with nothing asked of it yet opens on the file,
  // and with nothing to diff against that means Source.
  const hasConversation = Boolean(draft?.drafts.some((entry) => entry.request));
  useEffect(() => {
    if (tabPinned || !draft) return;
    if (draft.status === 'running' || hasConversation) {
      setTab('changes');
      return;
    }
    if (latest) setTab(previous ? 'diff' : 'source');
  }, [tabPinned, draft?.status, hasConversation, latest?.index, previous?.index]);

  const changeCounts = useMemo(
    () => (latest && previous ? diffChangeCounts(revisionLineDiff(previous.source, latest.source)) : null),
    [latest?.index, previous?.index],
  );

  if (loadError) {
    return (
      <div class="page-draft">
        <main><p class="empty" role="alert">{loadError}</p></main>
      </div>
    );
  }
  if (!draft) return <Loading label="Loading draft" />;

  const running = draft.status === 'running';
  const closed = draft.status === 'saved' || draft.status === 'discarded';

  const act = async (action: 'save' | 'discard') => {
    setBusy(action);
    setActionError(null);
    try {
      if (action === 'save') {
        const payload = await saveAgentDraft(jobId, project);
        location.route(agentDetailHref(payload.agent.projectId, payload.agent.runPath, { tab: 'source' }));
        return;
      }
      await discardAgentDraft(jobId, project);
      location.route(`/agents/${encodeURIComponent(project)}`);
    } catch (caught) {
      setActionError((caught as Error).message || `Could not ${action} this draft.`);
    } finally {
      setBusy(null);
    }
  };

  const requestChange = async (prompt: string) => {
    setBusy('request');
    setActionError(null);
    try {
      await requestAgentDraftChanges(jobId, project, prompt);
      setTab('changes');
      await refresh();
    } catch (caught) {
      setActionError((caught as Error).message || 'Could not send that change request.');
    } finally {
      setBusy(null);
    }
  };

  const runTest = async () => {
    setBusy('test');
    setActionError(null);
    try {
      const payload = await startAgentDraftTestRun(jobId, project);
      setTestSession(payload.testRun);
      setTabPinned(true);
      setTab('test');
      await refresh();
    } catch (caught) {
      setActionError((caught as Error).message || 'Could not start a test run.');
    } finally {
      setBusy(null);
    }
  };

  const skillsUsed = latest?.loadedSkills ?? [];

  const meta = (
    <>
      <span><span class="draft-meta-key">Project</span> {draft.projectId}</span>
      {draft.idea?.evidence && <span><span class="draft-meta-key">Evidence</span> {draft.idea.evidence}</span>}
      <span><span class="draft-meta-key">Creator</span> {draft.authoringModel}</span>
      <span class="draft-meta-skills">
        <span class="draft-meta-key">Skills</span>
        {skillsUsed.map((skill) => <code key={skill}>{skill}</code>)}
        <span class="draft-meta-muted">
          {skillsUsed.length > 0 ? 'used · ' : 'none used · '}
          of {draft.skillCounts.project} project · {draft.skillCounts.global} global
        </span>
      </span>
    </>
  );

  return (
    <DraftPanel
      filePath={latest ? `agents/${latest.fileName}` : 'agents/…'}
      versionLabel={latest ? `draft ${latest.index}` : running ? 'drafting…' : '—'}
      pill={<DraftStatusPill
        label={draft.status === 'saved' ? 'Saved' : draft.status === 'discarded' ? 'Discarded' : draft.status === 'error' ? 'Stopped' : running ? 'Drafting' : 'Draft'}
        tone={draft.status === 'saved' ? 'done' : draft.status === 'error' ? 'error' : running ? 'running' : 'draft'}
      />}
      links={<>
        <a class="draft-quiet-link" href={`/agents/${encodeURIComponent(project)}`}>All agents</a>
        <a class="draft-quiet-link" href={draft.sessionHref}>Open full session log</a>
      </>}
      actions={!closed && (
        <>
          <button type="button" class="draft-secondary" disabled={busy !== null} onClick={() => void act('discard')}>
            {busy === 'discard' ? 'Discarding…' : 'Discard'}
          </button>
          <button type="button" class="draft-primary" disabled={busy !== null || !latest || running} onClick={() => void act('save')}>
            {busy === 'save' ? 'Saving…' : 'Save agent'}
          </button>
        </>
      )}
      meta={meta}
      tokens={<DraftUsageLine
        tokenUsage={creatorSession.approval?.tokenUsage}
        estimatedCost={pricing && creatorSession.approval
          ? pricing.estimateSessionCostUsd(creatorSession.approval.model, creatorSession.approval.tokenUsage)
          : undefined}
        formatUsd={pricing?.formatUsd}
      />}
      diffBadge={changeCounts
        ? <><span class="draft-added">+{changeCounts.added}</span> <span class="draft-removed">−{changeCounts.removed}</span></>
        : undefined}
      headerNote={latest && !previous ? 'first draft · whole file is new' : undefined}
      baseSource={previous?.source}
      source={latest?.source ?? ''}
      tab={tab}
      onTab={(next) => { setTabPinned(true); setTab(next); }}
      running={running}
      showTestTab={Boolean(latest)}
      hasTestRun={draft.testRuns.length > 0}
      testRun={<DraftTestRun
        project={project}
        session={testSession}
        runs={draft.testRuns}
        busy={busy === 'test'}
        onRun={() => void runTest()}
        onFinished={() => void refresh()}
      />}
      exchange={<DraftThread
        turns={draft.drafts.map((entry) => ({ request: entry.request, reply: entry.reply }))}
        entries={creatorSession.entries}
        running={running}
        sessionId={draft.jobId}
        projectId={draft.projectId}
        token={draft.sessionToken}
        leadRequest={draft.objective}
        emptyHint="The creator is working. Its steps appear here as it goes."
      />}
      composer={!closed && (
        <DraftComposer
          placeholder="Tell the creator what to change in this draft…"
          hint="to send · same creator session, keeps context"
          busy={busy === 'request' || running}
          disabled={!latest}
          onSend={requestChange}
        />
      )}
      error={actionError ?? creatorSession.streamError ?? draft.error?.message ?? null}
    />
  );
}
