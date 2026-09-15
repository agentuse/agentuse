import type { ApprovalLogEntry, ApprovalPageInfo } from '../../types';
import { FIXTURE_SESSION_PREFIX } from '../lib/dev';

/**
 * Canned session pages, one per state the "now" card can be in, so every
 * variant can be opened on demand instead of waiting for a real run to reach
 * it. The session page renders these through the same stream hook and the
 * same components as a real session; only the data source differs.
 *
 * Reached from Settings > Developer (dev builds only) at
 * /sessions/fixture-<id>. Times are relative to page load so "waiting 2h"
 * style copy reads naturally.
 */
export interface SessionFixture {
  /** URL slug after `fixture-`. */
  id: string;
  label: string;
  /** What the page should show; the reviewer's checklist for the card. */
  hint: string;
  /** Raw session status, as the stream's status event carries it. */
  status: string;
  approval: Omit<ApprovalPageInfo, 'logs'>;
  logs: ApprovalLogEntry[];
}

const PROJECT = 'fixtures';
const MODEL = 'anthropic:claude-sonnet-5';
const RESUME_TOKEN = 'fixture-resume-token';
const MINUTE = 60_000;

function agent(id: string, name: string, description: string): ApprovalPageInfo['agent'] {
  // No filePath on purpose: the learnings and revision panels fetch by it and
  // there is no daemon-side session behind a fixture to answer them.
  return { id: `agents/${id}`, name, description, runPath: `agents/${id}.agentuse` };
}

function header(
  id: string,
  sessionStatus: string,
  startedAgo: number,
  extra: Partial<Omit<ApprovalPageInfo, 'logs'>> = {},
): Omit<ApprovalPageInfo, 'logs'> {
  return {
    sessionId: `${FIXTURE_SESSION_PREFIX}${id}`,
    sessionStatus,
    project: PROJECT,
    projectPath: '/fixtures',
    createdAt: Date.now() - startedAgo,
    model: MODEL,
    agent: agent('weekly-digest', 'Weekly Digest', 'Collects the week\'s notable changes and drafts one digest post.'),
    learning: { capture: true, apply: true },
    tokenUsage: {
      input: 184_200,
      cachedInput: 151_000,
      output: 3_420,
      context: { activeTokens: 31_000, contextLimit: 200_000, usagePercentage: 15.5, compacted: false, compactions: 0, updatedAt: Date.now() },
    },
    ...extra,
  };
}

function reasoning(id: string, ago: number, message: string): ApprovalLogEntry {
  return { id, type: 'reasoning', status: 'completed', title: 'Reasoning', message, time: Date.now() - ago };
}

function text(id: string, ago: number, message: string): ApprovalLogEntry {
  return { id, type: 'text', status: 'completed', title: 'Assistant response', message, time: Date.now() - ago };
}

function tool(
  id: string,
  ago: number,
  name: string,
  status: 'completed' | 'running' | 'error',
  intent: string,
  extra: Partial<ApprovalLogEntry> = {},
): ApprovalLogEntry {
  return {
    id,
    type: 'tool',
    tool: name,
    callId: `call_${id}`,
    status,
    title: `${name} ${status}`,
    time: Date.now() - ago,
    details: {
      intent,
      input: JSON.stringify({ query: 'changes since monday', limit: 20 }, null, 2),
      ...(status === 'completed' ? { output: JSON.stringify({ items: 14, took_ms: 812 }, null, 2) } : {}),
      ...(status === 'error' ? { output: 'Error: upstream returned 502 Bad Gateway' } : {}),
    },
    ...extra,
  };
}

/** The spine every fixture shares: a few steps that already happened. */
function warmup(ago: number): ApprovalLogEntry[] {
  return [
    { id: 'learnings', type: 'corrections', title: '6 learnings applied', applied: 6, active: 6, time: Date.now() - ago },
    reasoning('r1', ago - MINUTE, '**Planning the digest**\n\nRead the change feed first, then group by theme.'),
    tool('t1', ago - 2 * MINUTE, 'store_search', 'completed', 'Read the week\'s change feed'),
    tool('t2', ago - 3 * MINUTE, 'tools__bash', 'completed', 'Count changes per theme'),
    reasoning('r2', ago - 4 * MINUTE, '**Three themes stand out**\n\nRelease notes, incidents, and one policy change.'),
  ];
}

const DRAFT = [
  '## Weekly digest, draft',
  '',
  'Three things happened this week worth your time:',
  '',
  '1. **Releases**: two minor versions shipped, one with a breaking flag rename.',
  '2. **Incidents**: one 40-minute outage on the ingest path, root cause a stale cache key.',
  '3. **Policy**: retention for raw logs drops from 90 to 30 days starting next month.',
].join('\n');

function gate(ago: number, extra: Partial<NonNullable<ApprovalLogEntry['details']>> = {}): ApprovalLogEntry {
  return {
    id: 'gate',
    type: 'tool',
    tool: 'await_human',
    callId: 'call_gate',
    status: 'pending',
    title: 'await_human pending',
    time: Date.now() - ago,
    details: {
      resumeToken: RESUME_TOKEN,
      prompt: 'Publish this digest to the team channel?',
      summary: 'Digest covering releases, one incident and the retention change.',
      context: 'Goes to #team-updates, read by about 40 people.',
      risk: 'Posts publicly to the channel and cannot be edited after posting.',
      draft: DRAFT,
      changes: [{ label: 'Post to #team-updates', content: DRAFT }],
      ...extra,
    },
  };
}

export function buildSessionFixtures(): SessionFixture[] {
  return [
    {
      id: 'working',
      label: 'Working',
      hint: 'Spinner in the head, the running step as the focus, three recent steps under it, transcript folded, Stop in the bar.',
      status: 'running',
      approval: header('working', 'running', 6 * MINUTE),
      logs: [
        ...warmup(6 * MINUTE),
        tool('t3', 40_000, 'store_search', 'completed', 'Pull incident timeline'),
        tool('t4', 8_000, 'tools__fetch', 'running', 'Fetch the release notes page'),
      ],
    },
    {
      id: 'decision',
      label: 'Decision needed',
      hint: 'Gate card as the focus with approve / reject / comment, transcript folded, no result block.',
      status: 'waiting',
      approval: header('decision', 'suspended', 25 * MINUTE, {
        approvalKind: 'await_human',
        currentResumeToken: RESUME_TOKEN,
        expiresAt: Date.now() + 3 * 60 * MINUTE,
        suspendedAt: Date.now() - 12 * MINUTE,
        timing: { calculatedAt: Date.now(), wallMs: 25 * MINUTE, activeMs: 9 * MINUTE, approvalMs: 12 * MINUTE, approvalCount: 1 },
      }),
      logs: [
        ...warmup(25 * MINUTE),
        text('a1', 14 * MINUTE, 'Draft ready. Asking for approval before posting.'),
        gate(12 * MINUTE),
      ],
    },
    {
      id: 'decision-options',
      label: 'Decision, pick one',
      hint: 'Same gate, but with three options and a recommended pick; approve waits for a choice when none is recommended.',
      status: 'waiting',
      approval: header('decision-options', 'suspended', 25 * MINUTE, {
        approvalKind: 'await_human',
        currentResumeToken: RESUME_TOKEN,
        expiresAt: Date.now() + 3 * 60 * MINUTE,
        suspendedAt: Date.now() - 5 * MINUTE,
        options: [
          { id: 'short', label: 'Short version', description: 'Three bullets, no detail.' },
          { id: 'full', label: 'Full digest', description: 'Bullets plus the incident timeline.', recommended: true },
          { id: 'skip', label: 'Skip this week', description: 'Nothing worth a post.' },
        ],
      }),
      logs: [
        ...warmup(25 * MINUTE),
        gate(5 * MINUTE, {
          prompt: 'Which version should go out?',
          options: [
            { id: 'short', label: 'Short version', description: 'Three bullets, no detail.' },
            { id: 'full', label: 'Full digest', description: 'Bullets plus the incident timeline.', recommended: true },
            { id: 'skip', label: 'Skip this week', description: 'Nothing worth a post.' },
          ],
        }),
      ],
    },
    {
      id: 'result',
      label: 'Result',
      hint: 'Green Result head, headline and body from report_complete, recorded metric chips, tiles under it, transcript open.',
      status: 'completed',
      approval: header('result', 'completed', 40 * MINUTE, {
        timing: { calculatedAt: Date.now(), wallMs: 11 * MINUTE, activeMs: 9 * MINUTE, approvalMs: 2 * MINUTE, approvalCount: 1 },
      }),
      logs: [
        ...warmup(40 * MINUTE),
        {
          ...gate(33 * MINUTE),
          status: 'completed',
          title: 'await_human approved',
          details: { prompt: 'Publish this digest to the team channel?', draft: DRAFT, decisionStatus: 'approved', decisionReviewer: 'leon' },
        },
        tool('t5', 31 * MINUTE, 'tools__post_message', 'completed', 'Post the digest to #team-updates'),
        {
          ...tool('m1', 30 * MINUTE, 'tools__record_metric', 'completed', 'Record the post'),
          details: {
            intent: 'Record the post',
            input: JSON.stringify({ metric: 'digests_posted', count: 1 }),
            output: JSON.stringify({ success: true, metric: 'digests_posted' }),
          },
        },
        {
          ...tool('done', 29 * MINUTE, 'report_complete', 'completed', 'Report the digest as posted'),
          details: {
            intent: 'Report the digest as posted',
            input: JSON.stringify({ headline: 'Posted the weekly digest to #team-updates' }),
            output: 'Recorded and delivered.',
            runOutcome: {
              kind: 'complete',
              headline: 'Posted the weekly digest to #team-updates',
              body: [
                'Covered two releases, one incident and the retention change.',
                '',
                '| Theme | Items |',
                '|---|---|',
                '| Releases | 2 |',
                '| Incidents | 1 |',
                '| Policy | 1 |',
              ].join('\n'),
            },
          },
        },
      ],
    },
    {
      id: 'error',
      label: 'Needs attention',
      hint: 'Red head, the failure text as the focus, the failed step under it, tiles, Discard in the menu.',
      status: 'error',
      approval: header('error', 'error', 50 * MINUTE, {
        errorCode: 'TOOL_ERROR',
        errorMessage: 'tools__fetch failed twice in a row: upstream returned 502 Bad Gateway.',
        timing: { calculatedAt: Date.now(), wallMs: 7 * MINUTE, activeMs: 7 * MINUTE, approvalMs: 0, approvalCount: 0 },
      }),
      logs: [
        ...warmup(50 * MINUTE),
        tool('t6', 44 * MINUTE, 'tools__fetch', 'error', 'Fetch the release notes page'),
        tool('t7', 43 * MINUTE, 'tools__fetch', 'error', 'Retry the release notes page'),
        {
          id: 'session-error',
          type: 'session',
          status: 'error',
          title: 'Session failed',
          time: Date.now() - 43 * MINUTE,
          details: { errorMessage: 'tools__fetch failed twice in a row: upstream returned 502 Bad Gateway.' },
        },
      ],
    },
    {
      id: 'incomplete',
      label: 'Incomplete',
      hint: 'Error head with the agent\'s own reason via report_incomplete; the partial outcome shows in the result slot below the failure.',
      status: 'error',
      approval: header('incomplete', 'error', 50 * MINUTE, {
        errorCode: 'INCOMPLETE',
        errorMessage: 'The change feed was empty for the week, so there is nothing to digest.',
        timing: { calculatedAt: Date.now(), wallMs: 3 * MINUTE, activeMs: 3 * MINUTE, approvalMs: 0, approvalCount: 0 },
      }),
      logs: [
        ...warmup(50 * MINUTE),
        {
          ...tool('done', 47 * MINUTE, 'report_incomplete', 'completed', 'Report the run incomplete'),
          details: {
            intent: 'Report the run incomplete',
            input: JSON.stringify({ reason: 'The change feed was empty for the week.' }),
            output: 'Recorded: this run will end marked incomplete.',
            runOutcome: { kind: 'incomplete', headline: 'The change feed was empty for the week, so there is nothing to digest.', body: 'Checked the feed twice, ten minutes apart. Both reads returned zero items.' },
          },
        },
      ],
    },
    {
      id: 'expired',
      label: 'Expired gate',
      hint: 'Idle card labelled Paused with the expiry note; the old gate stays in the transcript without buttons.',
      status: 'waiting',
      approval: header('expired', 'suspended', 26 * 60 * MINUTE, {
        approvalKind: 'await_human',
        currentResumeToken: RESUME_TOKEN,
        expiresAt: Date.now() - 2 * 60 * MINUTE,
        suspendedAt: Date.now() - 25 * 60 * MINUTE,
      }),
      logs: [
        ...warmup(26 * 60 * MINUTE),
        gate(25 * 60 * MINUTE),
      ],
    },
    {
      id: 'ended-empty',
      label: 'Ended, nothing to show',
      hint: 'Idle card labelled Ended with the fallback note: a run that stopped before producing anything.',
      status: 'completed',
      approval: header('ended-empty', 'completed', 10 * MINUTE),
      logs: [],
    },
    {
      id: 'child-suspended',
      label: 'Sub-agent, paused at the parent\'s gate',
      hint: 'View-only overlay: "Paused for the parent\'s decision", the view-only meta, and an Open-the-parent button. No approve buttons here.',
      status: 'waiting',
      approval: header('child-suspended', 'suspended', 30 * MINUTE, {
        agent: agent('digest-writer', 'Digest Writer', 'Writes the digest body from the grouped changes.'),
        viewOnly: true,
        parentSessionId: `${FIXTURE_SESSION_PREFIX}decision`,
        parentAgentName: 'Weekly Digest',
        parentHref: `/sessions/${FIXTURE_SESSION_PREFIX}decision`,
        additionalInstruction: 'Write the digest for the three themes listed. Keep it under 200 words.',
        approvalKind: 'await_human',
        suspendedAt: Date.now() - 12 * MINUTE,
        timing: { calculatedAt: Date.now(), wallMs: 30 * MINUTE, activeMs: 6 * MINUTE, approvalMs: 12 * MINUTE, approvalCount: 1 },
      }),
      logs: [
        ...warmup(30 * MINUTE),
        gate(12 * MINUTE),
      ],
    },
    {
      id: 'child-result',
      label: 'Sub-agent, finished',
      hint: 'Result card with the view-only meta and an Open-parent button under the tiles.',
      status: 'completed',
      approval: header('child-result', 'completed', 30 * MINUTE, {
        agent: agent('digest-writer', 'Digest Writer', 'Writes the digest body from the grouped changes.'),
        viewOnly: true,
        parentSessionId: `${FIXTURE_SESSION_PREFIX}result`,
        parentAgentName: 'Weekly Digest',
        parentHref: `/sessions/${FIXTURE_SESSION_PREFIX}result`,
        timing: { calculatedAt: Date.now(), wallMs: 4 * MINUTE, activeMs: 4 * MINUTE, approvalMs: 0, approvalCount: 0 },
      }),
      logs: [
        ...warmup(30 * MINUTE),
        text('a2', 26 * MINUTE, DRAFT),
      ],
    },
  ];
}

export function sessionFixture(sessionId: string): SessionFixture | undefined {
  if (!sessionId.startsWith(FIXTURE_SESSION_PREFIX)) return undefined;
  const id = sessionId.slice(FIXTURE_SESSION_PREFIX.length);
  return buildSessionFixtures().find((fixture) => fixture.id === id);
}
