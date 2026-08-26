import { describe, expect, it } from 'bun:test';
import { buildCodingAgentPrompt } from '../src/cli/serve/web/routes/agent-detail';
import { buildDebugPrompt, buildOnboardingPrompt } from '../src/cli/serve/web/components/debug-prompt-button';

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

  it('hands onboarding to a coding agent without restarting serve or running real work', () => {
    const prompt = buildOnboardingPrompt({
      sessionId: '01ONBOARDING',
      projectId: 'demo',
      projectPath: '/workspace/acme-automations',
      agentName: 'Getting started',
      model: 'demo:hello',
    }, 'summarize new support tickets every morning');

    expect(prompt).toContain('Help me create my first AgentUse agent in this project.');
    expect(prompt).toContain('agentuse skills get onboarding --full');
    expect(prompt).toContain('AgentUse serve is already running');
    expect(prompt).toContain('Project directory: /workspace/acme-automations');
    expect(prompt).toContain('project directory is authoritative');
    expect(prompt).toContain('do not change its project settings or restart it');
    expect(prompt).toContain('summarize new support tickets every morning');
  });
});
