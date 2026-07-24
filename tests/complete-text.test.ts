import { describe, it, expect, beforeEach, mock } from "bun:test";

// Ensure no module mocks leak from other files
mock.restore();

// completeText calls createModel() and streamText(); mock both so we can assert
// on the params it forwards without hitting a real provider.
const createModel = mock(async () => ({ modelId: "fake" }));
mock.module("../src/models", () => ({
  createModel,
}));

const codexAccess = mock(async (): Promise<string | null> => null);
mock.module("../src/auth/codex", () => ({
  CodexAuth: { access: codexAccess },
}));

const calls: Array<Record<string, unknown>> = [];
const streamText = mock((opts: Record<string, unknown>) => {
  calls.push(opts);
  async function* gen() {
    yield { type: "text-delta", text: "ok" };
  }
  return { stream: gen() };
});

mock.module("ai", () => ({ streamText }));

let completeText: typeof import("../src/complete-text").completeText;

beforeEach(async () => {
  calls.length = 0;
  createModel.mockClear();
  streamText.mockClear();
  codexAccess.mockImplementation(async () => null);
  ({ completeText } = await import("../src/complete-text"));
});

describe("completeText", () => {
  // Frontier models (Anthropic Opus 4.8/4.7, Fable 5; OpenAI GPT-5 / reasoning)
  // 400 on a custom temperature, so we never send one — the default works
  // everywhere.
  it("never forwards a temperature to the provider", async () => {
    const text = await completeText("anthropic:claude-opus-4-8", {
      instructions: "sys",
      prompt: "hi",
    });

    expect(text).toBe("ok");
    expect(calls).toHaveLength(1);
    expect(calls[0]).not.toHaveProperty("temperature");
  });

  for (const model of ["openai:gpt-5", "gpt-5"]) {
    it(`uses Codex helper options for ${model}`, async () => {
      codexAccess.mockImplementation(async () => "oauth-token");

      await completeText(model, {
        instructions: "system rules",
        prompt: "hi",
        maxOutputTokens: 1234,
      });

      expect(calls[0]).toMatchObject({
        instructions: "system rules",
        providerOptions: {
          openai: {
            instructions: "system rules",
            store: false,
          },
        },
      });
      expect(calls[0]).not.toHaveProperty("maxOutputTokens");
    });
  }

  it("does not start a helper provider request when stop/timeout already fired", async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(completeText("openai:gpt-5", {
      instructions: "system rules",
      prompt: "hi",
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });

    expect(createModel).not.toHaveBeenCalled();
    expect(streamText).not.toHaveBeenCalled();
  });

  it("does not accept partial helper text when a provider ends quietly on cancellation", async () => {
    const controller = new AbortController();
    streamText.mockImplementationOnce((opts: Record<string, unknown>) => {
      calls.push(opts);
      async function* gen() {
        yield { type: "text-delta", text: "partial" };
        controller.abort();
      }
      return { stream: gen() };
    });

    await expect(completeText("anthropic:claude-sonnet-4-0", {
      instructions: "system rules",
      prompt: "hi",
      abortSignal: controller.signal,
    })).rejects.toMatchObject({ name: "AbortError" });
  });
});
