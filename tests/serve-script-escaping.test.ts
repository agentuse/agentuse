import { describe, expect, it } from 'bun:test';
import { jsonForScript } from '../src/cli/serve/ui';
import { __testing } from '../src/cli/serve';

describe('jsonForScript', () => {
  it('neutralizes closing-script and comment-opener sequences', () => {
    const out = jsonForScript({ body: '</scr' + 'ipt><img onerror=alert(1)>', c: '<!--' });
    // No literal "<" survives, so the HTML parser cannot end the <script> early.
    expect(out).not.toContain('<');
    expect(out).toContain('\\u003c');
    // Still valid JSON that round-trips to the original value.
    expect(JSON.parse(out)).toEqual({ body: '</scr' + 'ipt><img onerror=alert(1)>', c: '<!--' });
  });
});

describe('session page hydration escaping', () => {
  it('does not let a log entry break out of the inline <script>', () => {
    const malicious = '</scr' + 'ipt><img src=x onerror=alert(1)>';
    const approval = {
      sessionId: 'session-x',
      sessionStatus: 'suspended',
      model: 'anthropic:claude-haiku-4-5',
      agent: { id: 'agents/x', name: 'X', filePath: '/tmp/x.agentuse' },
      prompt: 'ok?',
      currentResumeToken: 'tok',
      decision: undefined,
      logs: [{
        id: 'p1',
        type: 'tool',
        tool: 'tools__filesystem_write',
        status: 'completed',
        title: 'wrote file',
        message: malicious,
        time: 1,
      }],
    };
    const html = __testing.renderSessionPage({
      approval: approval as never,
      token: 'sess-token',
      projectId: 'project-1',
      canAct: true,
    });
    // The dangerous payload is embedded only in its escaped < form...
    expect(html).toContain('\\u003c/scr' + 'ipt>');
    // ...and the raw closing-script + injected tag never appears verbatim.
    expect(html).not.toContain(malicious);
  });
});
