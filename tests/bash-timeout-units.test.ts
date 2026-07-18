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

  test('bare-number config timeout is rejected with a corrective error', () => {
    expect(() =>
      createBashTool({ commands: ['sleep *'], timeout: 120000 }, projectRoot, { projectRoot })
    ).toThrow(/no longer accepts bare numbers.*"120s" if 120000 was milliseconds/s);

    expect(() =>
      createBashTool({ commands: ['sleep *'], timeout: 30 }, projectRoot, { projectRoot })
    ).toThrow(/no longer accepts bare numbers/);
  });

  test('per-call timeout accepts a duration string', async () => {
    const tool = createBashTool({ commands: ['sleep *'] }, projectRoot, { projectRoot }) as any;

    const started = Date.now();
    const result = await tool.execute(
      { command: 'sleep 5', timeout: '1s' },
      { toolCallId: 'call-3' }
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3000);
    expect(result.metadata.timedOut).toBe(true);
  });

  test('per-call bare number under 1000 is rejected with a corrective error', async () => {
    const tool = createBashTool({ commands: ['echo *'] }, projectRoot, { projectRoot }) as any;

    const result = await tool.execute(
      { command: 'echo hi', timeout: 30 },
      { toolCallId: 'call-4' }
    );

    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('MILLISECONDS');
    expect(parsed.error).toContain('"30s"');
    expect(parsed.error).toContain('30000');
  });

  test('per-call bare number >= 1000 still works as milliseconds', async () => {
    const tool = createBashTool({ commands: ['sleep *'] }, projectRoot, { projectRoot }) as any;

    const started = Date.now();
    const result = await tool.execute(
      { command: 'sleep 5', timeout: 1000 },
      { toolCallId: 'call-5' }
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(3500);
    expect(result.metadata.timedOut).toBe(true);
  });

  test('explicit sub-second duration string is honored', async () => {
    const tool = createBashTool({ commands: ['sleep *'] }, projectRoot, { projectRoot }) as any;

    const started = Date.now();
    const result = await tool.execute(
      { command: 'sleep 5', timeout: '500ms' },
      { toolCallId: 'call-6' }
    );
    const elapsed = Date.now() - started;

    expect(elapsed).toBeLessThan(2500);
    expect(result.metadata.timedOut).toBe(true);
  });

  test('invalid config timeout throws at tool creation', () => {
    expect(() =>
      createBashTool({ commands: ['echo *'], timeout: 'soon' }, projectRoot, { projectRoot })
    ).toThrow(/Invalid duration for tools\.bash\.timeout/);
  });
});
