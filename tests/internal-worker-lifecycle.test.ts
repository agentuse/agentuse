import { describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';

function waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => {
      reject(new Error('worker did not become ready'));
    }, 5_000);

    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString();
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue;
        try {
          const message = JSON.parse(line);
          if (message.type === 'ready') {
            clearTimeout(timeout);
            resolve();
            return;
          }
        } catch {
          // Keep waiting for the JSON ready line.
        }
      }
    });

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      reject(new Error(`worker exited before ready: ${code ?? signal}`));
    });
  });
}

function waitForExit(child: ChildProcessWithoutNullStreams): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      reject(new Error('worker did not exit after stdin closed'));
    }, 5_000);

    child.once('exit', (code, signal) => {
      clearTimeout(timeout);
      resolve({ code, signal });
    });
  });
}

describe('internal worker lifecycle', () => {
  it('exits when parent IPC stdin closes', async () => {
    const child = spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
      cwd: process.cwd(),
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    try {
      await waitForReady(child);
      const exited = waitForExit(child);
      child.stdin.end();
      expect(await exited).toMatchObject({ code: 0, signal: null });
    } finally {
      if (!child.killed && child.exitCode === null) child.kill('SIGKILL');
    }
  });
});
