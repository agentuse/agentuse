import { describe, expect, it } from 'bun:test';
import { DEFAULT_ISSUE_REPO, buildUpstreamIssueReport, issueRepo } from '../src/cli/serve/issue-report';

const record = {
  sessionId: '01K4REVISIONXXXXXXXXXXXXXX',
  target: { path: 'agents/triage.agentuse', name: 'Triage' },
  authoringModel: 'anthropic:claude-sonnet-5',
  originSessionId: '01K4ABCDEFGHJKMNPQRSTVWXYZ',
};
const proposal = {
  reply: 'Report this to AgentUse and rerun once it is fixed.',
  diagnosis: 'The bash tool dropped the exit code, so the agent saw success on a failed command.',
};

describe('issueRepo', () => {
  it('defaults to the public tracker and accepts an owner/name override', () => {
    expect(issueRepo({})).toBe(DEFAULT_ISSUE_REPO);
    expect(issueRepo({ AGENTUSE_ISSUE_REPO: ' my-org/fork ' })).toBe('my-org/fork');
  });

  it('refuses anything that is not owner/name', () => {
    expect(() => issueRepo({ AGENTUSE_ISSUE_REPO: 'https://github.com/x/y' })).toThrow('owner/name');
    expect(() => issueRepo({ AGENTUSE_ISSUE_REPO: 'just-a-name' })).toThrow('owner/name');
  });
});

describe('buildUpstreamIssueReport', () => {
  it('pre-fills a new-issue link with the diagnosis, environment and session ids', () => {
    const report = buildUpstreamIssueReport({
      record,
      proposal,
      version: '0.22.0',
      runModel: 'openai:gpt-5.6-luna',
      repo: 'agentuse/agentuse',
    });
    expect(report.url.startsWith('https://github.com/agentuse/agentuse/issues/new?title=')).toBe(true);
    expect(report.title).toContain('Triage');
    expect(report.body).toContain(proposal.diagnosis);
    expect(report.body).toContain('- AgentUse: 0.22.0');
    expect(report.body).toContain('- Run model: openai:gpt-5.6-luna');
    expect(report.body).toContain('- Agent: agents/triage.agentuse');
    expect(report.body).toContain('- Run: 01K4ABCDEFGHJKMNPQRSTVWXYZ');
    expect(report.body).toContain('- Revision: 01K4REVISIONXXXXXXXXXXXXXX');
    expect(report.body).toContain('this tracker is public');
    const decoded = new URL(report.url);
    expect(decoded.searchParams.get('body')).toBe(report.body);
  });

  it('never carries run data: the report has no transcript, only ids a maintainer can ask about', () => {
    const report = buildUpstreamIssueReport({
      record,
      proposal,
      version: '0.22.0',
      repo: 'agentuse/agentuse',
    });
    expect(report.body).not.toContain('transcript');
    expect(report.body).toContain('No run data is attached');
    expect(report.url.length).toBeLessThanOrEqual(7_500);
  });

  it('works without a run: a source-only revision lists only the revision session', () => {
    const report = buildUpstreamIssueReport({
      record: { ...record, originSessionId: undefined },
      proposal,
      version: '0.22.0',
      repo: 'agentuse/agentuse',
    });
    expect(report.body).not.toContain('- Run:');
    expect(report.body).toContain('- Revision:');
  });

  it('still builds the link when a clip boundary lands inside an emoji', () => {
    const report = buildUpstreamIssueReport({
      record: { ...record, target: { ...record.target, name: `${'n'.repeat(68)}😀 agent` } },
      proposal: { ...proposal, diagnosis: `${'d'.repeat(2_999)}😀b` },
      version: '0.22.0',
      repo: 'agentuse/agentuse',
    });
    expect(report.body).toContain(`${'d'.repeat(2_999)}…`);
    expect(report.title.endsWith(`${'n'.repeat(68)}…`)).toBe(true);
    const decoded = new URL(report.url);
    expect(decoded.searchParams.get('body')).toBe(report.body);
    expect(decoded.searchParams.get('title')).toBe(report.title);
  });
});
