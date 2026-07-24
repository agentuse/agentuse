import { describe, expect, it } from 'bun:test';
import { buildCodingAgentPrompt } from '../src/cli/serve/web/routes/agent-detail';
import { buildDebugPrompt } from '../src/cli/serve/web/components/debug-prompt-button';

describe('coding-agent handoff prompts', () => {
  it('requires the creator skill before reviewing or editing agent source', () => {
    const prompt = buildCodingAgentPrompt({
      project: 'demo',
      path: 'agents/reporter.agentuse',
      source: '---\nmodel: demo:test\n---\n\nReport.',
      detail: '',
    });

    expect(prompt).toContain('agentuse skills get core --full');
    expect(prompt).toContain('agentuse skills get creator --full');
    expect(prompt).toContain('compressed, not crammed');
    expect(prompt).toContain('agentuse doctor agents/reporter.agentuse');
  });

  it('loads creator conditionally before a debug handoff edits an agent', () => {
    const prompt = buildDebugPrompt({
      sessionId: '01TESTSESSION',
      agentName: 'reporter',
      agentFilePath: 'agents/reporter.agentuse',
    });

    expect(prompt).toContain('Before editing any `.agentuse` file');
    expect(prompt).toContain('agentuse skills get core --full');
    expect(prompt).toContain('agentuse skills get creator --full');
    expect(prompt).toContain('agentuse doctor <agent-file>');
  });
});
