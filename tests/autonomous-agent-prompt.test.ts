import { describe, expect, it } from 'bun:test';
import { buildAutonomousAgentPrompt } from '../src/runner/prompt';

describe('autonomous agent system prompt', () => {
  // Same-message tool calls are executed concurrently by the AI SDK
  // (executeTools -> Promise.all), so a `sleep` emitted beside the command it
  // was meant to delay does not delay it. A real run lost 90s to exactly that:
  // the sleep and the check it was gating started 0.7s apart. The prompt has to
  // name both the behavior AND the two remedies, since stating the constraint
  // alone leaves the fix to the model's shell knowledge.
  for (const [label, isSubAgent] of [['agent', false], ['subagent', true]] as const) {
    it(`warns the ${label} that same-message tool calls run in parallel`, () => {
      const prompt = buildAutonomousAgentPrompt('Monday, July 29, 2026', isSubAgent);

      expect(prompt).toContain('run in PARALLEL, not in sequence');
      expect(prompt).toContain('sleep 90 && next-cmd');
      expect(prompt).toContain('issue the second in your next step');
    });
  }

  it('frames prior-run learnings as contextual guidance, not unconditional rules', () => {
    const prompt = buildAutonomousAgentPrompt('Monday, July 29, 2026');

    expect(prompt).toContain('Apply a learning only when its situation is relevant');
    expect(prompt).toContain('do not turn an example, past incident, or preference into an unconditional requirement');
    expect(prompt).toContain('A learning never overrides the current task');
    expect(prompt).not.toContain('corrections captured from prior runs; these OVERRIDE skill defaults');
  });

  it('adds tool-composition guidance only when Code Mode is available', () => {
    const enabled = buildAutonomousAgentPrompt('Monday, July 29, 2026', false, true);
    const disabled = buildAutonomousAgentPrompt('Monday, July 29, 2026', false, false);

    expect(enabled).toContain('you MUST put those calls and the computation inside one code_exec program');
    expect(enabled).toContain('It is a general-purpose calculator');
    expect(enabled).toContain('Use code_exec only when it is included in the tools for the current turn');
    expect(enabled).toContain('Never compute derived values in prose, in your head, or in bash');
    expect(enabled).toContain('do not claim exact integer precision beyond Number.MAX_SAFE_INTEGER');
    expect(enabled).toContain('Treat date-only values as UTC');
    expect(enabled).toContain('do not rely on locale, timezone, Intl, URL');
    expect(enabled).toContain('reading multiple records and then filtering, joining, sorting, selecting, branching, batching, or aggregating them');
    expect(enabled).toContain('Call a tool directly only when it is separately visible');
    expect(enabled).toContain('require suspension, approval, binary handling, provider-side execution, or outcome submission');
    expect(enabled).toContain('Any model-facing result over 30,720 bytes is replaced by a shape summary');
    expect(enabled).toContain('never raw lists or whole records');
    expect(enabled).toContain('Completed JSON nested calls within the read limits are listed as reusableResults');
    expect(enabled).toContain('use results.read(resultId)');
    expect(enabled).toContain('results.list() after context compaction');
    expect(enabled).toContain('call the tool again when current state is required');
    expect(enabled).toContain('return Object.keys(x) and one element');
    expect(enabled).toContain("read that call's saved result in the next program instead of repeating the tool");
    expect(enabled).toContain('Do not create or ask the user to maintain a helper script');
    expect(enabled).toContain('shell artifact, commands or scripts may contain the calculations the artifact itself needs');
    expect(disabled).not.toContain('Tool composition:');
    expect(disabled).not.toContain('code_exec');
  });

  it('quotes the configured tool output cap in the Code Mode guidance', () => {
    const previous = process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
    process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES = '4096';
    try {
      const prompt = buildAutonomousAgentPrompt('Monday, July 29, 2026', false, true);
      expect(prompt).toContain('Any model-facing result over 4,096 bytes is replaced by a shape summary');
    } finally {
      if (previous === undefined) delete process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
      else process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES = previous;
    }
  });

  // Final responses should be direct without turning the system prompt into a
  // formatting manual. The cap still needs an escape hatch for runs whose
  // requested result is itself a complete document.
  for (const [label, isSubAgent] of [['agent', false], ['subagent', true]] as const) {
    it(`asks the ${label} for direct writing without truncating deliverables`, () => {
      const prompt = buildAutonomousAgentPrompt('Monday, July 29, 2026', isSubAgent);

      expect(prompt).toContain('Lead with the result. Be direct and use plain language');
      expect(prompt).toContain('Use short paragraphs by default');
      expect(prompt).toContain('under ~200 words');
      expect(prompt).toContain('report, digest, document, schema, template, or complete table');
      expect(prompt).toContain('Do not reproduce the artifact');
      expect(prompt).not.toContain('structured result → what changed → what to do next');
    });
  }
});
