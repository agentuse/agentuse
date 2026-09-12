import { describe, expect, it } from 'bun:test';
import { Command } from 'commander';
import { registerTestCommands, type RunCommandOptions } from '../src/cli/test';

function cli() {
  const calls: Array<{ file: string; prompt: string[]; options: RunCommandOptions }> = [];
  const output: string[] = [];
  const program = new Command().exitOverride().configureOutput({ writeOut: s => output.push(s), writeErr: s => output.push(s) });
  registerTestCommands(program, async (file, prompt, options) => { calls.push({ file, prompt, options }); });
  return { calls, output, run: (args: string[]) => program.parseAsync(['node', 'agentuse', 'test', ...args]) };
}
describe('test command public contract', () => {
  it('explains workflow and result in top-level help', async () => {
    const c = cli(); await c.run([]);
    expect(c.output.join('')).toContain('test workflow');
    expect(c.output.join('')).toContain('same evidence');
    expect(c.calls).toHaveLength(0);
  });
  it('workflow mocks all tools by default and preserves custom prompt and gate choice', async () => {
    const c = cli(); await c.run(['workflow', 'a.agentuse', 'Focus on invoices', '--approval', 'reject']);
    expect(c.calls[0]).toMatchObject({ file: 'a.agentuse', prompt: ['Focus on invoices'], options: { mock: true, mockApproval: 'reject' } });
  });
  it('requires explicit gated scope for live non-gated tools', async () => {
    const c = cli(); await c.run(['workflow', 'a.agentuse', '--scope', 'gated']);
    expect(c.calls[0]?.options.mockGated).toBe(true);
    expect(c.calls[0]?.options.mock).toBeUndefined();
  });
  it('result passes a source session without enabling mock mode', async () => {
    const c = cli(); await c.run(['result', 'a.agentuse', '--session', 'source', '--judge', 'quality.agentuse', '--json']);
    expect(c.calls[0]?.options).toMatchObject({ resultSession: 'source', judge: 'quality.agentuse', json: true });
    expect(c.calls[0]?.options.mock).toBeUndefined();
  });
  it('keeps legacy replay and mock invocations', async () => {
    const replay = cli(); await replay.run(['a.agentuse', '--replay', 'source']);
    expect(replay.calls[0]?.options.replay).toBe('source');
    const flow = cli(); await flow.run(['a.agentuse', '--scope', 'all']);
    expect(flow.calls[0]?.options.mock).toBe(true);
  });
  for (const args of [
    ['result', 'a.agentuse'], ['result', 'a.agentuse', '--session', 's', '--scope', 'gated'],
    ['result', 'https://example.com/a.agentuse', '--session', 's'],
    ['workflow', 'a.agentuse', '--scope', 'whatever'],
    ['workflow', 'a.agentuse', '--approval', 'comment:'],
    ['a.agentuse', 'new prompt', '--replay', 's'],
    ['--scope', 'gated', 'result', 'a.agentuse', '--session', 's'],
  ]) it(`rejects invalid arguments: ${args.join(' ')}`, async () => {
    const c = cli(); await expect(c.run(args)).rejects.toThrow(); expect(c.calls).toHaveLength(0);
  });
});
