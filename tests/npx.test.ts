import { describe, expect, it } from 'bun:test';
import { cliCommand, isNpxRun } from '../src/utils/npx';

describe('npx detection', () => {
  it('recognizes npx cache paths on any platform', () => {
    expect(isNpxRun('/home/me/.npm/_npx/abc123/node_modules/agentuse/bin/cli.js')).toBe(true);
    expect(isNpxRun('C:\\Users\\me\\AppData\\Local\\npm-cache\\_npx\\abc\\node_modules\\agentuse\\bin\\cli.js')).toBe(true);
    expect(isNpxRun('/repo/node_modules/.npx-cache/agentuse/bin/cli.js')).toBe(true);
    expect(isNpxRun('/usr/local/lib/node_modules/agentuse/bin/cli.js')).toBe(false);
  });

  it('prints the command that works where setup ran', () => {
    expect(cliCommand('/home/me/.npm/_npx/abc123/node_modules/agentuse/bin/cli.js')).toBe('npx agentuse');
    expect(cliCommand('/usr/local/lib/node_modules/agentuse/bin/cli.js')).toBe('agentuse');
  });
});
