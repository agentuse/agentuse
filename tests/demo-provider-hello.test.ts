import { describe, expect, it } from 'bun:test';
import { createDemoModel } from '../src/providers/demo';

describe('hello demo model', () => {
  it('returns the skill install command and a copy-ready first-agent prompt', async () => {
    const result = await createDemoModel('hello').doGenerate({} as never);
    const text = result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');

    expect(text).toContain('npx skills add agentuse/agentuse');
    expect(text).toContain('Help me create my first AgentUse agent.');
    expect(text).toContain('If I have not described the recurring job yet, interview me');
    expect(text).not.toContain('[describe the recurring job]');
    expect(text).toContain('agentuse doctor');
    expect(text).toContain('agentuse test');
    expect(text).toContain('Create my first agent…');
    expect(text).toContain('agentuse provider list');
    expect(text).toContain('model from a configured provider');
    expect(text).toContain('launching the first real run from the Web UI');
    expect(text).toContain('agentuse serve');
    expect(text).toContain('AgentUse detects the new file automatically');
    expect(text).toContain('Do not start a real run automatically');
  });

  it('returns a useful simulated result for the Web UI onboarding run', async () => {
    const result = await createDemoModel('onboarding').doGenerate({} as never);
    const text = result.content
      .filter((part) => part.type === 'text')
      .map((part) => part.text)
      .join('');

    expect(text).toContain('# Project pulse');
    expect(text).toContain('## Progress');
    expect(text).toContain('## Needs attention');
    expect(text).toContain('## Recommended next move');
    expect(text).toContain('Simulated run');
    expect(text).toContain('sample project data');
    expect(text).toContain('## Create your own agent');
    expect(text).toContain('Create my first agent…');
    expect(text).toContain('Copy the generated prompt');
    expect(text).toContain('Keep this dashboard open');
    expect(text).toContain('select **Run**');
    expect(text).not.toContain('npx skills add');
  });
});
