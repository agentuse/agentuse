import { describe, test, expect } from 'bun:test';
import { parseAgentContent } from '../src/parser';

function agentMd(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\nDo the task.\n`;
}

describe('effects frontmatter (agentuse-lab#165 Phase 2)', () => {
  test('parses effects patterns alongside approval', () => {
    const agent = parseAgentContent(agentMd([
      'model: "anthropic:claude-test"',
      'approval: true',
      'effects:',
      '  - "birdc reply *"',
      '  - "birdc tweet *"',
    ].join('\n')), 'x-reply');
    expect(agent.config.effects).toEqual(['birdc reply *', 'birdc tweet *']);
  });

  test('effects with tools.await_human (no approval key) is valid', () => {
    const agent = parseAgentContent(agentMd([
      'model: "anthropic:claude-test"',
      'tools:',
      '  await_human: true',
      'effects:',
      '  - "curl -X POST *"',
    ].join('\n')), 'poster');
    expect(agent.config.effects).toEqual(['curl -X POST *']);
  });

  test('effects WITHOUT any approval gate is rejected (dead-end config)', () => {
    expect(() => parseAgentContent(agentMd([
      'model: "anthropic:claude-test"',
      'effects:',
      '  - "birdc reply *"',
    ].join('\n')), 'no-gate')).toThrow(/requires an approval gate/);
  });

  test('empty effects list is a no-op and needs no gate', () => {
    const agent = parseAgentContent(agentMd([
      'model: "anthropic:claude-test"',
      'effects: []',
    ].join('\n')), 'plain');
    expect(agent.config.effects).toEqual([]);
  });
});
