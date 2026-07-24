import { describe, expect, it } from 'bun:test';
import { spawn, type ChildProcessWithoutNullStreams } from 'child_process';
import { mkdtemp, rm } from 'fs/promises';
import { join } from 'path';
import { tmpdir } from 'os';
import { initStorage } from '../src/storage';
import { SessionManager } from '../src/session';

// Drive the real internal worker over its stdin/stdout JSON-line IPC (the same
// channel serve uses), so the 'reconcile-orphans' dispatch + response envelope
// are exercised end-to-end, not just the extracted reconcile function.
function startWorker(dataDir: string): ChildProcessWithoutNullStreams {
  return spawn(process.execPath, ['src/index.ts', '--internal-worker'], {
    cwd: process.cwd(),
    stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, XDG_DATA_HOME: dataDir },
  });
}

function rpc(child: ChildProcessWithoutNullStreams, req: Record<string, unknown> & { id: string }): Promise<any> {
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timeout = setTimeout(() => { cleanup(); reject(new Error(`no response for ${req.id}`)); }, 8_000);
    const onData = (chunk: Buffer) => {
      buffer += chunk.toString();
      let idx: number;
      while ((idx = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: any;
        try { msg = JSON.parse(line); } catch { continue; }
        if (msg.type === 'ready') continue;
        if (msg.id === req.id) { cleanup(); resolve(msg); return; }
      }
    };
    const cleanup = () => { clearTimeout(timeout); child.stdout.off('data', onData); };
    child.stdout.on('data', onData);
    child.stdin.write(JSON.stringify(req) + '\n');
  });
}

async function plantStuckRunningSession(dataDir: string) {
  process.env.XDG_DATA_HOME = dataDir;
  await initStorage(dataDir);
  const sm = new SessionManager();
  const sessionID = await sm.createSession({
    agent: { id: 'agents/review', name: 'review', isSubAgent: false },
    model: 'demo:test', version: 'test', config: {},
    project: { root: dataDir, cwd: dataDir },
  });
  // createSession correctly stamps this live test process as owner. Replace it
  // with an impossible PID to model the killed worker the fixture claims to
  // create, otherwise reconciliation must (correctly) leave it alone.
  await sm.updateSession(sessionID, 'agents/review', { owner: { pid: 0x7fffffff } });
  return sessionID;
}

describe('internal worker reconcile-orphans IPC', () => {
  it('flips a stuck-running session to WORKER_INTERRUPTED over real IPC', async () => {
    const dataDir = await mkdtemp(join(tmpdir(), 'agentuse-reconcile-ipc-'));
    const sessionID = await plantStuckRunningSession(dataDir);
    const child = startWorker(dataDir);
    try {
      // Wait for the ready line, then fire the reconcile request.
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(() => reject(new Error('worker not ready')), 5_000);
        const onData = (chunk: Buffer) => {
          for (const line of chunk.toString().split('\n')) {
            if (!line.trim()) continue;
            try { if (JSON.parse(line).type === 'ready') { clearTimeout(t); child.stdout.off('data', onData); resolve(); return; } } catch {}
          }
        };
        child.stdout.on('data', onData);
      });

      const res = await rpc(child, {
        id: 'rec-1',
        type: 'reconcile-orphans',
        projectRoot: dataDir,
        reconcileCutoff: Date.now() + 60_000, // session was touched before this
      });

      expect(res.success).toBe(true);
      expect(res.reconciled.map((r: any) => r.sessionId)).toContain(sessionID);

      // Confirm the on-disk transition the worker performed.
      const sm = new SessionManager();
      const found = await sm.findSession(sessionID);
      expect(found?.session.status).toBe('error');
      expect(found?.session.error?.code).toBe('WORKER_INTERRUPTED');
    } finally {
      if (!child.killed && child.exitCode === null) { child.stdin.end(); child.kill('SIGKILL'); }
      await rm(dataDir, { recursive: true, force: true });
      delete process.env.XDG_DATA_HOME;
    }
  });
});
