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
    expect(text).toContain("configuring the agent's chosen model provider");
    expect(text).toContain('running the agent directly');
    expect(text).toContain('agentuse serve');
    expect(text).toContain('credentials or environment variables');
  });
});
