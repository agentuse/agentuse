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
      return fs.existsSync(filePath);
    } catch {
      return false;
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
}
