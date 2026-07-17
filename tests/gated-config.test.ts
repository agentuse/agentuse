import { describe, test, expect } from 'bun:test';
import { parseAgentContent } from '../src/parser';
import { getTools } from '../src/tools';

function agentMd(frontmatter: string): string {
  return `---\n${frontmatter}\n---\n\nDo the task.\n`;
}

describe('gated command config (agentuse-lab#165/#169)', () => {
  test('parses tools.bash.gated alongside approval', () => {
    const agent = parseAgentContent(agentMd([
      'model: "anthropic:claude-test"',
      'approval: true',
      'tools:',
      '  bash:',
      '    commands: ["birdc read *"]',
      '    gated:',
      '      - "birdc reply *"',
      '      - "birdc tweet *"',
    ].join('\n')), 'x-reply');
    expect(agent.config.tools?.bash?.gated).toEqual(['birdc reply *', 'birdc tweet *']);
  });

  test('gated with tools.await_human (no approval key) is valid, approval NOT derived', () => {
    const agent = parseAgentContent(agentMd([
      'model: "anthropic:claude-test"',
      'tools:',
      '  await_human: true',
      '  bash:',
      '    commands: ["curl *"]',
      '    gated: ["curl -X POST *"]',
    ].join('\n')), 'poster');
    expect(agent.config.tools?.bash?.gated).toEqual(['curl -X POST *']);
    // The explicit await_human gate already covers gated commands, so approval
    // stays unset (not derived).
    expect(agent.config.approval).toBeUndefined();
  });

  test('gated WITHOUT any approval gate DERIVES approval (no throw)', () => {
    // The pre-#169 behavior threw "requires an approval gate". Now gated implies
    // the approval machinery instead of erroring.
    const agent = parseAgentContent(agentMd([
      'model: "anthropic:claude-test"',
      'tools:',
      '  bash:',
      '    commands: ["birdc read *"]',
      '    gated: ["birdc reply *"]',
    ].join('\n')), 'derived');
    expect(agent.config.approval).toBe(true);
    expect(agent.config.tools?.bash?.gated).toEqual(['birdc reply *']);
  });

  test('empty gated list needs no gate and derives nothing', () => {
    const agent = parseAgentContent(agentMd([
      'model: "anthropic:claude-test"',
      'tools:',
      '  bash:',
      '    commands: ["ls *"]',
      '    gated: []',
    ].join('\n')), 'plain');
    expect(agent.config.tools?.bash?.gated).toEqual([]);
    expect(agent.config.approval).toBeUndefined();
  });

  test('effective allowlist is commands ∪ gated: a gated-only command still builds a bash tool', () => {
    // A gated pattern is runnable (the lease governs WHEN, not WHETHER allowed),
    // so the bash tool is created even when `commands` is empty.
    const tools = getTools(
      { bash: { commands: [], gated: ['birdc reply *'] } },
      { projectRoot: '/tmp', agentDir: '/tmp' } as any
    );
    expect(tools['tools__bash']).toBeDefined();
  });

  test('the old top-level effects: key is gone (silently ignored, not honored)', () => {
    const agent = parseAgentContent(agentMd([
      'model: "anthropic:claude-test"',
      'approval: true',
      'effects: ["birdc reply *"]',
    ].join('\n')), 'legacy');
    // effects is no longer part of the schema; it is stripped, and nothing gated.
    expect((agent.config as any).effects).toBeUndefined();
    expect(agent.config.tools?.bash?.gated).toBeUndefined();
  });
});
