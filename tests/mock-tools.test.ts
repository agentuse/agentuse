import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";

// Ensure no module mocks leak from other files
mock.restore();

// mock-tools generates outputs via completeText() (streaming, Codex-safe).
// Stub it so tests never hit a real model.
const completeTextMock = mock(async () => "mocked");

mock.module("../src/complete-text", () => ({
  completeText: completeTextMock,
}));

let mod: typeof import("../src/runner/mock-tools");

function fakeTool(execute: (...args: any[]) => any, description = "a fake tool") {
  return { description, inputSchema: {}, execute } as any;
}

beforeAll(async () => {
  mod = await import("../src/runner/mock-tools");
});

beforeEach(() => {
  completeTextMock.mockReset();
  completeTextMock.mockImplementation(async () => "mocked");
  delete process.env.AGENTUSE_MOCK_MODE;
  // --mock-model is required; default it so the wrap tests have a model.
  // Tests that exercise the missing-model guard delete it explicitly.
  process.env.AGENTUSE_MOCK_MODEL = "anthropic:mock";
  delete process.env.AGENTUSE_MOCK_APPROVAL;
});

afterEach(() => {
  delete process.env.AGENTUSE_MOCK_MODE;
  delete process.env.AGENTUSE_MOCK_MODEL;
  delete process.env.AGENTUSE_MOCK_APPROVAL;
});

describe("isMockMode", () => {
  it("is true for '1' or 'true', false otherwise", () => {
    process.env.AGENTUSE_MOCK_MODE = "1";
    expect(mod.isMockMode()).toBe(true);
    process.env.AGENTUSE_MOCK_MODE = "true";
    expect(mod.isMockMode()).toBe(true);
    process.env.AGENTUSE_MOCK_MODE = "no";
    expect(mod.isMockMode()).toBe(false);
    delete process.env.AGENTUSE_MOCK_MODE;
    expect(mod.isMockMode()).toBe(false);
  });
});

describe("resolveMockModel", () => {
  it("returns AGENTUSE_MOCK_MODEL", () => {
    process.env.AGENTUSE_MOCK_MODEL = "openai:gpt-5.4-nano";
    expect(mod.resolveMockModel()).toBe("openai:gpt-5.4-nano");
  });
  it("throws when no mock model is set (no agent-model fallback)", () => {
    delete process.env.AGENTUSE_MOCK_MODEL;
    expect(() => mod.resolveMockModel()).toThrow(/no mock model is set/);
  });
});

describe("wrapToolsWithLLMMock", () => {
  it("replaces execute with the LLM mock and never calls the real tool", async () => {
    const real = mock(() => {
      throw new Error("real execute must not run in mock mode");
    });
    completeTextMock.mockImplementation(async () => '{"ok": true, "n": 3}');

    const wrapped = mod.wrapToolsWithLLMMock({ tools__bash: fakeTool(real) });
    const result = await (wrapped.tools__bash as any).execute({ command: "ls" }, {});

    expect(result).toEqual({ ok: true, n: 3 });
    expect(real).toHaveBeenCalledTimes(0);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    // Uses the resolved mock model (from env) and includes the tool name in the prompt.
    const [modelArg, opts] = completeTextMock.mock.calls[0] as any[];
    expect(modelArg).toBe("anthropic:mock");
    expect(opts.prompt).toContain("tools__bash");
  });

  it("returns raw text when the model output is not JSON", async () => {
    completeTextMock.mockImplementation(async () => "file1.txt\nfile2.txt");
    const wrapped = mod.wrapToolsWithLLMMock({ tools__bash: fakeTool(() => "real") });
    const result = await (wrapped.tools__bash as any).execute({}, {});
    expect(result).toBe("file1.txt\nfile2.txt");
  });

  it("strips markdown code fences from the model output", async () => {
    completeTextMock.mockImplementation(async () => '```json\n{"a": 1}\n```');
    const wrapped = mod.wrapToolsWithLLMMock({ x: fakeTool(() => "real") });
    const result = await (wrapped.x as any).execute({}, {});
    expect(result).toEqual({ a: 1 });
  });

  it("honors the AGENTUSE_MOCK_MODEL override", async () => {
    process.env.AGENTUSE_MOCK_MODEL = "demo:default";
    const wrapped = mod.wrapToolsWithLLMMock({ x: fakeTool(() => "real") });
    await (wrapped.x as any).execute({}, {});
    expect((completeTextMock.mock.calls[0] as any[])[0]).toBe("demo:default");
  });

  it("passes tools without an execute through unchanged", () => {
    const noExec = { description: "no execute" } as any;
    const wrapped = mod.wrapToolsWithLLMMock({ x: noExec });
    expect(wrapped.x).toBe(noExec);
  });
});

describe("approval gate exclusion", () => {
  it("does not wrap await_human by default", () => {
    const awaitHuman = fakeTool(() => "real");
    const bash = fakeTool(() => "real");
    const wrapped = mod.wrapToolsWithLLMMock({ await_human: awaitHuman, tools__bash: bash });
    // Excluded tools are returned by identity; mocked tools are new objects.
    expect(wrapped.await_human).toBe(awaitHuman);
    expect(wrapped.tools__bash).not.toBe(bash);
  });

  it("wraps await_human when AGENTUSE_MOCK_APPROVAL is set", async () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "1";
    const real = mock(() => {
      throw new Error("await_human execute must not run when mocked");
    });
    completeTextMock.mockImplementation(async () => "approved");
    const wrapped = mod.wrapToolsWithLLMMock({ await_human: fakeTool(real) });
    const result = await (wrapped.await_human as any).execute({ prompt: "ok?" }, {});
    expect(result).toBe("approved");
    expect(real).toHaveBeenCalledTimes(0);
  });
});

describe("mockExclusions", () => {
  it("excludes await_human by default and nothing when approval is mocked", () => {
    expect(mod.mockExclusions().has("await_human")).toBe(true);
    process.env.AGENTUSE_MOCK_APPROVAL = "1";
    expect(mod.mockExclusions().size).toBe(0);
  });
});
