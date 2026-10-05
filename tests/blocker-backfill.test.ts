import { describe, expect, it } from 'bun:test';
import { classifyStoredRun, inferBlocker } from '../src/session/blocker-backfill';
import type { ToolPart } from '../src/session/types';

const part = (tool: string, state: Record<string, unknown>, parentCallID?: string) =>
  ({ type: 'tool', tool, state, ...(parentCallID && { parentCallID }) }) as unknown as ToolPart;

describe('inferBlocker', () => {
  const cases: Array<[string, string, string]> = [
    ['No new articles started: content/registry.yaml is still cut off and must be restored from git.', 'bad_input', 'content/registry.yaml'],
    ['Quote creation is blocked: the R2 uploader lacks boto3; install the dependency.', 'missing_package', 'boto3'],
    ['Measurement is blocked: `ego-browser` is unavailable on PATH; restore the CLI access.', 'missing_tool', 'ego-browser'],
    ['Quora measurement is blocked by a Cloudflare security challenge.', 'no_access', 'quora.com'],
    ['Tender-offer scan failed with an HTTP 500; restore data access.', 'service_down', 'service'],
    ['Nothing drafted: an earlier draft has been waiting for your approval for about 96 hours.', 'waiting_on_human', 'approval'],
    ['The reply draft was rejected at the approval gate; nothing was posted.', 'rejected_by_human', 'approval'],
  ];
  for (const [message, kind, subject] of cases) {
    it(`reads ${kind} from "${message.slice(0, 40)}…"`, () => {
      expect(inferBlocker(message, 'agents/x')).toEqual({ kind: kind as any, subject, source: 'inferred' });
    });
  }

  it('falls back to the agent so a run still groups with its own repeats', () => {
    expect(inferBlocker('Something odd happened.', 'agents/x')).toEqual({ kind: 'other', subject: 'agents/x', source: 'inferred' });
  });
});

describe('classifyStoredRun', () => {
  it('prefers a stored tool error the reason names over any guess', () => {
    const parts = [part('bash', { status: 'error', error: '/bin/sh: birdc: command not found\nexit code: 127' }, 'c1')];
    expect(classifyStoredRun('Source selection is blocked because `birdc` is unavailable', 'a', parts))
      .toEqual({ kind: 'missing_tool', subject: 'birdc', source: 'runtime' });
  });

  it('reads a rejected gate from the approval record unless the agent reported another failure', () => {
    const gate = part('await_human', { status: 'completed', input: { prompt: 'Post this reply?' }, output: { status: 'reject' } });
    expect(classifyStoredRun('Nothing was posted.', 'a', [gate]))
      .toEqual({ kind: 'rejected_by_human', subject: 'Post this reply?', source: 'approval' });
    const alsoBroken = part('report_outcome', { status: 'completed', input: { status: 'incomplete', headline: 'x', rejectionOnly: false } });
    expect(classifyStoredRun('Nothing was posted.', 'a', [gate, alsoBroken]).source).toBe('inferred');
  });
});
