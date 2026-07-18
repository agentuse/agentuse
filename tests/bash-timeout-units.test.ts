import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBashTool } from '../src/tools/bash';

describe('bash tool timeout units', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-timeout-test-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  test('config timeout accepts a suffixed duration string', async () => {
    const tool = createBashTool(
      { commands: ['sleep *'], timeout: '1s' },
      projectRoot,
      { projectRoot }
    ) as any;

    const started = Date.now();
    const result = await tool.execute({ command: 'sleep 5' }, { toolCallId: 'call-1' });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(result.metadata.timedOut).toBe(true);
  });

  test('bare-number config timeout stays milliseconds (back-compat)', async () => {
    const tool = createBashTool(
      { commands: ['sleep *'], timeout: 500 },
      projectRoot,
      { projectRoot }
    ) as any;

    const started = Date.now();
    const result = await tool.execute({ command: 'sleep 5' }, { toolCallId: 'call-2' });
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(result.metadata.timedOut).toBe(true);
  });

  test('invalid config timeout throws at tool creation', () => {
    expect(() =>
      createBashTool({ commands: ['echo *'], timeout: 'soon' }, projectRoot, { projectRoot })
    ).toThrow(/Invalid duration for tools\.bash\.timeout/);
  });
});
