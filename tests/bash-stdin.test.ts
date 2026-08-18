import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBashTool } from '../src/tools/bash';

describe('bash tool stdin', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-stdin-test-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  // A piped-but-never-written stdin never reaches EOF, so any CLI that reads
  // stdin blocks until the call's timeout and returns zero output.
  test('a command that reads stdin sees EOF instead of hanging', async () => {
    const tool = createBashTool(
      { commands: ['cat *', 'cat'], timeout: '5s' },
      projectRoot,
      { projectRoot }
    ) as any;

    const started = Date.now();
    const result = await tool.execute({ command: 'cat' }, { toolCallId: 'call-stdin' });

    // Exit codes are unreliable under this runner, so assert the thing the
    // regression is about: the call returns instead of burning its timeout.
    expect(result.metadata.timedOut).toBe(false);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
