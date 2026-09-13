import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';
import { codeModeResultId, describeCodeModeResult } from '../src/session/code-mode-results';
import { buildCodeModeTraceHooks } from '../src/runner/execution';
import { createCodeExecTool } from '../src/runner/code-mode';
import { ToolDispatcher } from '../src/runner/tool-dispatcher';
import { createResultsTool } from '../src/tools/results';
import { z } from 'zod';

let testRoot: string | undefined;
let originalXdg: string | undefined;

afterEach(async () => {
  if (originalXdg === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = originalXdg;
  if (testRoot) await rm(testRoot, { recursive: true, force: true });
  testRoot = undefined;
});

async function createSession(manager: SessionManager, projectRoot: string, agentId: string) {
  const sessionId = await manager.createSession({
    agent: { id: agentId, name: agentId, isSubAgent: false },
    model: 'demo:test',
    version: 'test',
    config: {},
    project: { root: projectRoot, cwd: projectRoot },
  });
  const messageId = await manager.createMessage(sessionId, agentId, {
    user: { prompt: { task: 'reuse nested result' } },
    assistant: {
      system: [],
      modelID: 'demo:test',
      providerID: 'demo',
      mode: 'build',
      path: { cwd: projectRoot, root: projectRoot },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    },
  });
  return { sessionId, messageId };
}

describe('session Code Mode results', () => {
  it('persists a nested result and reuses it through a later real Code Mode invocation', async () => {
    originalXdg = process.env.XDG_DATA_HOME;
    testRoot = await mkdtemp(join(tmpdir(), 'agentuse-code-results-'));
    process.env.XDG_DATA_HOME = testRoot;
    await initStorage(testRoot);

    const manager = new SessionManager();
    const agentId = 'agents/review';
    const { sessionId, messageId } = await createSession(manager, testRoot, agentId);
    let toolCalls = 0;
    const dispatcher = new ToolDispatcher({
      load: {
        description: 'Load records',
        inputSchema: z.object({ scope: z.string() }),
        execute: async () => {
          toolCalls++;
          return { items: [{ id: 'post-1', score: 7 }, { id: 'post-2', score: 2 }] };
        },
      },
    });
    const codeExec = createCodeExecTool({
      dispatcher,
      toolNames: ['load'],
      toolDefinitions: dispatcher.codeModeTools(),
      ...buildCodeModeTraceHooks({ sessionManager: manager, sessionID: sessionId, agentId, messageID: messageId }),
    });

    const first = await codeExec.execute!({
      code: 'const loaded = await tools.load({ scope: "ready" }); return loaded;',
    }, { toolCallId: 'first-code-exec' }) as any;
    const resultId = first.reusableResults?.[0]?.resultId;
    expect(resultId).toStartWith(`result_${messageId}_`);

    // A continuation is handled by a fresh SessionManager and a fresh
    // code_exec tool. The payload and compact index must survive that process
    // boundary rather than depending on an in-memory guest or host cache.
    const resumedManager = new SessionManager();
    const resumedCodeExec = createCodeExecTool({
      dispatcher,
      toolNames: ['load'],
      toolDefinitions: dispatcher.codeModeTools(),
      ...buildCodeModeTraceHooks({
        sessionManager: resumedManager,
        sessionID: sessionId,
        agentId,
        messageID: messageId,
      }),
    });
    const second = await resumedCodeExec.execute!({
      code: `const previous = await results.read(${JSON.stringify(resultId)}); if (!previous || typeof previous !== "object" || !("items" in previous) || !Array.isArray(previous.items)) throw new Error("missing items"); return previous.items.filter((item): item is { id: string; score: number } => !!item && typeof item === "object" && "score" in item && typeof item.score === "number" && item.score >= 5);`,
    }, { toolCallId: 'second-code-exec' }) as any;

    expect(second).toEqual(expect.objectContaining({
      status: 'completed',
      value: [{ id: 'post-1', score: 7 }],
      telemetry: expect.objectContaining({ resultReads: 1 }),
    }));
    expect(toolCalls).toBe(1);
    expect(await resumedManager.listCodeModeResults(sessionId, agentId)).toEqual([
      expect.objectContaining({ resultId, tool: 'load' }),
    ]);
    expect(await resumedManager.readCodeModeResult(sessionId, agentId, resultId)).toEqual({
      items: [{ id: 'post-1', score: 7 }, { id: 'post-2', score: 2 }],
    });

    const parts = await manager.getMessageParts(sessionId, agentId, messageId);
    expect(parts).toEqual(expect.arrayContaining([
      expect.objectContaining({
        type: 'tool',
        parentCallID: 'first-code-exec',
        state: expect.objectContaining({
          status: 'completed',
          metadata: expect.objectContaining({
            codeMode: true,
            codeModeResult: expect.objectContaining({ resultId }),
          }),
        }),
      }),
    ]));
  });

  it('reads and lists only completed nested results from the same session', async () => {
    originalXdg = process.env.XDG_DATA_HOME;
    testRoot = await mkdtemp(join(tmpdir(), 'agentuse-code-results-'));
    process.env.XDG_DATA_HOME = testRoot;
    await initStorage(testRoot);

    const manager = new SessionManager();
    const agentId = 'agents/review';
    const { sessionId, messageId } = await createSession(manager, testRoot, agentId);
    const startedAt = Date.now();
    const partId = await manager.addPart(sessionId, agentId, messageId, {
      type: 'tool',
      callID: 'outer:nested:1',
      parentCallID: 'outer',
      tool: 'store_list',
      state: {
        status: 'running',
        input: { store: 'posts', status: 'ready' },
        metadata: { parentCallId: 'outer', codeMode: true },
        time: { start: startedAt },
      },
    });
    const resultId = codeModeResultId(messageId, partId);
    const output = { success: true, items: [{ id: 'post-1' }] };
    const reference = describeCodeModeResult({
      resultId,
      tool: 'store_list',
      toolInput: { store: 'posts', status: 'ready' },
      output,
      completedAt: startedAt + 10,
    });
    await manager.updatePart(sessionId, agentId, messageId, partId, {
      state: {
        status: 'completed',
        input: { store: 'posts', status: 'ready' },
        output,
        metadata: { parentCallId: 'outer', codeMode: true, codeModeResult: reference },
        time: { start: startedAt, end: startedAt + 10 },
      },
    });
    await manager.recordCodeModeResult(sessionId, agentId, messageId, partId, reference);

    await expect(manager.readCodeModeResult(sessionId, agentId, resultId)).resolves.toEqual(output);
    await expect(manager.listCodeModeResults(sessionId, agentId)).resolves.toEqual([
      expect.objectContaining({
        resultId,
        tool: 'store_list',
        inputPreview: '{"status":"ready","store":"posts"}',
        completedAt: startedAt + 10,
      }),
    ]);

    const other = await createSession(manager, testRoot, agentId);
    await expect(manager.readCodeModeResult(other.sessionId, agentId, resultId)).rejects.toThrow('RESULT_EXPIRED');
    await expect(manager.readCodeModeResult(sessionId, agentId, '../../session.json')).rejects.toThrow('RESULT_NOT_FOUND');
  });

  it('does not expose ordinary or unsuccessful tool parts', async () => {
    originalXdg = process.env.XDG_DATA_HOME;
    testRoot = await mkdtemp(join(tmpdir(), 'agentuse-code-results-'));
    process.env.XDG_DATA_HOME = testRoot;
    await initStorage(testRoot);

    const manager = new SessionManager();
    const agentId = 'agents/review';
    const { sessionId, messageId } = await createSession(manager, testRoot, agentId);
    const partId = await manager.addPart(sessionId, agentId, messageId, {
      type: 'tool',
      callID: 'direct-call',
      tool: 'store_list',
      state: {
        status: 'completed',
        input: {},
        output: { success: true },
        metadata: {},
        time: { start: 1, end: 2 },
      },
    });

    expect(await manager.listCodeModeResults(sessionId, agentId)).toEqual([]);
    await expect(
      manager.readCodeModeResult(sessionId, agentId, codeModeResultId(messageId, partId))
    ).rejects.toThrow('RESULT_NOT_FOUND');
  });

  it('enforces stored result kinds and queries oversized JSON without reading it into Code Mode', async () => {
    originalXdg = process.env.XDG_DATA_HOME;
    testRoot = await mkdtemp(join(tmpdir(), 'agentuse-code-results-'));
    process.env.XDG_DATA_HOME = testRoot;
    await initStorage(testRoot);

    const manager = new SessionManager();
    const agentId = 'agents/review';
    const { sessionId, messageId } = await createSession(manager, testRoot, agentId);
    const record = async (tool: string, output: unknown, readable: boolean) => {
      const startedAt = Date.now();
      const partId = await manager.addPart(sessionId, agentId, messageId, {
        type: 'tool',
        callID: `outer:nested:${tool}`,
        parentCallID: 'outer',
        tool,
        state: {
          status: 'running',
          input: {},
          metadata: { parentCallId: 'outer', codeMode: true },
          time: { start: startedAt },
        },
      });
      const resultId = codeModeResultId(messageId, partId);
      const described = describeCodeModeResult({
        resultId,
        tool,
        toolInput: {},
        output,
        completedAt: startedAt + 1,
      });
      const reference = {
        ...described,
        capabilities: { ...described.capabilities, read: readable },
      };
      await manager.updatePart(sessionId, agentId, messageId, partId, {
        state: {
          status: 'completed',
          input: {},
          output,
          metadata: { parentCallId: 'outer', codeMode: true, codeModeResult: reference },
          time: { start: startedAt, end: startedAt + 1 },
        },
      });
      await manager.recordCodeModeResult(sessionId, agentId, messageId, partId, reference);
      return { resultId, reference };
    };

    const text = await record('logs', 'started\ntimeout while loading\nrecovered', true);
    const json = await record('records', {
      items: [{ id: 'one', status: 'ready' }, { id: 'two', status: 'done' }],
      padding: 'x'.repeat(500),
    }, false);

    await expect(manager.grepCodeModeResult(sessionId, agentId, text.resultId, {
      pattern: 'timeout',
      contextLines: 1,
    })).resolves.toEqual({
      matches: [{
        line: 2,
        column: 1,
        excerpt: 'timeout while loading',
        before: ['started'],
        after: ['recovered'],
      }],
      truncated: false,
    });
    await expect(manager.readCodeModeResult(sessionId, agentId, json.resultId))
      .rejects.toThrow('use results.jq()');
    await expect(manager.grepCodeModeResult(sessionId, agentId, json.resultId, { pattern: 'ready' }))
      .rejects.toThrow('use results.jq()');
    await expect(manager.jqCodeModeResult(sessionId, agentId, text.resultId, '.'))
      .rejects.toThrow('use results.grep()');
    await expect(manager.jqCodeModeResult(
      sessionId,
      agentId,
      json.resultId,
      '.items[] | select(.status == "ready") | .id'
    )).resolves.toEqual({ values: ['one'], truncated: false });

    expect(await manager.listCodeModeResults(sessionId, agentId)).toEqual(expect.arrayContaining([
      expect.objectContaining({
        resultId: text.resultId,
        kind: 'text',
        capabilities: { read: true, grep: true, jq: false },
      }),
      expect.objectContaining({
        resultId: json.resultId,
        kind: 'json',
        capabilities: { read: false, grep: false, jq: true },
      }),
    ]));
  });
});

describe('direct reusable results', () => {
  it('uses one metadata-aware schema and ignores known fields from other actions', async () => {
    const manager = new SessionManager();
    const resultsTool = createResultsTool({ manager, sessionId: 'session', agentId: 'agent' });
    const inputSchema = (resultsTool as any).inputSchema as z.ZodTypeAny;
    const input = {
      intent: 'Continue reading the stored output',
      recovers: 'call_failed',
      action: 'read',
      resultId: 'result_01J00000000000000000000000_01J00000000000000000000001',
      offset: 0,
      maxBytes: 6_000,
      limit: 20,
      pattern: '.',
      caseSensitive: false,
      contextLines: 0,
      expression: '.',
    };

    expect(inputSchema.safeParse(input)).toMatchObject({ success: true });
    await expect((resultsTool.execute as any)({ action: 'grep', resultId: input.resultId }))
      .rejects.toThrow('RESULT_GREP_INPUT: pattern is required');
  });

  it('advertises the configured direct-read budget without limiting Code Mode reads', async () => {
    const previousQueryLimit = process.env.AGENTUSE_RESULT_QUERY_BYTES;
    process.env.AGENTUSE_RESULT_QUERY_BYTES = '1024';
    originalXdg = process.env.XDG_DATA_HOME;
    testRoot = await mkdtemp(join(tmpdir(), 'agentuse-direct-read-capability-'));
    process.env.XDG_DATA_HOME = testRoot;
    await initStorage(testRoot);

    try {
      const manager = new SessionManager();
      const agentId = 'agents/review';
      const { sessionId, messageId } = await createSession(manager, testRoot, agentId);
      const largeOutput = `x${'x'.repeat(999)}${'🙂'.repeat(300)}`;
      const dispatcher = new ToolDispatcher({
        load: {
          description: 'Load a large text field',
          inputSchema: z.object({}),
          execute: async () => ({ output: largeOutput }),
        },
      });
      const hooks = buildCodeModeTraceHooks({
        sessionManager: manager,
        sessionID: sessionId,
        agentId,
        messageID: messageId,
      });
      const codeExec = createCodeExecTool({
        dispatcher,
        toolNames: ['load'],
        toolDefinitions: dispatcher.codeModeTools(),
        ...hooks,
      });
      const first = await codeExec.execute!({
        code: 'return await tools.load({});',
      }, { toolCallId: 'large-load' }) as any;
      const resultId = first.reusableResults[0].resultId;

      expect((await manager.listCodeModeResults(sessionId, agentId))[0]).toMatchObject({
        resultId,
        capabilities: { read: true, grep: true, jq: true },
      });

      const directResults = createResultsTool({ manager, sessionId, agentId });
      expect(directResults.description).toContain('1,024-byte response limit');
      expect(directResults.description).toContain('use code_exec');
      await expect((directResults.execute as any)({ action: 'list', limit: 1 })).resolves.toEqual([
        expect.objectContaining({
          resultId,
          capabilities: { read: true, grep: true, jq: true },
        }),
      ]);
      const pages: string[] = [];
      let offset = 0;
      while (true) {
        const page = await (directResults.execute as any)({ action: 'read', resultId, offset });
        expect(Buffer.byteLength(JSON.stringify(page), 'utf8')).toBeLessThanOrEqual(1_024);
        expect(page.offset).toBe(offset);
        pages.push(page.content);
        if (page.nextOffset === null) break;
        expect(page.nextOffset).toBeGreaterThan(offset);
        offset = page.nextOffset;
      }
      expect(pages.join('')).toBe(JSON.stringify({ output: largeOutput }));

      const resumedCodeExec = createCodeExecTool({
        dispatcher,
        toolNames: ['load'],
        toolDefinitions: dispatcher.codeModeTools(),
        ...hooks,
      });
      await expect(resumedCodeExec.execute!({
        code: `const value = await results.read(${JSON.stringify(resultId)}) as { output: string }; return value.output.slice(0, 16);`,
      }, { toolCallId: 'large-read' })).resolves.toMatchObject({
        status: 'completed',
        value: 'xxxxxxxxxxxxxxxx',
      });
    } finally {
      if (previousQueryLimit === undefined) delete process.env.AGENTUSE_RESULT_QUERY_BYTES;
      else process.env.AGENTUSE_RESULT_QUERY_BYTES = previousQueryLimit;
    }
  });

  it('allows a result query above the initial inline-result ceiling', async () => {
    const previousInlineLimit = process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
    const previousQueryLimit = process.env.AGENTUSE_RESULT_QUERY_BYTES;
    const previousOutputLimit = process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
    delete process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
    delete process.env.AGENTUSE_RESULT_QUERY_BYTES;
    delete process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
    originalXdg = process.env.XDG_DATA_HOME;
    testRoot = await mkdtemp(join(tmpdir(), 'agentuse-direct-query-limit-'));
    process.env.XDG_DATA_HOME = testRoot;
    await initStorage(testRoot);

    try {
      const manager = new SessionManager();
      const agentId = 'agents/review';
      const { sessionId, messageId } = await createSession(manager, testRoot, agentId);
      const selected = 'x'.repeat(12_000);
      const reference = await manager.recordDirectToolResult(sessionId, agentId, messageId, {
        tool: 'load',
        toolInput: { scope: 'all' },
        output: { selected, overflow: 'y'.repeat(10_000) },
        completedAt: Date.now(),
      });
      const resultsTool = createResultsTool({ manager, sessionId, agentId });
      const query = {
        action: 'jq',
        resultId: reference.resultId,
        expression: '.selected',
      };
      const expected = { values: [selected], truncated: false };

      expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBeGreaterThan(10 * 1024);
      expect(Buffer.byteLength(JSON.stringify(expected), 'utf8')).toBeLessThanOrEqual(20 * 1024);
      await expect((resultsTool.execute as any)(query)).resolves.toEqual(expected);
    } finally {
      if (previousInlineLimit === undefined) delete process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES;
      else process.env.AGENTUSE_TOOL_INLINE_RESULT_BYTES = previousInlineLimit;
      if (previousQueryLimit === undefined) delete process.env.AGENTUSE_RESULT_QUERY_BYTES;
      else process.env.AGENTUSE_RESULT_QUERY_BYTES = previousQueryLimit;
      if (previousOutputLimit === undefined) delete process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES;
      else process.env.AGENTUSE_TOOL_MAX_OUTPUT_BYTES = previousOutputLimit;
    }
  });

  it('persists large direct output and queries it through the results tool', async () => {
    originalXdg = process.env.XDG_DATA_HOME;
    testRoot = await mkdtemp(join(tmpdir(), 'agentuse-direct-results-'));
    process.env.XDG_DATA_HOME = testRoot;
    await initStorage(testRoot);

    const manager = new SessionManager();
    const agentId = 'agents/review';
    const { sessionId, messageId } = await createSession(manager, testRoot, agentId);
    const output = {
      items: [
        { id: 'one', status: 'ready', body: 'x'.repeat(4_000) },
        { id: 'two', status: 'done', body: 'y'.repeat(4_000) },
      ],
    };
    const completedAt = Date.now();
    const reference = await manager.recordDirectToolResult(sessionId, agentId, messageId, {
      tool: 'load',
      toolInput: { scope: 'all' },
      output,
      completedAt,
    });

    expect(reference.resultId).toStartWith(`result_${messageId}_`);
    expect(reference.capabilities).toEqual({ read: false, grep: false, jq: true });
    await expect(manager.readCodeModeResult(sessionId, agentId, reference.resultId))
      .rejects.toThrow('use results.jq()');

    const resumedManager = new SessionManager();
    const resultsTool = createResultsTool({ manager: resumedManager, sessionId, agentId });
    await expect((resultsTool.execute as any)({
      action: 'jq',
      resultId: reference.resultId,
      expression: '.items[] | select(.status == "ready") | { id, status }',
      limit: 10,
    })).resolves.toEqual({ values: [{ id: 'one', status: 'ready' }], truncated: false });
    const listed = await (resultsTool.execute as any)({ action: 'list', limit: 10 });
    expect(listed).toEqual([
        expect.objectContaining({
          resultId: reference.resultId,
          tool: 'load',
          bytes: Buffer.byteLength(JSON.stringify(output), 'utf8'),
          completedAt,
        }),
      ]);
    expect(listed[0]).not.toHaveProperty('preview');
    expect(listed[0]).not.toHaveProperty('omitted');
    expect(listed[0]).not.toHaveProperty('hint');
  });

  it('searches structured output text and rejects an oversized follow-up query', async () => {
    const previousQueryLimit = process.env.AGENTUSE_RESULT_QUERY_BYTES;
    process.env.AGENTUSE_RESULT_QUERY_BYTES = '256';
    originalXdg = process.env.XDG_DATA_HOME;
    testRoot = await mkdtemp(join(tmpdir(), 'agentuse-direct-output-results-'));
    process.env.XDG_DATA_HOME = testRoot;
    await initStorage(testRoot);

    try {
      const manager = new SessionManager();
      const agentId = 'agents/review';
      const { sessionId, messageId } = await createSession(manager, testRoot, agentId);
      const output = {
        output: `header\nTotal cost: $1.14\n${'x'.repeat(1_000)}`,
        metadata: { exitCode: 0 },
      };
      const reference = await manager.recordDirectToolResult(sessionId, agentId, messageId, {
        tool: 'tools__bash',
        toolInput: { command: 'check-cost' },
        output,
        completedAt: Date.now(),
      });
      const resultsTool = createResultsTool({ manager, sessionId, agentId });

      expect(reference.capabilities).toEqual({ read: false, grep: true, jq: true });
      await expect((resultsTool.execute as any)({
        action: 'grep',
        resultId: reference.resultId,
        pattern: 'total cost',
        caseSensitive: false,
        limit: 1,
      })).resolves.toEqual({
        matches: [{
          line: 2,
          column: 1,
          excerpt: 'Total cost: $1.14',
          before: [],
          after: [],
        }],
        truncated: false,
      });
      await expect((resultsTool.execute as any)({
        action: 'jq',
        resultId: reference.resultId,
        expression: '.output',
      })).rejects.toThrow('RESULT_QUERY_TOO_LARGE: jq returned');
    } finally {
      if (previousQueryLimit === undefined) delete process.env.AGENTUSE_RESULT_QUERY_BYTES;
      else process.env.AGENTUSE_RESULT_QUERY_BYTES = previousQueryLimit;
    }
  });
});
