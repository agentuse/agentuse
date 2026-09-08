import { afterEach, describe, expect, it, spyOn } from 'bun:test';
import * as completion from '../src/complete-text';
import { reviewAuthoredAgentCapabilities } from '../src/agents/capability-review';
import { createSubmitAgentSourceTool } from '../src/onboarding/submit-agent-source';
import { AgentCreationError } from '../src/agents/create';
import { createBuiltinSkillTool } from '../src/onboarding/builtin-skill-tool';
import { loadAgentTools } from '../src/runner/tools-loader';
import { parseAgentContent } from '../src/parser';

const source = `---
name: Agent linter
model: openai:gpt-5.6-luna
description: Validate agent definitions
skills:
  auto: false
tools:
  filesystem:
    - path: \${root}
      permissions: [read]
---
Return exact parser errors for each .agentuse file.
`;
let complete: ReturnType<typeof spyOn> | undefined;
afterEach(() => { complete?.mockRestore(); complete = undefined; });

describe('creator capability review', () => {
  it('sends the actual declared configuration to a separate review and returns concrete gaps', async () => {
    complete = spyOn(completion, 'completeText').mockResolvedValue(JSON.stringify({ issues: [{
      quote: 'Return exact parser errors', missingCapability: 'Filesystem reads cannot execute the parser.',
      correction: 'Declare a narrow parser command or state that machine validation is unavailable.',
    }] }));
    await expect(reviewAuthoredAgentCapabilities(source, 'openai:gpt-5.6-luna', 'Lint agents'))
      .rejects.toThrow('Filesystem reads cannot execute the parser');
    const [model, options] = complete.mock.calls[0]!;
    expect(model).toBe('openai:gpt-5.6-luna');
    const evidence = JSON.parse(options.prompt);
    expect(evidence.source).toBe(source);
    expect(evidence.declaredConfiguration.tools.filesystem).toEqual([{ path: '${root}', permissions: ['read'] }]);
    expect(evidence.declaredConfiguration.tools.bash).toBeUndefined();
    expect(options).not.toHaveProperty('tools');
  });

  it('accepts an empty review and fails closed on malformed or unsupported findings', async () => {
    complete = spyOn(completion, 'completeText').mockResolvedValue('{"issues":[]}');
    await expect(reviewAuthoredAgentCapabilities(source, 'openai:gpt-5.6-luna', undefined)).resolves.toBeUndefined();
    complete.mockResolvedValue('looks good');
    await expect(reviewAuthoredAgentCapabilities(source, 'openai:gpt-5.6-luna', undefined)).rejects.toThrow('valid, source-grounded');
    complete.mockResolvedValue(JSON.stringify({ issues: [{ quote: 'invented source quote', missingCapability: 'x', correction: 'y' }] }));
    await expect(reviewAuthoredAgentCapabilities(source, 'openai:gpt-5.6-luna', undefined)).rejects.toThrow('valid, source-grounded');
  });

  it('honors cancellation before starting the helper request', async () => {
    complete = spyOn(completion, 'completeText').mockResolvedValue('{"issues":[]}');
    const controller = new AbortController();
    controller.abort();
    await expect(reviewAuthoredAgentCapabilities(source, 'openai:gpt-5.6-luna', undefined, controller.signal)).rejects.toThrow();
    expect(complete).not.toHaveBeenCalled();
  });

  it('serializes submissions while a capability review is in flight', async () => {
    let finish: (() => void) | undefined;
    const submission: { source?: string } = {};
    const tool = createSubmitAgentSourceTool(submission, { availableModels: ['openai:gpt-5.6-luna'] }, undefined, undefined,
      () => new Promise<void>((resolve) => { finish = resolve; }));
    const execute = tool.execute as any;
    const input = { name: 'Agent linter', filename: 'agent-linter.agentuse', source };
    const first = execute(input);
    await expect(execute(input)).rejects.toThrow('already being reviewed');
    expect(submission.source).toBeUndefined();
    finish!();
    await expect(first).resolves.toContain('capability review');
    expect(submission.source).toBe(source);
  });

  it('never persists or checkpoints source rejected by the capability reviewer', async () => {
    const submission: { source?: string } = {};
    let checkpoints = 0;
    let reviews = 0;
    const tool = createSubmitAgentSourceTool(submission, { availableModels: ['openai:gpt-5.6-luna'] }, undefined, {
      append: () => {}, checkpoint: () => { checkpoints++; },
    }, async () => { reviews++; throw new AgentCreationError('INVALID_GENERATED_AGENT', 'Parser capability missing'); });
    const execute = tool.execute as any;
    await expect(execute({ name: 'Agent linter', filename: 'agent-linter.agentuse', source: 'invalid' })).rejects.toThrow('Source rejected');
    expect(reviews).toBe(0);
    await expect(execute({ name: 'Agent linter', filename: 'agent-linter.agentuse', source })).rejects.toThrow('Parser capability missing');
    expect(reviews).toBe(1);
    expect(submission.source).toBeUndefined();
    expect(checkpoints).toBe(0);
  });
});

describe('creator builtin references', () => {
  it('reads version-matched core, creator, and tester without project skills or bash', async () => {
    const tool = createBuiltinSkillTool();
    for (const name of ['core', 'creator', 'tester']) {
      const result = await (tool.execute as any)({ name });
      expect(result.source).toBe('builtin');
      expect(result.content).toContain(`name: ${name}`);
    }
    await expect((tool.execute as any)({ name: '../package.json' })).rejects.toThrow('Invalid builtin skill name');
  });

  it('does not add creator reference tools to ordinary agents', async () => {
    const loaded = await loadAgentTools({ agent: parseAgentContent(source, 'linter'), mcpConnections: [] });
    expect(loaded.all.tools__builtin_skill_read).toBeUndefined();
    expect(loaded.all.submit_agent_source).toBeUndefined();
  });
});
