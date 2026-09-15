import { describe, expect, it } from 'bun:test';
import renderToString from 'preact-render-to-string';
import type { ChangesetFile, ChangesetProposal } from '../src/agents/changeset-types';
import {
  CHANGESET_UNREFERENCED_FLAG,
  changesetAcceptedHref,
  changesetDiffStat,
  changesetExchangeTurns,
  changesetFileGroup,
  changesetFileGroups,
  changesetNeedsFileReview,
  changesetReviewHref,
  isChangesetScript,
  patchDiffLines,
} from '../src/cli/serve/web/lib/changeset-view';
import { ChangesetFileList } from '../src/cli/serve/web/components/changeset-file-list';
import { ChangesetFileView } from '../src/cli/serve/web/components/changeset-file-view';

describe('accepting a changeset diagnosis', () => {
  const target = { path: 'agents/daily report.agentuse', name: 'Daily report' };

  it('returns to the source session before the agent page', () => {
    expect(changesetAcceptedHref({ projectId: 'my project', originSessionId: 'source/session', target }))
      .toBe('/sessions/source%2Fsession?project=my+project');
  });

  it('preserves the source session capability link from the server', () => {
    expect(changesetAcceptedHref({ projectId: 'demo', originSessionId: 'source', target }, '/sessions/source?project=demo&token=source-token'))
      .toBe('/sessions/source?project=demo&token=source-token');
  });

  it('returns to the target agent when there is no source session', () => {
    expect(changesetAcceptedHref({ projectId: 'my project', target }))
      .toBe('/agents/my%20project/agents/daily%20report.agentuse');
  });

  it('uses Home only when neither a source session nor target agent is available', () => {
    expect(changesetAcceptedHref({ projectId: 'demo' })).toBe('/');
  });
});

describe('changeset conversation explanations', () => {
  const proposal = (reply: string, diagnosis: string, request?: string): ChangesetProposal => ({
    index: 1, submittedAt: 0, files: [], reply, diagnosis, ...(request && { request }),
  });

  it('answers why before giving the recommended action for an existing no-change proposal', () => {
    const reply = 'Approve or reject the waiting run.';
    const diagnosis = 'The run stopped because an earlier run is waiting for review. This prevents duplicate publishing.';
    const exchange = [{ reply }];
    expect(changesetExchangeTurns({ exchange, proposals: [proposal(reply, diagnosis)] })).toEqual([
      { reply: `${diagnosis}\n\n${reply}` },
    ]);
    expect(exchange).toEqual([{ reply }]);
  });

  it('keeps each diagnosis with its own reply while a follow-up is pending', () => {
    expect(changesetExchangeTurns({
      exchange: [{ reply: 'First advice' }, { request: 'What changed?', reply: 'Second advice' }, { request: 'One more question' }],
      proposals: [proposal('First advice', 'First cause'), proposal('Second advice', 'Second cause', 'What changed?')],
    })).toEqual([
      { reply: 'First cause\n\nFirst advice' },
      { request: 'What changed?', reply: 'Second cause\n\nSecond advice' },
      { request: 'One more question' },
    ]);
  });

  it('does not repeat a diagnosis already included in the reply', () => {
    const reply = 'The run stopped.\n\nApprove the waiting run.';
    expect(changesetExchangeTurns({ exchange: [{ reply }], proposals: [proposal(reply, 'The run stopped.')] })).toEqual([{ reply }]);
  });

  it('leaves unmatched historical replies alone instead of guessing their diagnosis', () => {
    const exchange = [{ reply: 'Historical advice' }];
    expect(changesetExchangeTurns({ exchange, proposals: [] })).toEqual(exchange);
    expect(changesetExchangeTurns({ exchange, proposals: [proposal('Different advice', 'Unrelated cause')] })).toEqual(exchange);
  });
});

function file(partial: Partial<ChangesetFile> & Pick<ChangesetFile, 'path'>): ChangesetFile {
  return {
    kind: 'support',
    op: 'add',
    baseHash: null,
    content: '',
    hash: 'x',
    ...partial,
  };
}

const collector = file({
  path: 'agents/collector.agentuse',
  kind: 'agent',
  op: 'add',
  content: 'model: anthropic:claude-sonnet-5\n---\nCollect.\n',
  capabilityChanges: ['gains bash: python3 agents/scrape.py'],
});
const script = file({
  path: 'agents/scrape.py',
  kind: 'support',
  op: 'add',
  content: 'import sys\nprint("hi")\n',
  flags: ['makes network calls'],
});
const readme = file({
  path: 'docs/notes.md',
  kind: 'support',
  op: 'modify',
  baseHash: 'abc',
  content: 'notes\n',
  patch: '--- a/docs/notes.md\n+++ b/docs/notes.md\n@@ -1,2 +1,1 @@\n-old\n-lines\n+notes\n',
  flags: [CHANGESET_UNREFERENCED_FLAG],
});

describe('changeset file grouping', () => {
  it('puts agents first, referenced support files next, and unreferenced files last', () => {
    expect(changesetFileGroup(collector)).toBe('agents');
    expect(changesetFileGroup(script)).toBe('referenced');
    expect(changesetFileGroup(readme)).toBe('other');

    const groups = changesetFileGroups([readme, script, collector]);
    expect(groups.map((group) => group.id)).toEqual(['agents', 'referenced', 'other']);
    expect(groups.map((group) => group.label)).toEqual(['Agents', 'Files agents reference', 'Other project files']);
    expect(groups[1]!.files.map((entry) => entry.path)).toEqual(['agents/scrape.py']);
  });

  it('drops groups with no files', () => {
    expect(changesetFileGroups([collector]).map((group) => group.id)).toEqual(['agents']);
    expect(changesetFileGroups([])).toEqual([]);
  });

  it('treats an agent as an agent even when it carries the unreferenced flag', () => {
    expect(changesetFileGroup({ kind: 'agent', flags: [CHANGESET_UNREFERENCED_FLAG] })).toBe('agents');
  });
});

describe('changeset diff stats', () => {
  it('counts the stored patch and ignores its file headers', () => {
    expect(changesetDiffStat(readme)).toEqual({ added: 1, removed: 2 });
  });

  it('falls back to whole-content adds when no patch was stored', () => {
    expect(changesetDiffStat(script)).toEqual({ added: 2, removed: 0 });
  });

  it('returns nothing for a summary row that carries neither', () => {
    expect(changesetDiffStat({ content: undefined as unknown as string })).toBeNull();
  });

  it('maps a unified patch onto the draft diff line kinds', () => {
    expect(patchDiffLines(readme.patch!)).toEqual([
      { kind: 'meta', text: '@@ -1,2 +1,1 @@' },
      { kind: 'remove', text: 'old' },
      { kind: 'remove', text: 'lines' },
      { kind: 'add', text: 'notes' },
    ]);
  });
});

describe('changeset test-run gate', () => {
  const proposal = (files: ChangesetFile[]): ChangesetProposal =>
    ({ index: 1, submittedAt: 0, reply: 'done', files });

  it('flags runnable support scripts only', () => {
    expect(isChangesetScript(script)).toBe(true);
    expect(isChangesetScript(readme)).toBe(false);
    expect(isChangesetScript(collector)).toBe(false);
  });

  it('requires a file to be opened before a proposal with a script can be run', () => {
    expect(changesetNeedsFileReview(proposal([collector, script]))).toBe(true);
    expect(changesetNeedsFileReview(proposal([collector, readme]))).toBe(false);
    expect(changesetNeedsFileReview(undefined)).toBe(false);
  });
});

describe('changeset review link', () => {
  it('addresses the review by project and session, carrying a token when there is one', () => {
    expect(changesetReviewHref('demo', '01J')).toBe('/projects/demo/changesets/01J');
    expect(changesetReviewHref('my proj', '01J', 'tok')).toBe('/projects/my%20proj/changesets/01J?token=tok');
  });
});

describe('ChangesetFileList', () => {
  it('renders every group with an op badge and a change count', () => {
    const html = renderToString(
      <ChangesetFileList files={[collector, script, readme]} selected="agents/scrape.py" onSelect={() => {}} />,
    );
    expect(html).toContain('Agents');
    expect(html).toContain('Files agents reference');
    expect(html).toContain('Other project files');
    expect(html).toContain('agents/collector.agentuse');
    expect(html).toContain('changeset-op is-modify');
    expect(html).toContain('+1');
    expect(html).toContain('−2');
    expect(html).toContain('changeset-file-row is-active');
  });
});

describe('ChangesetFileView', () => {
  it('groups shared callers and keeps properties neutral, including older misleading flags', () => {
    const html = renderToString(<ChangesetFileView file={{ ...script, flags: [
      'shell script', 'makes network calls', 'existing project file outside the agent folder',
      'not referenced by any agent in this changeset', 'also used by agents/one.agentuse',
      'also used by tmp/two.agentuse', 'runs subprocesses or evaluates code',
    ] }} tab="diff" onTab={() => {}} />);
    expect(html).toContain('Shell script · Uses network');
    expect(html).toContain('Used by 2 other agents');
    expect(html).toContain('<details');
    expect(html).not.toContain('<details open');
    expect(html).toContain('tmp/two.agentuse');
    expect(html).not.toContain('not referenced');
    expect(html).not.toContain('outside the agent folder');
    expect(html).toContain('runs subprocesses or evaluates code');
  });

  it('shows the stored patch, capability changes, and flags', () => {
    const html = renderToString(<ChangesetFileView file={readme} tab="diff" onTab={() => {}} />);
    expect(html).toContain('docs/notes.md');
    expect(html).toContain('not referenced by any agent in this changeset');
    expect(html).toContain('is-remove');

    const agent = renderToString(<ChangesetFileView file={collector} tab="source" onTab={() => {}} />);
    expect(agent).toContain('Capability changes: gains bash: python3 agents/scrape.py');
    expect(agent).toContain('Collect.');
  });
});
