import { describe, expect, it } from 'bun:test';
import { agentGroupKey, groupBrokenRuns, waitingRunsByAgent } from '../src/cli/serve/web/components/attention-groups';
import { groupPendingByAgent } from '../src/cli/serve/web/components/pending-approval-card';
import type { ApprovalRow, SessionRow } from '../src/cli/serve/web/lib/api';

let seq = 0;
function run(agent: string, fields: Partial<SessionRow> = {}): SessionRow {
  seq += 1;
  return {
    sessionId: `s${seq}`,
    project: 'p',
    agent: { id: agent, name: agent },
    status: 'error',
    trigger: 'scheduled',
    createdAt: seq * 1000,
    updatedAt: seq * 1000,
    ...fields,
  } as SessionRow;
}

describe('groupBrokenRuns', () => {
  it('folds one blocker across agents into one group, biggest first', () => {
    const groups = groupBrokenRuns([
      run('scout', { errorCode: 'INCOMPLETE', errorCause: 'missing_tool', errorSubject: 'birdc', errorCauseSource: 'agent' }),
      run('blog', { errorCode: 'INCOMPLETE', errorCause: 'bad_input', errorSubject: 'content/registry.yaml' }),
      run('linkedin', { errorCode: 'INCOMPLETE', errorCause: 'missing_tool', errorSubject: '`Birdc`', errorCauseSource: 'runtime', errorMessage: 'birdc missing' }),
    ]);
    expect(groups.map((g) => [g.label, g.subject, g.rows.length])).toEqual([
      ['Missing tool', 'birdc', 2],
      ['Bad input', 'content/registry.yaml', 1],
    ]);
    // The newest run speaks for the group, with how its blocker was established.
    expect(groups[0]!.agents).toEqual(['scout', 'linkedin']);
    expect(groups[0]!.source).toBe('runtime');
    expect(groups[0]!.latest.errorMessage).toBe('birdc missing');
  });

  it('groups a failure with no blocker per agent and cause, and never lists a person-blocked run', () => {
    const groups = groupBrokenRuns([
      run('mailer', { errorCode: 'TIMEOUT' }),
      run('mailer', { errorCode: 'TIMEOUT' }),
      run('blog', { errorCode: 'INCOMPLETE' }),
      run('reddit', { errorCode: 'INCOMPLETE', errorCause: 'waiting_on_human', errorSubject: 'approval' }),
    ]);
    expect(groups.map((g) => [g.label, g.subject, g.rows.length])).toEqual([
      ['TIMEOUT', 'mailer', 2],
      ['Incomplete, no blocker', 'blog', 1],
    ]);
  });
});

describe('waitingRunsByAgent', () => {
  it('counts person-blocked runs under the key their agent gates group by', () => {
    const waiting = [
      run('reddit', { errorCode: 'INCOMPLETE', errorCause: 'waiting_on_human' }),
      run('reddit', { errorCode: 'INCOMPLETE', errorCause: 'waiting_on_human' }),
      run('reddit', { errorCode: 'INCOMPLETE', errorCause: 'rejected_by_human' }),
    ];
    const gate = { project: 'p', sessionId: 'g1', agentId: 'reddit', agentName: 'reddit', createdAt: 1 } as ApprovalRow;
    const [group] = groupPendingByAgent([gate]);
    expect(agentGroupKey('p', waiting[0]!.agent)).toBe(group!.key);
    expect(waitingRunsByAgent(waiting).get(group!.key)).toBe(2);
  });
});
