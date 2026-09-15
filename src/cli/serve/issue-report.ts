/**
 * A no-change proposal whose cause the reviser placed in AgentUse itself is
 * a bug report waiting to be filed. This builds the report the review page
 * offers as a "Report to AgentUse" link: a pre-filled GitHub new-issue URL.
 *
 * The person clicks it, reads it in GitHub's editor, and submits. Nothing
 * leaves the machine on its own: a model's "upstream bug" verdict is often a
 * bad prompt or a missing credential, and a public tracker should not carry
 * that noise unread.
 */
import type { ChangesetProposal, ChangesetRecord } from '../../agents/changeset-types.js';

export const DEFAULT_ISSUE_REPO = 'agentuse/agentuse';

const REPO_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?\/[A-Za-z0-9._-]+$/u;

/** GitHub caps a new-issue URL well under this; keep the whole link safe. */
const MAX_URL_LENGTH = 7_500;

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
  record: Pick<ChangesetRecord, 'target' | 'authoringModel' | 'originSessionId'>;
  proposal: Pick<ChangesetProposal, 'reply' | 'diagnosis'>;
  version: string;
  /** The origin run's model, when the changeset started from a run. */
  runModel?: string | undefined;
  /** Clipped transcript of the origin run; absent on a source-only revision. */
  transcript?: string | undefined;
  repo?: string | undefined;
}): UpstreamIssueReport {
  const repo = input.repo ?? issueRepo();
  const agentName = input.record.target?.name ?? 'an agent';
  const title = clip(`Reviser diagnosed an AgentUse issue while revising ${agentName}`, 120);

  const sections: string[] = [
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
  ];
  const fixed = sections.join('\n\n');

  const base = `https://github.com/${repo}/issues/new`;
  const urlFor = (body: string): string => `${base}?title=${encodeURIComponent(title)}&body=${encodeURIComponent(body)}`;

  // The transcript takes whatever room the URL has left, so the diagnosis is
  // never the part that gets cut.
  let body = fixed;
  if (input.transcript?.trim()) {
    const withTranscript = (excerpt: string) => `${fixed}\n\n## Run transcript (clipped)\n\n\`\`\`text\n${excerpt}\n\`\`\``;
    let excerpt = input.transcript.trim();
    while (excerpt.length > 0 && urlFor(withTranscript(excerpt)).length > MAX_URL_LENGTH) {
      excerpt = clip(excerpt, Math.floor(excerpt.length * 0.8));
    }
    if (excerpt.length > 0) body = withTranscript(excerpt);
  }
  body += '\n\n---\nFiled from the AgentUse changeset review. Please read the report before submitting: the diagnosis was written by a model.';

  return { repo, title, body, url: urlFor(body) };
}
