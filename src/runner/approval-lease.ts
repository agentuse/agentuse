import * as fs from 'fs';
import * as path from 'path';
import { match as wildcardMatch } from '../tools/wildcard';
import { logger } from '../utils/logger';

/**
 * Approval leases: the machine-readable grant derived from a human-approved
 * `await_human` call (agentuse-lab#165, Phase 2).
 *
 * Trust chain: the LLM proposes (writes `changes[]`, spec'd as "the exact
 * actions executed on approval, verbatim"), the human approves (the ONLY
 * grant), the runtime matches mechanically. Gated commands (declared in
 * human-authored `tools.bash.gated` frontmatter) only run when covered by the
 * latest approved lease; anything uncovered is auto-denied with a redirect to
 * re-gate. No LLM ever approves anything, and the human still sees exactly
 * one rich gate per operation - never per-call micro-approvals.
 */

export const LEASE_FILENAME = 'approval-lease.json';

/**
 * Containment matching (lease content appearing inside a longer command) only
 * applies to reasonably long grants; a short grant like "yes" or "birdc" would
 * otherwise cover almost anything. Short grants must match the whole command.
 */
const MIN_CONTAINMENT_CHARS = 16;

export interface LeaseEntry {
  content: string;
  label?: string;
}

export interface ApprovalLease {
  version: 1;
  grantedAt: number;
  entries: LeaseEntry[];
}

/**
 * Normalize for lease matching: collapse whitespace runs (shell commands and
 * drafts wrap differently) and drop backslash escapes before quotes (the model
 * shell-quotes the approved text when embedding it in a command).
 */
export function normalizeForLeaseMatch(value: string): string {
  return value
    .replace(/\\(["'`])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Derive lease entries from an `await_human` input: one entry per `changes[]`
 * item with non-empty content. Anything else in the gate (draft, summary,
 * context) is reviewer-facing and grants nothing.
 */
export function deriveLeaseEntries(input: unknown): LeaseEntry[] {
  if (!input || typeof input !== 'object') return [];
  const changes = (input as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return [];
  return changes
    .map((entry) => {
      const rec = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      const content = typeof rec.content === 'string' ? rec.content.trim() : '';
      if (!content) return undefined;
      return {
        content,
        ...(typeof rec.label === 'string' && rec.label.trim() ? { label: rec.label.trim() } : {}),
      };
    })
    .filter((entry): entry is LeaseEntry => entry !== undefined);
}

/** Whether a bash command matches any human-declared effect pattern. */
export function isEffectful(command: string, effectPatterns: string[]): boolean {
  return effectPatterns.some((pattern) => wildcardMatch(command, pattern));
}

/**
 * Whether a command is covered by a lease: the command equals a granted entry,
 * or contains a (long enough) granted entry verbatim - the common shape where
 * the approved content is the payload of a longer command
 * (`birdc reply <id> "<approved text>"`).
 */
export function commandCoveredByLease(command: string, lease: ApprovalLease | undefined): boolean {
  if (!lease || lease.entries.length === 0) return false;
  const normalizedCommand = normalizeForLeaseMatch(command);
  return lease.entries.some((entry) => {
    const normalizedContent = normalizeForLeaseMatch(entry.content);
    if (!normalizedContent) return false;
    if (normalizedCommand === normalizedContent) return true;
    return normalizedContent.length >= MIN_CONTAINMENT_CHARS && normalizedCommand.includes(normalizedContent);
  });
}

/**
 * Per-session lease persistence. File-based (in the session directory, next to
 * the effect WAL) so a lease granted at resume time in one process is visible
 * to the resumed run in another, and survives suspend/resume cycles.
 *
 * Lifecycle:
 * - approve decision  -> grant (REPLACES any prior lease; the latest approved
 *   plan is the only active grant)
 * - reject/comment    -> revoke
 * - new gate registers -> revoke (a new plan supersedes prior approvals)
 */
export class LeaseStore {
  private dir: string | undefined;

  constructor(sessionDir?: string) {
    this.dir = sessionDir;
  }

  bind(sessionDir: string): void {
    this.dir = sessionDir;
  }

  get filePath(): string | undefined {
    return this.dir ? path.join(this.dir, LEASE_FILENAME) : undefined;
  }

  read(): ApprovalLease | undefined {
    const filePath = this.filePath;
    if (!filePath) return undefined;
    try {
      const raw = fs.readFileSync(filePath, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && Array.isArray(parsed.entries)) {
        return parsed as ApprovalLease;
      }
      return undefined;
    } catch {
      return undefined;
    }
  }

  grant(lease: ApprovalLease): void {
    const filePath = this.filePath;
    if (!filePath) {
      logger.debug('[Lease] grant dropped: no session dir bound');
      return;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(lease, null, 2));
    } catch (error) {
      logger.debug(`[Lease] grant failed: ${(error as Error).message}`);
    }
  }

  revoke(): void {
    const filePath = this.filePath;
    if (!filePath) return;
    try {
      fs.rmSync(filePath, { force: true });
    } catch (error) {
      logger.debug(`[Lease] revoke failed: ${(error as Error).message}`);
    }
  }

  isCovered(command: string): boolean {
    return commandCoveredByLease(command, this.read());
  }
}
