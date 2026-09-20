import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { BashOutputSchema, createBashTool } from '../src/tools/bash';
import { ToolDispatcher } from '../src/runner/tool-dispatcher';
import { executeCodeMode } from '../src/runner/code-mode';

describe('Bash output streams', () => {
  let root: string;
  beforeEach(async () => { root = await mkdtemp(join(tmpdir(), 'bash-streams-')); });
  afterEach(async () => { await rm(root, { recursive: true, force: true }); });

  it('keeps JSON stdout separate from stderr and nonzero-exit metadata', async () => {
    const bash = createBashTool({ commands: ['node -e *'] }, root);
    const result = BashOutputSchema.parse(await bash.execute({
      command: `node -e 'process.stdout.write(JSON.stringify({text:"café 🙂 [stderr]"})); process.stderr.write("progress\\n"); process.exitCode = 7'`,
    }));
    expect(result.stdout).toBe(JSON.stringify({ text: 'café 🙂 [stderr]' }));
    expect(JSON.parse(result.stdout!)).toEqual({ text: 'café 🙂 [stderr]' });
    expect(result.stderr).toBe('progress\n');
    expect(result.metadata).toMatchObject({ exitCode: 7, timedOut: false, truncated: false });
    expect(result.output).toBe(`${result.stdout}\n\n[stderr]\nprogress\n\n\n<bash_metadata>\nexit code: 7\n</bash_metadata>`);
  });

  it('represents empty streams without inserting display placeholders', async () => {
    const bash = createBashTool({ commands: ['node -e *'] }, root);
    const empty = BashOutputSchema.parse(await bash.execute({ command: `node -e ''` }));
    expect(empty.stdout).toBe('');
    expect(empty.stderr).toBe('');
    expect(empty.output).toBe('(no output)');
    const stderrOnly = BashOutputSchema.parse(await bash.execute({
      command: `node -e 'process.stderr.write("notice")'`,
    }));
    expect(stderrOnly.stdout).toBe('');
    expect(stderrOnly.stderr).toBe('notice');
    expect(stderrOnly.output).toBe('[stderr]\nnotice');
  });

  it('keeps streams absent for commands refused before execution', async () => {
    const bash = createBashTool({ commands: ['printf *'] }, root);
    const denied = BashOutputSchema.parse(await bash.execute({ command: 'not-allowed' }));
    expect(JSON.parse(denied.output).success).toBe(false);
    expect(denied).not.toHaveProperty('stdout');
    expect(denied).not.toHaveProperty('stderr');
    expect(BashOutputSchema.parse({ output: 'historical output' })).toEqual({ output: 'historical output' });
  });

  it('exposes stdout and stderr through validated Code Mode contracts', async () => {
    const bash = createBashTool({ commands: ['node -e *'] }, root);
    const dispatcher = new ToolDispatcher({ tools__bash: bash });
    const command = `node -e 'process.stdout.write(JSON.stringify({ok:true})); process.stderr.write("loading")'`;
    const value = await executeCodeMode(`
      const r = await tools.tools__bash({ command: ${JSON.stringify(command)} });
      if (r.stdout === undefined || r.metadata?.truncated) throw new Error("No complete stdout");
      return { data: JSON.parse(r.stdout), diagnostic: r.stderr };
    `, { dispatcher, toolDefinitions: dispatcher.codeModeTools(), toolNames: ['tools__bash'], parentCallId: 'streams' });
    expect(value).toEqual({ data: { ok: true }, diagnostic: 'loading' });
  });
});
