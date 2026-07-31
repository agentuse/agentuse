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

  // Final responses are skimmed as a feed of cards, so an unbounded report
  // buries the outcome. The cap needs its escape hatches stated inline: agents
  // whose whole deliverable IS the response (digests, reports) must not get
  // truncated, and the biggest single source of bloat is an agent restating a
  // file or PR it already wrote.
  for (const [label, isSubAgent] of [['agent', false], ['subagent', true]] as const) {
    it(`caps the ${label}'s final output length and forbids restating deliverables`, () => {
      const prompt = buildAutonomousAgentPrompt('Monday, July 29, 2026', isSubAgent);

      expect(prompt).toContain('~200 words is the ceiling');
      expect(prompt).toContain('report, digest, or document');
      expect(prompt).toContain('Never restate its contents');
    });
  }
});
