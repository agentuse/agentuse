import { useEffect, useMemo, useState } from 'preact/hooks';
import { useLocation } from 'preact-iso';
import type { AgentRevisionRecord } from '../../../../agents/revision';
import {
  fetchAgentRevision,
  postAgentRevisionAction,
  requestAgentRevisionChanges,
  startAgentRevisionTestRun,
} from '../lib/api';
import { useSessionLog } from '../hooks/use-session-log';
import { useTitle } from '../hooks/use-title';
import { Loading } from '../components/loading';
import { TokenUsageStrip } from '../components/token-usage-strip';
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

type RevisionView = Omit<AgentRevisionRecord, 'previousSource'> & {
  baseSource?: string;
  originHref?: string;
};

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
  const [tab, setTab] = useState<DraftFileTab>('changes');
  // The operator picked a tab; stop steering it for them.
  const [tabPinned, setTabPinned] = useState(false);
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

  // The panel outlives any single reviser turn, so it follows the session log
  // directly rather than a job that settles after the first proposal.
  const reviserSession = useSessionLog({
    sessionId,
    token,
    project,
    enabled: Boolean(sessionId && project),
  });

  // Changes leads while the reviser works and once it has answered. A settled
  // proposal nobody has questioned yet opens on the diff, which is the thing
  // the operator is being asked to accept.
  const hasRequest = Boolean(revision?.exchange?.some((turn) => turn.request));
  useEffect(() => {
    if (tabPinned || !revision) return;
    if (revision.status === 'running' || hasRequest) setTab('changes');
    else if (revision.proposedSource) setTab('diff');
  }, [tabPinned, revision?.status, hasRequest, revision?.proposedSource]);

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
      const payload = await startAgentRevisionTestRun(sessionId, project);
      setTestSession(payload.testRun);
      setTabPinned(true);
      setTab('test');
    } catch (caught) {
      setActionError((caught as Error).message || 'Could not start a test run.');
    } finally {
      setBusy(null);
    }
  };

  const proposalNumber = revision.proposalCount ?? 1;
  const capabilityChanges = revision.capabilityChanges ?? [];
  // The reviser's diagnosis explains the proposal on screen, so it rides its
  // latest reply in the thread rather than sitting in a card off to the side.
  const exchangeTurns = (() => {
    const turns = [...(revision.exchange ?? [])];
    const detail = revision.status === 'no-change' ? revision.recommendedAction : revision.diagnosis;
    if (!detail) return turns;
    const last = turns[turns.length - 1];
    if (last && last.reply !== undefined) {
      const merged = last.reply && last.reply !== detail ? `${last.reply}\n\n${detail}` : detail;
      return [...turns.slice(0, -1), { ...last, reply: merged }];
    }
    return [...turns, { reply: detail }];
  })();
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
        {reviserSession.status === 'waiting' && (
          <p class="draft-waiting" role="status">
            The reviser needs your answer before it can propose a change.{' '}
            <a href={reviserSessionHref}>Answer it in the session</a>
          </p>
        )}
        {reviserSession.streamError && <p class="draft-error" role="alert">{reviserSession.streamError}</p>}
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
      {/* A capability change is the one thing here that can widen what the agent
          may do, so it keeps a card. "Nothing changed" is a one-line
          reassurance and rides in the file header instead. */}
      {capabilityChanges.length > 0 && (
        <div class="draft-brief">
          <div class="draft-card-head"><span class="draft-card-label">Capability review</span></div>
          <ul class="draft-capability-list">{capabilityChanges.map((change) => <li key={change}>{change}</li>)}</ul>
        </div>
      )}
      <div class="draft-brief">
        <div class="draft-card-head"><span class="draft-card-label">Earlier revisions</span></div>
        <p class="draft-brief-objective">
          <a href={agentDetailHref(revision.projectId, revision.targetAgentRunPath ?? revision.targetAgentName, { tab: 'revisions' })}>
            See every revision of this agent
          </a>
        </p>
      </div>
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
      onTab={(next) => { setTabPinned(true); setTab(next); }}
      showTestTab={Boolean(proposed)}
      headerNote={revision.capabilityChanges && capabilityChanges.length === 0 ? 'no capability changes' : undefined}
      testRun={<DraftTestRun
        project={project}
        session={testSession}
        runs={[]}
        busy={busy === 'test'}
        onRun={() => void runTest()}
      />}
      exchange={<DraftThread
        turns={exchangeTurns}
        entries={reviserSession.entries}
        running={running}
        sessionId={sessionId}
        projectId={project}
        token={token}
        sessionHref={reviserSessionHref}
        emptyHint="The reviser is diagnosing the run. Its steps and findings appear here."
      />}
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
