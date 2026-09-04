import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { AgentRevisionRecord } from '../../../../agents/revision';
import {
  fetchAgentRevision,
  postAgentRevisionAction,
  requestAgentRevisionChanges,
  startAgentRevisionTestRun,
  type OnboardingJobHandle,
} from '../lib/api';
import { useInternalAgentJob } from '../hooks/use-internal-agent-job';
import { useTitle } from '../hooks/use-title';
import { Loading } from '../components/loading';
import { OnboardingSessionLog } from '../components/onboarding-session-log';
import { TokenUsageStrip } from '../components/token-usage-strip';
import {
  DraftComposer,
  DraftExchange,
  DraftPanel,
  DraftStatusPill,
  diffChangeCounts,
  type DraftFileTab,
} from '../components/draft-panel';
import { DraftTestRun } from '../components/draft-test-run';
import { revisionLineDiff } from '../lib/revision-diff';
import { agentDetailHref } from '../lib/links';
import { pageTitle } from '../lib/brand';

const POLL_MS = 1200;

type RevisionView = Omit<AgentRevisionRecord, 'previousSource'> & {
  baseSource?: string;
  originHref?: string;
};

function revisionJobHandle(revision: RevisionView, token?: string): OnboardingJobHandle {
  return {
    id: revision.revisionSessionId,
    sessionId: revision.revisionSessionId,
    projectId: revision.projectId,
    kind: 'agent-revision',
    status: revision.status === 'running' ? 'running' : revision.status === 'error' ? 'error' : 'completed',
    phase: 'running',
    model: revision.authoringModel,
    createdAt: revision.createdAt,
    ...(token && { sessionToken: token }),
  };
}

const OPEN_STATUSES = new Set(['running', 'proposed', 'no-change']);

export default function AgentRevision() {
  const location = useLocation();
  const project = location.query.project ?? '';
  const sessionId = location.query.session ?? '';
  const token = location.query.token || undefined;

  const [revision, setRevision] = useState<RevisionView | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState<'apply' | 'discard' | 'restore' | 'cancel' | 'request' | 'test' | null>(null);
  const [tab, setTab] = useState<DraftFileTab>('diff');
  const [testSession, setTestSession] = useState<{ sessionId: string; sessionToken?: string; draftIndex: number } | null>(null);
  const [pricing, setPricing] = useState<typeof import('../lib/pricing') | null>(null);

  useTitle(pageTitle('Agents', revision?.targetAgentName ?? 'Agent', 'Revision'));

  useEffect(() => {
    let cancelled = false;
    void import('../lib/pricing').then((mod) => { if (!cancelled) setPricing(mod); }).catch(() => {});
    return () => { cancelled = true; };
  }, []);

  const refresh = async () => {
    try {
      const payload = await fetchAgentRevision(sessionId, token, project);
      setRevision(payload.revision);
      setLoadError(null);
    } catch (caught) {
      setLoadError((caught as Error).message || 'Could not load this revision.');
    }
  };

  useEffect(() => {
    if (!project || !sessionId) {
      setLoadError('This link is missing its project or revision.');
      return;
    }
    void refresh();
  }, [project, sessionId, token]);

  useEffect(() => {
    if (!revision || revision.status !== 'running') return;
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, [revision?.revisionSessionId, revision?.status]);

  const jobHandle = useMemo(
    () => (revision ? revisionJobHandle(revision, token) : null),
    [revision?.revisionSessionId, revision?.status, token],
  );
  const reviserSession = useInternalAgentJob(jobHandle);

  const proposed = revision?.proposedSource;
  const changeCounts = useMemo(
    () => (proposed && revision?.baseSource ? diffChangeCounts(revisionLineDiff(revision.baseSource, proposed)) : null),
    [proposed, revision?.baseSource],
  );

  if (loadError) {
    return <div class="page-draft"><main><p class="empty" role="alert">{loadError}</p></main></div>;
  }
  if (!revision) return <Loading label="Loading revision" />;

  const running = revision.status === 'running';
  const open = OPEN_STATUSES.has(revision.status);

  const act = async (action: 'apply' | 'discard' | 'restore' | 'cancel') => {
    setBusy(action);
    setActionError(null);
    try {
      const payload = await postAgentRevisionAction(sessionId, action, project);
      setRevision((current) => (current ? { ...current, ...payload.revision } : current));
      if (action === 'apply' && revision.targetAgentRunPath) {
        location.route(agentDetailHref(revision.projectId, revision.targetAgentRunPath, { tab: 'source' }));
      }
    } catch (caught) {
      setActionError((caught as Error).message || `Could not ${action} this revision.`);
    } finally {
      setBusy(null);
    }
  };

  const requestChange = async (prompt: string) => {
    setBusy('request');
    setActionError(null);
    try {
      await requestAgentRevisionChanges(sessionId, prompt, project);
      setTab('diff');
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
      const payload = await startAgentRevisionTestRun(sessionId, project);
      setTestSession(payload.testRun);
      setTab('test');
    } catch (caught) {
      setActionError((caught as Error).message || 'Could not start a test run.');
    } finally {
      setBusy(null);
    }
  };

  const proposalNumber = revision.proposalCount ?? 1;
  const reviserSessionHref = (() => {
    const params = new URLSearchParams({ project });
    if (token) params.set('token', token);
    return `/sessions/${encodeURIComponent(sessionId)}?${params.toString()}`;
  })();
  const aside = (
    <>
      <div class="draft-brief">
        <div class="draft-card-head"><span class="draft-card-label">What should change</span></div>
        <p class="draft-brief-objective">{revision.instruction}</p>
        <dl class="draft-brief-facts">
          <dt>From run</dt>
          <dd>{revision.originHref
            ? <a href={revision.originHref}>{`${revision.originSessionId.slice(0, 8)}…`}</a>
            : `${revision.originSessionId.slice(0, 8)}…`}</dd>
          <dt>Agent</dt><dd>{revision.targetAgentName}</dd>
          <dt>Reviser</dt><dd>{revision.authoringModel}</dd>
        </dl>
      </div>
      <div class="draft-session">
        <span class="draft-card-label">Revision session</span>
        {/* The reviser may stop and ask one focused question. Answering resumes
            this same session, and that happens on the session page, which owns
            every approval gate in the product. */}
        {reviserSession.sessionStatus === 'waiting' && (
          <p class="draft-waiting" role="status">
            The reviser needs your answer before it can propose a change.{' '}
            <a href={reviserSessionHref}>Answer it in the session</a>
          </p>
        )}
        {jobHandle && (
          <OnboardingSessionLog
            job={jobHandle}
            title={`Revision session · ${revision.authoringModel}`}
            status={running ? reviserSession.sessionStatus : 'idle · waiting for you'}
            entries={reviserSession.entries}
            streamError={reviserSession.streamError}
          />
        )}
        <TokenUsageStrip
          tokenUsage={reviserSession.approval?.tokenUsage}
          estimatedCost={pricing && reviserSession.approval
            ? pricing.estimateSessionCostUsd(reviserSession.approval.model, reviserSession.approval.tokenUsage)
            : undefined}
          formatUsd={pricing?.formatUsd}
          compact
          ariaLabel="Revision session usage"
        />
      </div>
      {revision.diagnosis && (
        <div class="draft-brief">
          <div class="draft-card-head"><span class="draft-card-label">Diagnosis</span></div>
          <p class="draft-brief-objective">{revision.diagnosis}</p>
        </div>
      )}
      {revision.status === 'no-change' && revision.recommendedAction && (
        <div class="draft-brief">
          <div class="draft-card-head"><span class="draft-card-label">Recommended next action</span></div>
          <p class="draft-brief-objective">{revision.recommendedAction}</p>
        </div>
      )}
      {revision.capabilityChanges && (
        <div class="draft-brief">
          <div class="draft-card-head"><span class="draft-card-label">Capability review</span></div>
          {revision.capabilityChanges.length > 0
            ? <ul class="draft-capability-list">{revision.capabilityChanges.map((change) => <li key={change}>{change}</li>)}</ul>
            : <p class="draft-brief-objective">No model, schedule, tool, skill, integration, sub-agent, or channel changes.</p>}
        </div>
      )}
    </>
  );

  const actions = revision.status === 'applied'
    ? (
      <button type="button" class="draft-secondary" disabled={busy !== null} onClick={() => void act('restore')}>
        {busy === 'restore' ? 'Restoring…' : 'Restore previous source'}
      </button>
    )
    : open && (
      <>
        <button type="button" class="draft-secondary" disabled={busy !== null} onClick={() => void act(running ? 'cancel' : 'discard')}>
          {busy === 'discard' || busy === 'cancel' ? 'Discarding…' : running ? 'Stop' : 'Discard'}
        </button>
        {revision.status === 'proposed' && (
          <button type="button" class="draft-primary" disabled={busy !== null} onClick={() => void act('apply')}>
            {busy === 'apply' ? 'Applying…' : 'Apply revision'}
          </button>
        )}
        {revision.status === 'no-change' && (
          <button type="button" class="draft-primary" disabled={busy !== null} onClick={() => void act('discard')}>
            {busy === 'discard' ? 'Accepting…' : 'Accept diagnosis'}
          </button>
        )}
      </>
    );

  return (
    <DraftPanel
      breadcrumb={<>
        <a href={agentDetailHref(revision.projectId, revision.targetAgentRunPath ?? revision.targetAgentName, { tab: 'revisions' })}>{revision.targetAgentName}</a>
        <span aria-hidden="true">›</span>
        <strong>Revise agent file</strong>
      </>}
      pill={<DraftStatusPill
        label={revision.status}
        tone={revision.status === 'applied' || revision.status === 'restored' ? 'done'
          : revision.status === 'error' ? 'error'
          : running ? 'running' : 'draft'}
      />}
      actions={actions}
      aside={aside}
      filePath={revision.targetAgentRunPath ?? revision.targetAgentPath}
      versionLabel={proposed ? `proposal ${proposalNumber}` : running ? 'diagnosing…' : '—'}
      changeLabel={changeCounts
        ? <>Changes vs current file <span class="draft-added">+{changeCounts.added}</span> <span class="draft-removed">−{changeCounts.removed}</span></>
        : revision.status === 'no-change' ? 'No source change recommended' : ''}
      baseSource={revision.baseSource}
      source={proposed ?? revision.baseSource ?? ''}
      tab={tab}
      onTab={setTab}
      showTestTab={Boolean(proposed)}
      testRun={<DraftTestRun
        project={project}
        session={testSession}
        runs={[]}
        busy={busy === 'test'}
        onRun={() => void runTest()}
      />}
      exchange={<DraftExchange turns={revision.exchange ?? []} />}
      composer={open && (
        <DraftComposer
          placeholder="Tell the reviser what to change in this proposal…"
          hint="to send · same revision session, keeps context"
          busy={busy === 'request' || running}
          onSend={requestChange}
        />
      )}
      error={actionError ?? revision.error?.message ?? null}
    />
  );
}
