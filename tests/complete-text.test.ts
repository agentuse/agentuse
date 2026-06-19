import { describe, it, expect, beforeEach, mock } from "bun:test";

// Ensure no module mocks leak from other files
mock.restore();

// completeText calls createModel() and streamText(); mock both so we can assert
// on the params it forwards without hitting a real provider.
mock.module("../src/models", () => ({
  createModel: mock(async () => ({ modelId: "fake" })),
}));

mock.module("../src/auth/codex", () => ({
  CodexAuth: { access: mock(async () => null) },
}));

const calls: Array<Record<string, unknown>> = [];
const streamText = mock((opts: Record<string, unknown>) => {
  calls.push(opts);
  async function* gen() {
    yield { type: "text-delta", text: "ok" };
  }
  return { fullStream: gen() };
});

mock.module("ai", () => ({ streamText }));

let completeText: typeof import("../src/complete-text").completeText;

beforeEach(async () => {
  calls.length = 0;
  ({ completeText } = await import("../src/complete-text"));
});

describe("completeText", () => {
  // Frontier models (Anthropic Opus 4.8/4.7, Fable 5; OpenAI GPT-5 / reasoning)
  // 400 on a custom temperature, so we never send one — the default works
  // everywhere.
  it("never forwards a temperature to the provider", async () => {
    const text = await completeText("anthropic:claude-opus-4-8", {
      system: "sys",
      prompt: "hi",
    });

    expect(text).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("temperature");
  });
});
