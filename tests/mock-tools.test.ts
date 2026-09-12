import { describe, it, expect, beforeAll, beforeEach, afterEach, mock } from "bun:test";
import { z } from 'zod';
import { trustedOutputTool } from '../src/tools/tool-contract';

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
  delete process.env.AGENTUSE_MOCK_SCOPE;
  mod.__resetMockGateDecisions();
});

afterEach(() => {
  delete process.env.AGENTUSE_MOCK_MODE;
  delete process.env.AGENTUSE_MOCK_MODEL;
  delete process.env.AGENTUSE_MOCK_APPROVAL;
  delete process.env.AGENTUSE_MOCK_SCOPE;
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

  it("keeps nested Code Mode calls on the mock wrapper", async () => {
    completeTextMock.mockImplementation(async () => '{"success":true,"mocked":true}');
    const realMutation = mock(() => {
      throw new Error("real store mutation must not run in mock mode");
    });
    const storeUpdate = fakeTool(realMutation);
    storeUpdate.inputSchema = z.object({
      id: z.string(),
      update: z.object({ status: z.string() }),
    });
    const wrapped = mod.wrapToolsWithLLMMock({ store_update: storeUpdate });
    const { ToolDispatcher } = await import('../src/runner/tool-dispatcher');
    const { createCodeExecTool } = await import('../src/runner/code-mode');
    const dispatcher = new ToolDispatcher(wrapped);
    dispatcher.register('code_exec', createCodeExecTool({
      dispatcher,
      toolNames: dispatcher.names(),
    }));

    const output = await dispatcher.dispatch('code_exec', {
      code: 'return tools.store_update({ id: "job-1", update: { status: "done" } });',
    }, { toolCallId: 'mock-code' });

    expect(output).toEqual(expect.objectContaining({
      status: 'completed',
      value: { success: true, mocked: true },
    }));
    expect(realMutation).toHaveBeenCalledTimes(0);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
  });

  it('repairs trusted mock output against its declared schema', async () => {
    completeTextMock
      .mockImplementationOnce(async () => '{"success":true,"mocked":true}')
      .mockImplementationOnce(async () => '{"success":true,"id":"mock-1"}');
    const wrapped = mod.wrapToolsWithLLMMock({ create: trustedOutputTool({
      inputSchema: z.object({}),
      outputSchema: z.object({ success: z.literal(true), id: z.string() }),
      execute: async () => ({ success: true as const, id: 'real' }),
    }) });
    await expect((wrapped.create as any).execute({}, {}))
      .resolves.toEqual({ success: true, id: 'mock-1' });
    expect(completeTextMock).toHaveBeenCalledTimes(2);
    expect((completeTextMock.mock.calls[0] as any[])[1].prompt).toContain('output schema');
  });

  it('does not reapply trusted output transforms through the dispatcher', async () => {
    let transforms = 0;
    const outputSchema = z.object({ value: z.number() })
      .transform(value => ({ value: value.value + (++transforms) }));
    completeTextMock.mockImplementation(async () => '{"value":1}');
    const wrapped = mod.wrapToolsWithLLMMock({ transformed: trustedOutputTool({
      inputSchema: z.object({}),
      outputSchema,
      execute: async () => ({ value: 1 }),
    }) });
    const { ToolDispatcher } = await import('../src/runner/tool-dispatcher');
    const dispatcher = new ToolDispatcher(wrapped);
    await expect(dispatcher.dispatch('transformed', {}, { toolCallId: 'mock-transform' }))
      .resolves.toEqual({ value: 2 });
    expect(transforms).toBe(1);
  });

  it('retains a prevalidated mock result through a no-op result hook', async () => {
    let transforms = 0;
    const outputSchema = z.object({ value: z.number() })
      .transform(value => ({ value: value.value + (++transforms) }));
    completeTextMock.mockImplementation(async () => '{"value":1}');
    const wrapped = mod.wrapToolsWithLLMMock({ transformed: trustedOutputTool({
      inputSchema: z.object({}),
      outputSchema,
      execute: async () => ({ value: 1 }),
    }) });
    const { ToolDispatcher } = await import('../src/runner/tool-dispatcher');
    const dispatcher = new ToolDispatcher(wrapped, {
      pluginEvents: { async toolResult(event) { return event; } },
    });
    await expect(dispatcher.dispatch('transformed', {}, { toolCallId: 'mock-noop-hook' }))
      .resolves.toEqual({ value: 2 });
    expect(transforms).toBe(1);
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

  it("resolves await_human deterministically (no LLM) when AGENTUSE_MOCK_APPROVAL is set", async () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "1";
    const real = mock(() => {
      throw new Error("await_human execute must not run when mocked");
    });
    const wrapped = mod.wrapToolsWithLLMMock({ await_human: fakeTool(real) });
    const result = await (wrapped.await_human as any).execute({ prompt: "ok?" }, {});
    expect(result).toEqual({ status: "approved" });
    expect(real).toHaveBeenCalledTimes(0);
    expect(completeTextMock).toHaveBeenCalledTimes(0);
  });
});

describe("mockExclusions", () => {
  it("always keeps the outcome tools real so a mock run can end", () => {
    for (const name of ["report_complete", "report_incomplete"]) {
      expect(mod.mockExclusions().has(name)).toBe(true);
      process.env.AGENTUSE_MOCK_APPROVAL = "approve";
      expect(mod.mockExclusions().has(name)).toBe(true);
      delete process.env.AGENTUSE_MOCK_APPROVAL;
    }
  });

  it("excludes await_human by default and only the outcome tools when approval is mocked", () => {
    expect(mod.mockExclusions().has("await_human")).toBe(true);
    process.env.AGENTUSE_MOCK_APPROVAL = "1";
    expect(mod.mockExclusions().has("await_human")).toBe(false);
    expect(mod.mockExclusions().size).toBe(2);
  });
});

describe("resolveMockApprovalDecision", () => {
  it("returns undefined when unset", () => {
    expect(mod.resolveMockApprovalDecision()).toBeUndefined();
  });
  it("treats the legacy boolean spellings and approve as approve", () => {
    for (const value of ["1", "true", "approve", "approved"]) {
      process.env.AGENTUSE_MOCK_APPROVAL = value;
      expect(mod.resolveMockApprovalDecision()).toEqual({ kind: "approve" });
    }
  });
  it("parses reject and comment with text", () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "reject";
    expect(mod.resolveMockApprovalDecision()).toEqual({ kind: "reject" });
    process.env.AGENTUSE_MOCK_APPROVAL = "comment:tighten the summary";
    expect(mod.resolveMockApprovalDecision()).toEqual({ kind: "comment", comment: "tighten the summary" });
  });
  it("defaults the comment text when none is given", () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "comment";
    const decision = mod.resolveMockApprovalDecision();
    expect(decision?.kind).toBe("comment");
    expect((decision as { comment: string }).comment.length).toBeGreaterThan(0);
  });
  it("throws on an unknown value", () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "maybe";
    expect(() => mod.resolveMockApprovalDecision()).toThrow(/Invalid --mock-approval value/);
  });
});

describe("mockGateDecisionResult", () => {
  it("approves plain yes/no gates without a choice", () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "approve";
    expect(mod.mockGateDecisionResult({ prompt: "ok?" })).toEqual({ status: "approved" });
  });
  it("picks the recommended option on a pick gate, else the first", () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "approve";
    const options = [
      { id: "a", label: "A" },
      { id: "b", label: "B", recommended: true },
    ];
    expect(mod.mockGateDecisionResult({ prompt: "pick", options })).toEqual({ status: "approved", choice: "b" });
    expect(mod.mockGateDecisionResult({ prompt: "pick", options: [{ id: "a", label: "A" }, { id: "c", label: "C" }] }))
      .toEqual({ status: "approved", choice: "a" });
  });
  it("returns rejected / commented payloads for forced outcomes", () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "reject";
    expect(mod.mockGateDecisionResult({})).toEqual({ status: "rejected" });
    process.env.AGENTUSE_MOCK_APPROVAL = "comment:needs work";
    expect(mod.mockGateDecisionResult({})).toEqual({ status: "commented", comment: "needs work" });
  });

  it("comments the first gate then approves the re-gate", () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "comment:tighten it";
    expect(mod.mockGateDecisionResult({}, { callId: "call-1" }))
      .toEqual({ status: "commented", comment: "tighten it" });
    // An obedient agent revises and re-gates; repeating the comment would loop
    // it until it gave up, so the second gate approves.
    expect(mod.mockGateDecisionResult({}, { callId: "call-2" })).toEqual({ status: "approved" });
    expect(mod.mockGateDecisionResult({}, { callId: "call-3" })).toEqual({ status: "approved" });
  });

  it("memoizes per call id so one gate resolved twice does not advance the sequence", () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "comment:tighten it";
    // Every gate is resolved twice: the toolApproval barrier applies the
    // durable effects, then the mocked execute returns the payload.
    const barrier = mod.mockGateDecisionResult({}, { callId: "call-1" });
    const execute = mod.mockGateDecisionResult({}, { callId: "call-1" });
    expect(execute).toEqual(barrier);
    expect(execute).toEqual({ status: "commented", comment: "tighten it" });
    expect(mod.mockGateDecisionResult({}, { callId: "call-2" })).toEqual({ status: "approved" });
  });

  it("keeps approve and reject stable across gates", () => {
    process.env.AGENTUSE_MOCK_APPROVAL = "reject";
    expect(mod.mockGateDecisionResult({}, { callId: "r1" })).toEqual({ status: "rejected" });
    expect(mod.mockGateDecisionResult({}, { callId: "r2" })).toEqual({ status: "rejected" });
    mod.__resetMockGateDecisions();
    process.env.AGENTUSE_MOCK_APPROVAL = "approve";
    expect(mod.mockGateDecisionResult({}, { callId: "a1" })).toEqual({ status: "approved" });
    expect(mod.mockGateDecisionResult({}, { callId: "a2" })).toEqual({ status: "approved" });
  });
});

describe("mockScope", () => {
  it("defaults to all and honors AGENTUSE_MOCK_SCOPE=gated", () => {
    expect(mod.mockScope()).toBe("all");
    process.env.AGENTUSE_MOCK_SCOPE = "gated";
    expect(mod.mockScope()).toBe("gated");
    process.env.AGENTUSE_MOCK_SCOPE = "bogus";
    expect(mod.mockScope()).toBe("all");
  });

  it("applies an explicit CLI scope over inherited environment state", () => {
    process.env.AGENTUSE_MOCK_SCOPE = "gated";
    mod.enableMockMode("all");
    expect(process.env.AGENTUSE_MOCK_MODE).toBe("1");
    expect(mod.mockScope()).toBe("all");

    process.env.AGENTUSE_MOCK_SCOPE = "all";
    mod.enableMockMode("gated");
    expect(mod.mockScope()).toBe("gated");
  });
});

describe("wrapToolsWithGatedMock", () => {
  const GATED = ["touch *", "birdc reply *"];

  it("mocks a bash command matching a gated pattern and never runs the real execute", async () => {
    const real = mock(() => {
      throw new Error("gated command must not execute for real");
    });
    completeTextMock.mockImplementation(async () => "fabricated");
    const wrapped = mod.wrapToolsWithGatedMock({ tools__bash: fakeTool(real) }, GATED);
    const result = await (wrapped.tools__bash as any).execute({ command: "touch /tmp/x" }, {});
    // The fabricated text is tagged so the agent does not read back an effect that never happened.
    expect(result).toStartWith("fabricated");
    expect(result).toContain("[mock] This command was NOT executed");
    expect(real).toHaveBeenCalledTimes(0);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
  });

  it("mocks the entire call when a later compound command is gated", async () => {
    const real = mock(() => {
      throw new Error("a compound call containing a gated command must not execute for real");
    });
    completeTextMock.mockImplementation(async () => "fabricated");
    const wrapped = mod.wrapToolsWithGatedMock({ tools__bash: fakeTool(real) }, GATED);

    const result = await (wrapped.tools__bash as any).execute(
      { command: "echo ok; birdc reply 123 ok" },
      {},
    );

    expect(result).toStartWith("fabricated");
    expect(result).toContain("[mock] This command was NOT executed");
    expect(real).toHaveBeenCalledTimes(0);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
  });

  it("does not treat gated-looking text in an inert quoted here-doc as executable", async () => {
    const real = mock(() => "real-output");
    const wrapped = mod.wrapToolsWithGatedMock({ tools__bash: fakeTool(real) }, GATED);

    const result = await (wrapped.tools__bash as any).execute(
      { command: "node <<'EOF'\nbirdc reply 123 ok\nEOF" },
      {},
    );

    expect(result).toBe("real-output");
    expect(real).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(0);
  });

  it("does not treat gated-looking text in a quoted here-string as executable", async () => {
    const real = mock(() => "real-output");
    const wrapped = mod.wrapToolsWithGatedMock({ tools__bash: fakeTool(real) }, GATED);

    const result = await (wrapped.tools__bash as any).execute(
      { command: "node <<< 'birdc reply 123 ok'" },
      {},
    );

    expect(result).toBe("real-output");
    expect(real).toHaveBeenCalledTimes(1);
    expect(completeTextMock).toHaveBeenCalledTimes(0);
  });

  it("mocks an executable gated command substitution inside an unquoted here-doc", async () => {
    const real = mock(() => {
      throw new Error("an expanded gated command must not execute for real");
    });
    completeTextMock.mockImplementation(async () => "fabricated");
    const wrapped = mod.wrapToolsWithGatedMock({ tools__bash: fakeTool(real) }, GATED);

    const result = await (wrapped.tools__bash as any).execute(
      { command: "node <<EOF\n$(birdc reply 123 ok)\nEOF" },
      {},
    );

    expect(result).toStartWith("fabricated");
    expect(real).toHaveBeenCalledTimes(0);
    expect(completeTextMock).toHaveBeenCalledTimes(1);
  });

  it("runs non-gated bash commands for real with no LLM call", async () => {
    const real = mock(() => "real-output");
    const wrapped = mod.wrapToolsWithGatedMock({ tools__bash: fakeTool(real) }, GATED);
    const result = await (wrapped.tools__bash as any).execute({ command: "echo hello" }, {});
    expect(result).toBe("real-output");
    expect(completeTextMock).toHaveBeenCalledTimes(0);
  });

  it("leaves every non-bash tool untouched (identity)", () => {
    const fsRead = fakeTool(() => "real");
    const wrapped = mod.wrapToolsWithGatedMock({ tools__filesystem_read: fsRead }, GATED);
    expect(wrapped.tools__filesystem_read).toBe(fsRead);
  });

  it("leaves bash untouched when no gated patterns are declared", () => {
    const bash = fakeTool(() => "real");
    const wrapped = mod.wrapToolsWithGatedMock({ tools__bash: bash }, []);
    expect(wrapped.tools__bash).toBe(bash);
  });

  it("resolves await_human deterministically when a decision is configured, else leaves it real", async () => {
    const gate = fakeTool(() => "real-gate");
    expect(mod.wrapToolsWithGatedMock({ await_human: gate }, GATED).await_human).toBe(gate);
    process.env.AGENTUSE_MOCK_APPROVAL = "approve";
    const wrapped = mod.wrapToolsWithGatedMock({ await_human: gate }, GATED);
    expect(await (wrapped.await_human as any).execute({ prompt: "ok?" })).toEqual({ status: "approved" });
  });
});

describe("maybeMockAwaitHuman", () => {
  it("is identity when mock mode or the decision is off", () => {
    const tool = fakeTool(() => "real");
    // Decision set but mock mode off
    process.env.AGENTUSE_MOCK_APPROVAL = "approve";
    expect(mod.maybeMockAwaitHuman(tool)).toBe(tool);
    // Mock mode on but no decision
    process.env.AGENTUSE_MOCK_MODE = "1";
    delete process.env.AGENTUSE_MOCK_APPROVAL;
    expect(mod.maybeMockAwaitHuman(tool)).toBe(tool);
  });
  it("swaps execute for the deterministic decision when both are active", async () => {
    process.env.AGENTUSE_MOCK_MODE = "1";
    process.env.AGENTUSE_MOCK_APPROVAL = "approve";
    const real = mock(() => {
      throw new Error("real await_human must not run");
    });
    const wrapped = mod.maybeMockAwaitHuman(fakeTool(real));
    const result = await (wrapped as any).execute({ prompt: "ok?" });
    expect(result).toEqual({ status: "approved" });
    expect(real).toHaveBeenCalledTimes(0);
  });
});

describe("shared mock run setup", () => {
  const priorScope = process.env.AGENTUSE_MOCK_SCOPE;
  const priorModel = process.env.AGENTUSE_MOCK_MODEL;
  afterEach(() => {
    if (priorScope === undefined) delete process.env.AGENTUSE_MOCK_SCOPE;
    else process.env.AGENTUSE_MOCK_SCOPE = priorScope;
    if (priorModel === undefined) delete process.env.AGENTUSE_MOCK_MODEL;
    else process.env.AGENTUSE_MOCK_MODEL = priorModel;
  });

  it("picks gated scope when the agent fences commands", () => {
    // The fence is the author saying which calls are irreversible, so those are
    // the only ones worth faking; everything else grounds the run in real state.
    expect(mod.resolveMockScope({ tools: { bash: { gated: ["gh pr create *"] } } })).toBe("gated");
  });

  it("picks all scope when there is nothing fenced", () => {
    expect(mod.resolveMockScope({ tools: { bash: { gated: [] } } })).toBe("all");
    expect(mod.resolveMockScope({ tools: { bash: {} } })).toBe("all");
    expect(mod.resolveMockScope({ tools: {} })).toBe("all");
    expect(mod.resolveMockScope({})).toBe("all");
  });

  it("builds the env a mock run needs, defaulting the gate to approve", () => {
    // A missing AGENTUSE_MOCK_SCOPE is what silently turned a grounded run into
    // a fully fabricated one, so the scope is always written out.
    expect(mod.mockRunEnv({ scope: "gated", model: "anthropic:claude-haiku-4-5" })).toEqual({
      AGENTUSE_MOCK_MODE: "1",
      AGENTUSE_MOCK_SCOPE: "gated",
      AGENTUSE_MOCK_MODEL: "anthropic:claude-haiku-4-5",
      AGENTUSE_MOCK_APPROVAL: "approve",
    });
    expect(mod.mockRunEnv({ scope: "all", model: "m", approval: "reject" }).AGENTUSE_MOCK_APPROVAL).toBe("reject");
  });

  it("reports the configured mock model, or nothing when none is set", () => {
    delete process.env.AGENTUSE_MOCK_MODEL;
    expect(mod.configuredMockModel()).toBeUndefined();
    process.env.AGENTUSE_MOCK_MODEL = "openai:gpt-5.4-nano";
    expect(mod.configuredMockModel()).toBe("openai:gpt-5.4-nano");
  });
});
