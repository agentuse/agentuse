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

const agent = { config: { model: "anthropic:claude-test" } } as any;

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
  delete process.env.AGENTUSE_MOCK_MODEL;
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
  it("uses the agent model by default", () => {
    expect(mod.resolveMockModel("anthropic:agent")).toBe("anthropic:agent");
  });
  it("prefers the AGENTUSE_MOCK_MODEL override", () => {
    process.env.AGENTUSE_MOCK_MODEL = "demo:default";
    expect(mod.resolveMockModel("anthropic:agent")).toBe("demo:default");
  });
});

describe("wrapToolsWithLLMMock", () => {
  it("replaces execute with the LLM mock and never calls the real tool", async () => {
    const real = mock(() => {
      throw new Error("real execute must not run in mock mode");
    });
    completeTextMock.mockImplementation(async () => '{"ok": true, "n": 3}');

    const wrapped = mod.wrapToolsWithLLMMock({ tools__bash: fakeTool(real) }, agent);
    const result = await (wrapped.tools__bash as any).execute({ command: "ls" }, {});

    expect(result).toEqual({ ok: true, n: 3 });
    expect(real).toHaveBeenCalledTimes(0);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
    // Uses the resolved (agent) model and includes the tool name in the prompt.
    const [modelArg, opts] = completeTextMock.mock.calls[0] as any[];
    expect(modelArg).toBe("anthropic:claude-test");
    expect(opts.prompt).toContain("tools__bash");
  });

  it("returns raw text when the model output is not JSON", async () => {
    completeTextMock.mockImplementation(async () => "file1.txt\nfile2.txt");
    const wrapped = mod.wrapToolsWithLLMMock({ tools__bash: fakeTool(() => "real") }, agent);
    const result = await (wrapped.tools__bash as any).execute({}, {});
    expect(result).toBe("file1.txt\nfile2.txt");
  });

  it("strips markdown code fences from the model output", async () => {
    completeTextMock.mockImplementation(async () => '```json\n{"a": 1}\n```');
    const wrapped = mod.wrapToolsWithLLMMock({ x: fakeTool(() => "real") }, agent);
    const result = await (wrapped.x as any).execute({}, {});
    expect(result).toEqual({ a: 1 });
  });

  it("honors the AGENTUSE_MOCK_MODEL override", async () => {
    process.env.AGENTUSE_MOCK_MODEL = "demo:default";
    const wrapped = mod.wrapToolsWithLLMMock({ x: fakeTool(() => "real") }, agent);
    await (wrapped.x as any).execute({}, {});
    expect((completeTextMock.mock.calls[0] as any[])[0]).toBe("demo:default");
  });

  it("passes tools without an execute through unchanged", () => {
    const noExec = { description: "no execute" } as any;
    const wrapped = mod.wrapToolsWithLLMMock({ x: noExec }, agent);
    expect(wrapped.x).toBe(noExec);
  });
});

describe("approval gate exclusion", () => {
  it("does not wrap await_human by default", () => {
    const awaitHuman = fakeTool(() => "real");
    const bash = fakeTool(() => "real");
    const wrapped = mod.wrapToolsWithLLMMock({ await_human: awaitHuman, tools__bash: bash }, agent);
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
    const wrapped = mod.wrapToolsWithLLMMock({ await_human: fakeTool(real) }, agent);
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
