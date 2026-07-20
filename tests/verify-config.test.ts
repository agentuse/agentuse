import { describe, it, expect } from 'bun:test';
import { parseAgentContent } from '../src/parser';

describe('verify config parsing', () => {
  it('expands verify: true to the generic-rubric canonical form', () => {
    const agent = parseAgentContent(`---
model: anthropic:claude-sonnet-4-0
verify: true
---

Do the task.`, 'test');

    expect(agent.config.verify).toEqual({ maxRedos: 1 });
  });

  it('expands a criteria string shorthand', () => {
    const agent = parseAgentContent(`---
model: anthropic:claude-sonnet-4-0
verify: "no fabricated claims"
---

Do the task.`, 'test');

    expect(agent.config.verify).toEqual({ criteria: 'no fabricated claims', maxRedos: 1 });
  });

  it('defaults maxRedos to 1 in the object form', () => {
    const agent = parseAgentContent(`---
model: anthropic:claude-sonnet-4-0
verify:
  criteria: complete and grounded
  model: openai:gpt-5.2-mini
---

Do the task.`, 'test');

    expect(agent.config.verify).toEqual({
      criteria: 'complete and grounded',
      model: 'openai:gpt-5.2-mini',
      maxRedos: 1
    });
  });

  it('accepts a judge agent path with maxRedos', () => {
    const agent = parseAgentContent(`---
model: anthropic:claude-sonnet-4-0
verify:
  judge: ./shared/reply-judge.agentuse
  maxRedos: 2
---

Do the task.`, 'test');

    expect(agent.config.verify).toEqual({ judge: './shared/reply-judge.agentuse', maxRedos: 2 });
  });

  it('rejects criteria combined with judge', () => {
    const content = `---
model: anthropic:claude-sonnet-4-0
verify:
  criteria: some rubric
  judge: ./judge.agentuse
---

Do the task.`;
    expect(() => parseAgentContent(content, 'test')).toThrow('Invalid agent configuration');
  });

  it('rejects model combined with judge', () => {
    const content = `---
model: anthropic:claude-sonnet-4-0
verify:
  judge: ./judge.agentuse
  model: openai:gpt-5.2-mini
---

Do the task.`;
    expect(() => parseAgentContent(content, 'test')).toThrow('Invalid agent configuration');
  });

  it('rejects unknown keys and out-of-range maxRedos', () => {
    expect(() => parseAgentContent(`---
model: anthropic:claude-sonnet-4-0
verify:
  criteria: x
  retries: 3
---

Task.`, 'test')).toThrow('Invalid agent configuration');

    expect(() => parseAgentContent(`---
model: anthropic:claude-sonnet-4-0
verify:
  maxRedos: 99
---

Task.`, 'test')).toThrow('Invalid agent configuration');
  });
});
