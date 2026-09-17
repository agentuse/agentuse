import { describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';
import { buildCodeModeToolContracts, codeModeDeclarations } from '../src/runner/code-mode-contracts';
import { executeCodeMode, executeCodeModeDetailed } from '../src/runner/code-mode';
import { typecheckCodeMode, typecheckCodeModeLocal } from '../src/runner/code-mode-typecheck';
import { ToolDispatcher } from '../src/runner/tool-dispatcher';
import { BashOutputSchema, createBashTool } from '../src/tools/bash';
import { createSearchTool } from '../src/tools/filesystem';
import { createOverlayFilesystemTools } from '../src/tools/filesystem-overlay';

const noTools = { dispatcher: { dispatch: async () => { throw new Error('unexpected dispatch'); } },
  toolNames: [], parentCallId: 'compatibility' };

describe('Code Mode session regression cases', () => {
  it('accepts the observed paged-read form and charges reads to the shared budget', async () => {
    const page = { kind: 'text' as const, content: 'hello', offset: 6500, bytes: 5,
      totalBytes: 7000, truncated: true, nextOffset: 6505 };
    let reads = 0;
    const resultAccess = { read: async () => ({ original: true }), list: async () => [],
      page: async (id: string, options: { offset?: number; maxBytes?: number }) => {
        expect(id).toBe('saved'); expect(options).toEqual({ offset: 6500, maxBytes: 14000 });
        reads++; return page;
      } };
    const result = await executeCodeModeDetailed(
      'const r = await results.read("saved", { offset: 6500, maxBytes: 14000 }); return { text: r.content, next: r.nextOffset };',
      { ...noTools, resultAccess });
    expect(result.value).toEqual({ text: 'hello', next: 6505 });
    expect(result.telemetry.resultReads).toBe(1);
    expect(reads).toBe(1);
    expect(await executeCodeMode('return results.read("saved");', { ...noTools, resultAccess }))
      .toEqual({ original: true });
    await expect(executeCodeMode('return results.read("saved", { offset: -1 });',
      { ...noTools, resultAccess })).rejects.toThrow();
    await expect(executeCodeMode('await results.read("saved"); return results.read("saved", { offset: 6500, maxBytes: 14000 });',
      { ...noTools, resultAccess, limits: { resultReads: 1 } })).rejects.toThrow(/result operations/);
    expect(reads).toBe(1);
  });

  it('types actual Bash output and preserves successful, failed, and aborted envelopes', async () => {
    const root = await mkdtemp(join(tmpdir(), 'bash-contract-'));
    try {
      const bash = createBashTool({ commands: ['printf *', 'false'] }, root);
      const dispatcher = new ToolDispatcher({ tools__bash: bash });
      const toolDefinitions = dispatcher.codeModeTools();
      const options = { dispatcher, toolDefinitions, toolNames: ['tools__bash'], parentCallId: 'bash-contract' };
      expect(await executeCodeMode('const r = await tools.tools__bash({ command: "printf hello" }); return { text: r.output, exit: r.metadata?.exitCode };', options))
        .toEqual({ text: 'hello', exit: 0 });
      const failed = await dispatcher.dispatch('tools__bash', { command: 'false' }, { toolCallId: 'failed' });
      expect(BashOutputSchema.parse(failed).metadata?.exitCode).toBe(1);
      const denied = await bash.execute!({ command: 'not-allowed' }, { toolCallId: 'denied', messages: [] });
      expect(JSON.parse(BashOutputSchema.parse(denied).output).success).toBe(false);
      const aborted = await bash.execute!({ command: 'printf hello' }, {
        toolCallId: 'aborted', messages: [], abortSignal: AbortSignal.abort(),
      });
      expect(BashOutputSchema.parse(aborted).metadata?.aborted).toBe(true);
      await expect(executeCodeMode('const r = await tools.tools__bash({ command: "printf hello" }); return r.value;', options))
        .rejects.toThrow(/Available fields:.*output/);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('keeps small numeric limits and descriptions in normal and overlay search declarations', async () => {
    const root = await mkdtemp(join(tmpdir(), 'search-contract-'));
    try {
      const normal = createSearchTool([{ path: root, permissions: ['read'] }], { projectRoot: root });
      const overlay = createOverlayFilesystemTools({ scopeRoot: root, editRoot: join(root, 'edit'),
        basePath: join(root, 'base.json'), redact: text => text, context: { projectRoot: root } }).tools__filesystem_search!;
      for (const search of [normal, overlay]) {
        const declarations = codeModeDeclarations(await buildCodeModeToolContracts({ search }, ['search']));
        expect(declarations).toContain('context_lines?: 0 | 1 | 2 | 3 | 4 | 5');
        expect(declarations).toContain('Lines of context');
        await typecheckCodeModeLocal('return tools.search({ file_path: "/guide.md", query: "target", context_lines: 2 });', declarations, 32 * 1024 * 1024);
        await expect(typecheckCodeModeLocal('return tools.search({ file_path: "/guide.md", query: "target", context_lines: 6 });', declarations, 32 * 1024 * 1024))
          .rejects.toThrow(/TS2322/);
      }
      const contracts = await buildCodeModeToolContracts({ demo: { inputSchema: z.object({
        arg: z.string().describe('unsafe */ declare const injected: string; /*'),
      }) } }, ['demo']);
      await typecheckCodeModeLocal('return tools.demo({ arg: "ok" });', codeModeDeclarations(contracts), 32 * 1024 * 1024);
    } finally { await rm(root, { recursive: true, force: true }); }
  });

  it('reports multiple bounded diagnostics identically in both compiler paths without executing tools', async () => {
    const declarations = codeModeDeclarations(await buildCodeModeToolContracts({ load: {
      inputSchema: z.object({}),
    } }, ['load']));
    const source = 'await tools.load({});\nfunction summarize(r) { return r; }\nreturn results.read("saved", {}, 3);';
    let expected = '';
    for (const check of [typecheckCodeModeLocal, typecheckCodeMode]) {
      try { await check(source, declarations, 32 * 1024 * 1024); throw new Error('expected rejection'); }
      catch (error) {
        const message = (error as Error).message;
        expect(message).toContain('user.ts:2:');
        expect(message).toContain('TS7006'); expect(message).toContain('TS2554');
        expect(message).toContain('Expected:'); expect(message).toContain('r: unknown');
        expect(message.length).toBeLessThanOrEqual(6000);
        if (expected) expect(message).toBe(expected);
        expected = message;
      }
    }
    let calls = 0;
    await expect(executeCodeMode(source, { ...noTools, toolNames: ['load'], declarations,
      dispatcher: { dispatch: async () => { calls++; } } })).rejects.toThrow(/TS7006/);
    expect(calls).toBe(0);
    await expect(typecheckCodeModeLocal(Array.from({ length: 20 }, (_, i) => `const x${i}: number = "bad";`).join('\n'), declarations, 32 * 1024 * 1024))
      .rejects.toThrow('12 additional diagnostics omitted');
  });
});
