import { describe, it, expect, beforeAll, beforeEach, mock } from "bun:test";

// Ensure no module mocks leak from other files
mock.restore();
import type { AgentCompleteEvent } from "../src/plugin/types";

// evaluateExecution now goes through completeText() (streaming) instead of
// generateText(), which is required for the ChatGPT Codex backend. Mock
// completeText to return the raw model text directly.
const completeTextMock = mock(async () => "[]");

mock.module("../src/complete-text", () => ({
  completeText: completeTextMock,
}));

let evaluateExecution: typeof import("../src/learning/evaluator").evaluateExecution;

const baseEvent: AgentCompleteEvent = {
  agent: { name: "demo-agent", model: "gpt-4" },
  result: {
    text: "complete",
    duration: 1.2,
    toolCalls: 0,
    hasTextOutput: true,
  },
  isSubAgent: false,
  consoleOutput: "Execution logs",
};

beforeAll(async () => {
  ({ evaluateExecution } = await import("../src/learning/evaluator"));
});

beforeEach(() => {
  completeTextMock.mockReset();
});

describe("evaluateExecution", () => {
  it("returns only high-confidence learnings with metadata", async () => {
    completeTextMock.mockImplementation(async () =>
      JSON.stringify([
        {
          category: "tip",
          title: "Cache responses",
          instruction: "Cache tool responses to reduce latency.",
          confidence: 0.9,
        },
        {
          category: "warning",
          title: "Low confidence",
          instruction: "Ignore",
          confidence: 0.5,
        },
      ]),
    );

    const result = await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "anthropic-sonnet",
      freeform: {},
    });

    expect(result).toHaveLength(1);
    const [learning] = result;
    expect(learning.category).toBe("tip");
    expect(learning.injectedCount).toBe(0);
    expect(learning.id).toHaveLength(8);
    expect(new Date(learning.extractedAt).toString()).not.toBe("Invalid Date");
  });

  it("parses learnings from markdown code blocks", async () => {
    completeTextMock.mockImplementation(async () =>
      "```json\n[{\"category\":\"pattern\",\"title\":\"Fallbacks\",\"instruction\":\"Use fallback prompts when tools fail.\",\"confidence\":0.82}]\n```",
    );

    const result = await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: {},
    });

    expect(result).toHaveLength(1);
    expect(result[0].category).toBe("pattern");
    expect(result[0].confidence).toBeCloseTo(0.82);
  });

  it("returns empty array when response is not valid JSON", async () => {
    completeTextMock.mockImplementation(async () => "not json");

    const result = await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: {},
    });
    expect(result).toEqual([]);
  });

  it("includes structured tool outputs (not just inputs) in the evaluation prompt", async () => {
    completeTextMock.mockImplementation(async () => "[]");

    const eventWithTraces: AgentCompleteEvent = {
      ...baseEvent,
      result: {
        ...baseEvent.result,
        toolCalls: 1,
        toolCallTraces: [
          {
            name: "search",
            type: "tool",
            startTime: 0,
            duration: 12,
            success: true,
            input: { query: "pricing" },
            output: "No results found for 'pricing'",
          },
        ],
      },
    };

    await evaluateExecution({
      event: eventWithTraces,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: {},
    });

    const [, opts] = completeTextMock.mock.calls[0] as unknown as [string, { prompt: string }];
    expect(opts.prompt).toContain("Input: {\"query\":\"pricing\"}");
    expect(opts.prompt).toContain("Output: No results found for 'pricing'");
  });

  it("surfaces reviewer feedback in the prompt and trusts approval learnings at 0.95", async () => {
    completeTextMock.mockImplementation(async () =>
      JSON.stringify([
        {
          source: "approval",
          category: "warning",
          title: "Avoid salesy intros",
          instruction: "Keep intros factual; avoid promotional language.",
          confidence: 0.7,
        },
      ]),
    );

    // Corrections-only (freeform: false) is the default mode, and a reviewer
    // comment is exactly what it exists to capture.
    const result = await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: false,
      reviews: [{ comment: "this intro is too salesy", work: "Draft: Unlock the AMAZING secret!!!" }],
    });

    const [, opts] = completeTextMock.mock.calls[0] as unknown as [string, { prompt: string }];
    expect(opts.prompt).toContain("Reviewer Feedback");
    expect(opts.prompt).toContain("this intro is too salesy");
    expect(opts.prompt).toContain("Unlock the AMAZING secret");

    // Human-sourced: kept despite confidence < 0.8, stored at the trusted 0.95.
    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("approval");
    expect(result[0].confidence).toBe(0.95);
  });

  it("forces source to 'auto' when the model claims approval but there were no reviews", async () => {
    completeTextMock.mockImplementation(async () =>
      JSON.stringify([
        {
          source: "approval",
          category: "tip",
          title: "Hallucinated provenance",
          instruction: "Should be tagged auto, not approval.",
          confidence: 0.9,
        },
      ]),
    );

    const result = await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: {},
    });

    expect(result).toHaveLength(1);
    expect(result[0].source).toBe("auto");
    expect(result[0].confidence).toBe(0.9);
  });

  const rule = (i: number) => ({
    id: `rule000${i}`,
    category: "warning" as const,
    title: `Rule ${i}`,
    instruction: `Skip subject ${i} entirely.`,
    confidence: 0.95,
    injectedCount: 0,
    extractedAt: "2026-07-01T00:00:00.000Z",
    source: "approval" as const,
    reasserted: 0,
    approvedRuns: 0,
  });

  it("demands a fold from every learning once the set is full, reviewer ones included", async () => {
    completeTextMock.mockImplementation(async () => "[]");
    const active = [rule(0), rule(1), rule(2)];

    await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: {},
      existingLearnings: active,
      capacity: { cap: 3 },
    });

    const prompt = String(completeTextMock.mock.calls[0]?.[1]?.prompt ?? "");
    expect(prompt).toContain("The set is FULL (3/3)");
    expect(prompt).toContain("EVERY learning you return must set \"supersedes\"");
    // The carve-out that let a reviewer correction land without folding is what
    // built the backlog: rules past the cap are never injected, so they can
    // neither prove themselves nor be evicted.
    expect(prompt).toContain("applies to reviewer-sourced learnings too");
    // Folding must not be read as picking a winner.
    expect(prompt).toContain("satisfies both");
  });

  it("reads the permanent block from the agent file, however far down it sits", async () => {
    // The block is appended to the END of the agent file, and the body used to be
    // cut at 3000 characters, so on any real agent it fell outside the cut and
    // this pass never saw it. Measured on one: 46,063-character file, block at
    // 30,685. That blindness was the only reason a duplicate of every permanent
    // rule had to be kept in the store — and the duplicate is what let a human's
    // edits to the block be overwritten.
    completeTextMock.mockImplementation(async () => "[]");
    const instructions = [
      "x".repeat(30_000),
      "<!-- agentuse:learned -->",
      "## Learned Guidelines",
      "",
      "- [warning] Never cite a summary when the primary source exists.",
      "<!-- /agentuse:learned -->",
    ].join("\n");

    await evaluateExecution({
      event: baseEvent,
      agentInstructions: instructions,
      model: "gpt-4",
      freeform: {},
      existingLearnings: [rule(0)],
      capacity: { cap: 3 },
    });

    const prompt = String(completeTextMock.mock.calls[0]?.[1]?.prompt ?? "");
    expect(prompt).toContain("Never cite a summary when the primary source exists.");
    expect(prompt).toContain("Already Permanent");
    // And the body itself now reaches the prompt WHOLE: the fixed 3,000-character
    // cut is gone, because an evaluator that cannot see the contract cannot avoid
    // duplicating or contradicting it.
    expect(prompt).toContain("x".repeat(30_000));
    // The block is excised from the body rather than left in it, so the permanent
    // rules are shown once, under their own heading.
    expect(prompt).not.toContain("<!-- agentuse:learned -->");
  });

  it("discards execution-derived learnings in corrections-only mode", async () => {
    // freeform: false is the default. The prompt says not to return "auto"
    // learnings, but the guarantee is in code: a model that returns them anyway
    // must not be able to manufacture policy from a run nobody reviewed.
    completeTextMock.mockImplementation(async () =>
      JSON.stringify([
        { source: "auto", category: "tip", title: "From the run", instruction: "Do a thing the run suggested.", confidence: 0.95 },
        { source: "approval", category: "warning", title: "From the reviewer", instruction: "Keep intros factual.", confidence: 0.95 },
      ]),
    );

    const result = await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: false,
      reviews: [{ comment: "too salesy" }],
    });

    expect(result).toHaveLength(1);
    expect(result[0]!.source).toBe("approval");
    expect(result[0]!.channel).toBe("corrections");

    const prompt = String(completeTextMock.mock.calls[0]?.[1]?.prompt ?? "");
    expect(prompt).toContain("captures human corrections only");
  });

  it("scopes execution-derived capture to the custom guidance when one is given", async () => {
    completeTextMock.mockImplementation(async () => "[]");

    await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: { guidance: "Only record failures of the publishing API." },
    });

    const prompt = String(completeTextMock.mock.calls[0]?.[1]?.prompt ?? "");
    expect(prompt).toContain("Only record failures of the publishing API.");
    expect(prompt).toContain("Additional evaluation criteria");
  });

  it("stamps drafts with the injection counter at zero and a capture channel", async () => {
    completeTextMock.mockImplementation(async () =>
      JSON.stringify([
        { source: "auto", category: "tip", title: "Observed", instruction: "Narrow the query before widening it.", confidence: 0.9 },
      ]),
    );

    const result = await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: {},
    });

    // `injectedCount` counts cost, not value — it starts at zero and is never
    // seeded from the model's output.
    expect(result[0]!.injectedCount).toBe(0);
    expect(result[0]!.channel).toBe("custom");
  });

  it("asks for reconciliation but not a fold while the set has room", async () => {
    completeTextMock.mockImplementation(async () => "[]");

    await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: {},
      existingLearnings: [rule(0)],
      capacity: { cap: 3 },
    });

    const prompt = String(completeTextMock.mock.calls[0]?.[1]?.prompt ?? "");
    expect(prompt).toContain("CONTRADICT an existing rule");
    expect(prompt).not.toContain("The set is FULL");
  });

  it("asks for a rule, not an essay", async () => {
    // Captured rules were arriving as multi-section documents — measured on one
    // fleet agent, five rules of 3,400 to 6,100 characters each, which is what a
    // permanent block of 24,000 characters is made of. A bare character limit
    // did not hold, and the example format said "Detailed instruction", which
    // asked for the opposite of what the limit wanted.
    completeTextMock.mockImplementation(async () => "[]");

    await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: {},
    });

    const prompt = String(completeTextMock.mock.calls[0]?.[1]?.prompt ?? "");
    expect(prompt).toContain("One rule, one behaviour");
    expect(prompt).toContain("State the behaviour, not the incident");
    expect(prompt).toContain("No preamble, no justification");
    // The example is the strongest instruction in any prompt: it must show a
    // real short rule rather than describe a long one.
    expect(prompt).not.toContain("Detailed instruction");
    expect(prompt).toContain("Keep intros factual. No promotional language.");
  });

  it("tells an Anthropic model what job it is doing, and asks for it short", async () => {
    // The system prompt used to be a ternary: identity OR role. Every agent in
    // an Anthropic-authed fleet took the identity branch, so the extractor was
    // never told it was extracting, and the one place conciseness could be
    // demanded outside the buried user prompt went unused.
    completeTextMock.mockImplementation(async () => "[]");

    await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "anthropic:claude-opus-5",
      freeform: {},
    });

    const [, opts] = completeTextMock.mock.calls[0] as unknown as [string, { instructions: string; extraSystem?: string }];
    expect(opts.instructions).toBe("You are Claude Code, Anthropic's official CLI for Claude.");
    expect(opts.extraSystem).toContain("high-signal learnings");
    expect(opts.extraSystem).toContain("never a document");
  });

  it("only accepts a supersedes id the model was actually shown", async () => {
    completeTextMock.mockImplementation(async () =>
      JSON.stringify([
        { source: "auto", category: "tip", title: "Real", instruction: "Fold into a real rule.", confidence: 0.9, supersedes: "rule0001" },
        { source: "auto", category: "tip", title: "Bogus", instruction: "Fold into a rule that does not exist.", confidence: 0.9, supersedes: "made-up" },
      ]),
    );

    const result = await evaluateExecution({
      event: baseEvent,
      agentInstructions: "Agent instructions",
      model: "gpt-4",
      freeform: {},
      existingLearnings: [rule(0), rule(1)],
      capacity: { cap: 2 },
    });

    // A hallucinated id must fall through to the store's capacity handling. A
    // fold that quietly became an append is the exact failure this prevents.
    expect(result[0].supersedes).toBe("rule0001");
    expect(result[1].supersedes).toBeUndefined();
  });
});
