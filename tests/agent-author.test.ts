import { describe, expect, it } from 'bun:test';
import { validateAuthoredAgentSource } from '../src/agents/author';
import { parseAgentContent } from '../src/parser';

const source = `---
name: Support Triage
model: opencode-go:glm-5.1
description: Triage support requests and surface urgent replies
---

## Task

Review the support requests supplied in the run prompt. Summarize themes and identify urgent replies.

## Output

Return a concise triage report with urgent items first.
`;

describe('authored agent validation', () => {
  it('rejects prose and runtime models outside the available candidates', () => {
    expect(() => validateAuthoredAgentSource(`Here is your agent:\n${source}`, ['opencode-go:glm-5.1']))
      .toThrow('commentary instead of an AgentUse file');
    expect(() => validateAuthoredAgentSource(source.replace('opencode-go:glm-5.1', 'openai:gpt-5.6'), ['opencode-go:glm-5.1']))
      .toThrow('runtime model that is not available');
  });

  it('rejects unsafe generated capabilities unless an effectful command is gated', () => {
    const unsafe = source.replace(
      'description: Triage support requests and surface urgent replies',
      `description: Triage support requests and surface urgent replies
tools:
  bash:
    commands:
      - git push *`,
    );
    expect(() => validateAuthoredAgentSource(unsafe, ['opencode-go:glm-5.1']))
      .toThrow('unsafe ungated command: git push *');

    const gated = unsafe.replace(
      '    commands:\n      - git push *',
      '    commands:\n      - git push *\n    gated:\n      - git *',
    );
    const authored = validateAuthoredAgentSource(gated, ['opencode-go:glm-5.1']);
    expect(authored.name).toBe('Support Triage');
    expect(authored.model).toBe('opencode-go:glm-5.1');
    expect(parseAgentContent(authored.source, '').config.approval).toBe(true);
  });

  it('accepts an explicitly requested notification channel', () => {
    const withChannel = source.replace(
      'description: Triage support requests and surface urgent replies',
      'description: Triage support requests and surface urgent replies\nchannels: [slack]',
    );
    const authored = validateAuthoredAgentSource(withChannel, ['opencode-go:glm-5.1']);
    expect(parseAgentContent(authored.source, '').config.channels?.slack).toBeDefined();
  });

  it('rejects generated schedules and trusted skills before persistence', () => {
    const scheduled = source.replace(
      'description: Triage support requests and surface urgent replies',
      'description: Triage support requests and surface urgent replies\nschedule: "0 9 * * *"',
    );
    expect(() => validateAuthoredAgentSource(scheduled, ['opencode-go:glm-5.1']))
      .toThrow('added a schedule before the agent was reviewed');

    const trusted = source.replace(
      'description: Triage support requests and surface urgent replies',
      'description: Triage support requests and surface urgent replies\nskills: trusted',
    );
    expect(() => validateAuthoredAgentSource(trusted, ['opencode-go:glm-5.1']))
      .toThrow('trusted a skill before the agent was reviewed');
  });

  it('requires every referenced installed skill to have been fully loaded', () => {
    const withSkill = source.replace(
      'description: Triage support requests and surface urgent replies',
      'description: Triage support requests and surface urgent replies\nskills:\n  auto: false\n  support-helper:',
    );
    expect(() => validateAuthoredAgentSource(
      withSkill,
      ['opencode-go:glm-5.1'],
      undefined,
      undefined,
      ['support-helper'],
      [],
    )).toThrow('without loading its complete SKILL.md first');
    expect(() => validateAuthoredAgentSource(
      withSkill,
      ['opencode-go:glm-5.1'],
      undefined,
      undefined,
      ['support-helper'],
      ['support-helper'],
    )).not.toThrow();
  });

  it('accepts only the exact schedule selected from project discovery', () => {
    const scheduled = source.replace(
      'description: Triage support requests and surface urgent replies',
      'description: Triage support requests and surface urgent replies\nschedule: "0 9 * * 1"',
    );
    expect(validateAuthoredAgentSource(scheduled, ['opencode-go:glm-5.1'], 'Support Triage', '0 9 * * 1').model)
      .toBe('opencode-go:glm-5.1');
    expect(() => validateAuthoredAgentSource(scheduled, ['opencode-go:glm-5.1'], 'Support Triage', '0 8 * * 1'))
      .toThrow('did not use the requested schedule');
  });
});
