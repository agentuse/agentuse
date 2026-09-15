/**
 * A no-change proposal whose cause the reviser placed in AgentUse itself is
 * a bug report waiting to be filed. This builds the report the review page
 * offers as a "Report to AgentUse" link: a pre-filled GitHub new-issue URL.
 *
 * The person clicks it, reads it in GitHub's editor, and submits. Nothing
 * leaves the machine on its own: a model's "upstream bug" verdict is often a
 * bad prompt or a missing credential, and a public tracker should not carry
 * that noise unread.
 *
 * The report deliberately carries no run transcript. Tool inputs and outputs
 * are the operator's data (paths, URLs, customer records), and the tracker is
 * public. The session ids go in instead: they identify the run on the
 * operator's own machine, so a maintainer can ask for exactly what they need
 * and the operator decides what to share.
 */
import type { ChangesetProposal, ChangesetRecord } from '../../agents/changeset-types.js';

export const DEFAULT_ISSUE_REPO = 'agentuse/agentuse';

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/u;

export interface UpstreamIssueReport {
  repo: string;
  title: string;
  body: string;
  url: string;
}

/** `owner/name` for the tracker the report goes to. Operators running a fork
 *  or an internal build point it elsewhere with AGENTUSE_ISSUE_REPO. */
export function issueRepo(env: NodeJS.ProcessEnv = process.env): string {
  const configured = env.AGENTUSE_ISSUE_REPO?.trim();
  if (!configured) return DEFAULT_ISSUE_REPO;
  if (!REPO_PATTERN.test(configured)) {
    throw new Error(`AGENTUSE_ISSUE_REPO must be owner/name, got ${JSON.stringify(configured)}`);
  }
  return configured;
}

function clip(text: string, max: number): string {
  const trimmed = text.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max)}…` : trimmed;
}

export function buildUpstreamIssueReport(input: {
  record: Pick<ChangesetRecord, 'sessionId' | 'target' | 'authoringModel' | 'originSessionId'>;
  proposal: Pick<ChangesetProposal, 'reply' | 'diagnosis'>;
  version: string;
  /** The origin run's model, when the changeset started from a run. */
  runModel?: string | undefined;
  repo?: string | undefined;
}): UpstreamIssueReport {
  const repo = input.repo ?? issueRepo();
  const agentName = input.record.target?.name ?? 'an agent';
  const title = clip(`Reviser diagnosed an AgentUse issue while revising ${agentName}`, 120);

  const body = [
    '## What the reviser found',
    input.proposal.diagnosis ? clip(input.proposal.diagnosis, 3_000) : clip(input.proposal.reply, 1_000),
    '## Recommended next step',
    clip(input.proposal.reply, 1_000),
    '## Environment',
    [
      `- AgentUse: ${input.version}`,
      `- Reviser model: ${input.record.authoringModel}`,
      ...(input.runModel ? [`- Run model: ${input.runModel}`] : []),
      ...(input.record.target ? [`- Agent: ${input.record.target.path}`] : []),
    ].join('\n'),
    '## Sessions',
    [
      'These ids are local to the reporter\'s AgentUse. No run data is attached; ask the reporter for what you need.',
      '',
      ...(input.record.originSessionId ? [`- Run: ${input.record.originSessionId}`] : []),
      `- Revision: ${input.record.sessionId}`,
    ].join('\n'),
    '---\nFiled from the AgentUse changeset review. Please read the report before submitting: the diagnosis was written by a model, and this tracker is public.',
  ].join('\n\n');

  const url = `https://github.com/${repo}/issues/new?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;
  return { repo, title, body, url };
}
