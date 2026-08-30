import { describe, expect, test } from 'bun:test';
import { Command } from 'commander';
import { addPluginCommands, createPluginsCommand } from '../src/cli/plugins';

describe('plugin CLI namespace', () => {
  test('uses plugins as the canonical command surface', () => {
    const command = createPluginsCommand();

    expect(command.name()).toBe('plugins');
    expect(command.aliases()).toContain('plugin');
    expect(command.commands.map((child) => child.name())).toEqual([
      'install',
      'update',
      'remove',
      'list',
    ]);
    expect(command.helpInformation()).toContain('Install and manage AgentUse plugins');
  });

  test('keeps top-level lifecycle commands as hidden compatibility aliases', () => {
    const program = new Command().name('agentuse');
    addPluginCommands(program);

    const help = program.helpInformation();
    expect(help).toContain('plugins|plugin');
    expect(help).not.toMatch(/^\s+install\s/m);
    expect(help).not.toMatch(/^\s+update\s/m);
    expect(help).not.toMatch(/^\s+list\s/m);
    expect(help).not.toMatch(/^\s+remove\s/m);
    expect(program.commands.map((command) => command.name())).toEqual([
      'plugins',
      'install',
      'remove',
      'list',
      'update',
    ]);
  });
});
