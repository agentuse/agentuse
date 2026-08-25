import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../utils/logger';

/**
 * Gate seal: a human `reject` on an `await_human` gate is TERMINAL for the run.
 *
 * Once a run is sealed, no further `await_human` may suspend. The run can still
 * resume (so the agent performs its own cleanup - status updates, a final
 * summary), but it can never re-ask the human. This makes "Reject is terminal"
 * a mechanical runtime guarantee instead of something each agent's prompt has
 * to remember to honor - a bare reject that the model re-gated is exactly the
 * loop that re-asked one reviewer three times and burned ~1.6M tokens
 * (2026-07-22, x-engage-reply under the X Growth Manager).
 *
 * Only a human `reject` seals. `comment` is the revise-and-re-gate path and
 * must NOT seal; `approve` obviously does not. The seal is written at
 * decision-apply time (resume.ts) and read pre-dispatch in the execution loop's
 * toolApproval barrier, so - like the approval lease next to it - it survives
 * the suspend/resume process boundary (the daemon writes it, the resumed worker
 * reads it).
 */

export const GATE_SEAL_FILENAME = 'gate-seal.json';

export interface GateSeal {
  version: 1;
  sealedAt: number;
  reason: string;
}

export interface GateSealSnapshot {
  exists: boolean;
  raw?: string;
}

/**
 * Per-session seal persistence. File-based in the session directory, next to
 * the approval lease and effect WAL, and read synchronously per gate dispatch.
 */
export class GateSealStore {
  private dir: string | undefined;

  constructor(sessionDir?: string) {
    this.dir = sessionDir;
  }

  bind(sessionDir: string): void {
    this.dir = sessionDir;
  }

  get filePath(): string | undefined {
    return this.dir ? path.join(this.dir, GATE_SEAL_FILENAME) : undefined;
  }

  isSealed(): boolean {
    const filePath = this.filePath;
    if (!filePath) return false;
    try {
      // Fail closed: a damaged seal still represents a terminal reviewer
      // rejection until an explicit rollback removes or restores it.
      return fs.existsSync(filePath);
    } catch {
      return false;
    }
  }

  snapshot(): GateSealSnapshot {
    const filePath = this.filePath;
    if (!filePath) return { exists: false };
    try {
      if (!fs.existsSync(filePath)) return { exists: false };
      return { exists: true, raw: fs.readFileSync(filePath, 'utf8') };
    } catch {
      // Preserve fail-closed existence even when the bytes cannot be read.
      return { exists: true };
    }
  }

  seal(reason: string, at: number = Date.now()): void {
    const filePath = this.filePath;
    if (!filePath) {
      logger.debug('[GateSeal] seal dropped: no session dir bound');
      return;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      const seal: GateSeal = { version: 1, sealedAt: at, reason };
      fs.writeFileSync(filePath, JSON.stringify(seal, null, 2));
    } catch (error) {
      logger.debug(`[GateSeal] seal failed: ${(error as Error).message}`);
    }
  }

  restoreSnapshot(snapshot: GateSealSnapshot): boolean {
    const filePath = this.filePath;
    if (!filePath) return false;
    if (!snapshot.exists) {
      return this.unseal();
    }
    if (snapshot.raw === undefined) {
      // The prior seal existed but was unreadable. Never erase a terminal
      // rejection merely because rollback could not snapshot its bytes.
      return fs.existsSync(filePath);
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, snapshot.raw);
      return true;
    } catch (error) {
      logger.debug(`[GateSeal] snapshot restore failed: ${(error as Error).message}`);
      return false;
    }
  }

  unseal(): boolean {
    const filePath = this.filePath;
    if (!filePath) return false;
    try {
      fs.rmSync(filePath, { force: true });
      return true;
    } catch (error) {
      logger.debug(`[GateSeal] unseal failed: ${(error as Error).message}`);
      return false;
    }
  }
}
