import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { spawnSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createBashTool } from '../src/tools/bash';

// Under bun 1.3.8 every shell spawn from inside the test runner exits 1 with no
// output, which would make the assertions below pass for the wrong reason. Probe
// once and skip loudly instead of reporting a vacuous green.
const canSpawnShell = (() => {
  const probe = spawnSync('echo ok', { shell: true, encoding: 'utf8' });
  return probe.status === 0 && (probe.stdout ?? '').includes('ok');
})();

describe('bash tool stdin', () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'bash-stdin-test-'));
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  // A piped-but-never-written stdin never reaches EOF, so any command that reads
  // stdin blocks until the call's timeout and comes back with zero output and a
  // null exit code — indistinguishable from an unresponsive external service.
  test.skipIf(!canSpawnShell)('a command that reads stdin sees EOF instead of hanging', async () => {
    const tool = createBashTool(
      { commands: ['cat'], timeout: '5s' },
      projectRoot,
      { projectRoot }
    ) as any;

    const started = Date.now();
    const result = await tool.execute({ command: 'cat' }, { toolCallId: 'call-stdin' });

    expect(result.metadata.timedOut).toBe(false);
    expect(result.metadata.exitCode).toBe(0);
    expect(Date.now() - started).toBeLessThan(2000);
  });
});
