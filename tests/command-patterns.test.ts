import { describe, expect, test } from 'bun:test';
import { resolveBashPatterns, resolveCommandPatterns } from '../src/tools/command-patterns';
import { CommandValidator } from '../src/tools/command-validator';
import { BashPermissionController, isEffectful } from '../src/runner/approval-lease';
import { createBashTool } from '../src/tools/bash';

const context = { projectRoot: '/tmp/project', agentDir: '/tmp/project/agents', tmpDir: '/tmp' };

describe('Bash command path placeholders', () => {
  test('resolves all supported placeholders without mutating configuration', () => {
    const config = { commands: ['python3 ${agentDir}/check.py *', 'cat ${tmpDir}/*'], gated: ['python3 ${root}/publish.py *'] };
    const resolved = resolveBashPatterns(config, context);
    expect(resolved.commands[0]).toBe('python3 /tmp/project/agents/check.py *');
    expect(resolved.commands[1]).toMatch(/^cat \/(?:private\/)?tmp\/\*$/);
    expect(resolved.gated).toEqual(['python3 /tmp/project/publish.py *']);
    expect(config.commands[0]).toContain('${agentDir}');
  });

  test('allows the resolved script but not a sibling script', async () => {
    const patterns = resolveCommandPatterns(['python3 ${agentDir}/check.py *'], context);
    const validator = new CommandValidator(patterns, context.projectRoot, [], context);
    expect((await validator.validate('python3 /tmp/project/agents/check.py input.mp4')).allowed).toBe(true);
    expect((await validator.validate('python3 /tmp/project/agents/other.py input.mp4')).allowed).toBe(false);
  });

  test('keeps a resolved gated command effectful even with a broad auto-run grant', () => {
    const config = resolveBashPatterns({ commands: ['python3 *'], gated: ['python3 ${agentDir}/publish.py *'] }, context);
    const command = 'python3 /tmp/project/agents/publish.py draft';
    expect(isEffectful(command, config.gated!)).toBe(true);
    const permission = new BashPermissionController(config.gated!);
    expect(permission.isGated(command)).toBe(true);
    expect(permission.authorizeDispatch({ toolName: 'tools__bash', toolCallId: 'call', origin: 'direct', input: { command } }).block).toBe(true);
    permission.grantApprovedDirectCall('call', command);
    expect(permission.authorizeDispatch({ toolName: 'tools__bash', toolCallId: 'call', origin: 'direct', input: { command } }).block).toBeUndefined();
    expect(permission.authorizeDispatch({ toolName: 'tools__bash', toolCallId: 'call', origin: 'direct', input: { command } }).block).toBe(true);
    expect(isEffectful('python3 /tmp/project/agents/read.py draft', config.gated!)).toBe(false);
  });

  test('tool description advertises resolved commands', () => {
    const tool = createBashTool({ commands: ['python3 ${agentDir}/check.py *'] }, context.projectRoot, context);
    expect(tool.description).toContain('python3 /tmp/project/agents/check.py *');
    expect(tool.description).not.toContain('${agentDir}');
  });

  test('fails closed for missing agent directory or unsafe path characters', () => {
    expect(() => resolveCommandPatterns(['python3 ${agentDir}/check.py *'], { projectRoot: '/tmp' })).toThrow('no agent directory');
    for (const agentDir of ['/tmp/a*b', '/tmp/a?b', '/tmp/a b', '/tmp/a\nb', '/tmp/$(whoami)']) {
      expect(() => resolveCommandPatterns(['python3 ${agentDir}/check.py *'], { ...context, agentDir })).toThrow('metacharacters');
    }
  });

  test('does not expand environment variables or shell substitutions', () => {
    const patterns = ['echo ${env:SECRET}', 'echo $HOME', 'echo $(whoami)'];
    expect(resolveCommandPatterns(patterns, context)).toEqual(patterns);
  });
});
