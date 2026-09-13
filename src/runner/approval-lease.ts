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

export interface LeaseEntry {
  content: string;
  label?: string;
  /** Optional originating reviewer choice. Retained for auditability after the
   * grant is filtered to the selected option. */
  optionId?: string;
  /** One-shot authorization is burned before dispatch. Keeping the tombstone
   * distinguishes an unapproved command from an approved command already used. */
  consumedAt?: number;
}

export interface ApprovalLease {
  version: 1;
  grantedAt: number;
  entries: LeaseEntry[];
}

/** Trim transport-level edge whitespace without changing shell semantics. */
export function normalizeForLeaseMatch(value: string): string {
  return value.trim();
}

/**
 * Derive lease entries from an `await_human` input: one entry per `changes[]`
 * item with non-empty content. Anything else in the gate (draft, summary,
 * context) is reviewer-facing and grants nothing.
 */
export function deriveLeaseEntries(input: unknown, choice?: unknown): LeaseEntry[] {
  if (!input || typeof input !== 'object') return [];
  const changes = (input as { changes?: unknown }).changes;
  if (!Array.isArray(changes)) return [];
  const entries = changes
    .map((entry) => {
      const rec = entry && typeof entry === 'object' ? entry as Record<string, unknown> : {};
      const content = typeof rec.content === 'string' ? rec.content.trim() : '';
      if (!content) return undefined;
      return {
        content,
        ...(typeof rec.label === 'string' && rec.label.trim() ? { label: rec.label.trim() } : {}),
        ...(typeof rec.optionId === 'string' && rec.optionId.trim() ? { optionId: rec.optionId.trim() } : {}),
      };
    })
    .filter((entry): entry is LeaseEntry => entry !== undefined);
  if (typeof choice !== 'string' || !choice.trim()) return entries;
  return entries.filter((entry) => entry.optionId === undefined || entry.optionId === choice);
}

/** Whether a bash command matches any human-declared effect pattern. */
export function isEffectful(command: string, effectPatterns: string[]): boolean {
  return effectPatterns.some((pattern) => wildcardMatch(command, pattern));
}

export type BashDispatchOrigin = 'direct' | 'code-mode' | undefined;

export interface BashDispatchPermission {
  block?: boolean;
  reason?: string;
}

/**
 * One permission boundary for direct and Code Mode Bash calls.
 *
 * The command validator still owns the authored allowlist and path policy.
 * This controller owns the stricter `gated` precedence at the final dispatcher
 * boundary. Direct calls receive a one-shot permit only after their approval
 * lease is consumed; Code Mode calls can never consume or bypass that lease.
 */
export class BashPermissionController {
  private readonly gatedPatterns: string[];
  private readonly directPermits = new Map<string, string>();

  constructor(gatedPatterns: readonly string[]) {
    this.gatedPatterns = [...gatedPatterns];
  }

  isGated(command: string): boolean {
    return isEffectful(command, this.gatedPatterns);
  }

  grantApprovedDirectCall(toolCallId: string, command: string): void {
    if (!this.isGated(command)) return;
    this.directPermits.set(toolCallId, normalizeForLeaseMatch(command));
  }

  authorizeDispatch(event: {
    toolName: string;
    toolCallId: string;
    origin: BashDispatchOrigin;
    input: unknown;
  }): BashDispatchPermission {
    if (event.toolName !== 'tools__bash' || this.gatedPatterns.length === 0) return {};
    const command = event.input && typeof event.input === 'object'
      && typeof (event.input as { command?: unknown }).command === 'string'
      ? (event.input as { command: string }).command
      : '';
    if (!command || !this.isGated(command)) return {};

    if (event.origin === 'direct') {
      const permit = this.directPermits.get(event.toolCallId);
      this.directPermits.delete(event.toolCallId);
      if (permit === normalizeForLeaseMatch(command)) return {};
    }

    return {
      block: true,
      reason: event.origin === 'code-mode'
        ? 'APPROVAL_REQUIRED: This Bash command matches tools.bash.gated and cannot run inside Code Mode. Request human approval and issue the exact command through the direct tools__bash call.'
        : 'APPROVAL_REQUIRED: This Bash command matches tools.bash.gated but has no approved one-shot execution permit. Request human approval before running it.',
    };
  }
}

/**
 * Whether a command is covered by a lease. Authorization is an exact match
 * against a complete command shown in `changes[]`; payload-only entries grant
 * nothing. Binding the lease to the whole action prevents approved text from
 * being replayed as an unused argument to an unrelated gated command.
 */
export function commandCoveredByLease(command: string, lease: ApprovalLease | undefined): boolean {
  if (!lease || lease.entries.length === 0) return false;
  const normalizedCommand = normalizeForLeaseMatch(command);
  return lease.entries.some((entry) => {
    const normalizedContent = normalizeForLeaseMatch(entry.content);
    return entry.consumedAt === undefined
      && normalizedContent.length > 0
      && normalizedCommand === normalizedContent;
  });
}

export type LeaseConsumptionResult =
  | 'approved'
  | 'already-used'
  | 'not-covered'
  | 'persistence-error';

/**
 * Per-session lease persistence. File-based (in the session directory, next to
 * the effect WAL) so a lease granted at resume time in one process is visible
 * to the resumed run in another. The grant is scoped to that resumed execution
 * segment and is revoked when the segment ends; it must never authorize a later
 * user continuation.
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

  grant(lease: ApprovalLease): boolean {
    return this.write(lease);
  }

  private write(lease: ApprovalLease): boolean {
    const filePath = this.filePath;
    if (!filePath) {
      logger.debug('[Lease] grant dropped: no session dir bound');
      return false;
    }
    try {
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, JSON.stringify(lease, null, 2));
      return true;
    } catch (error) {
      logger.debug(`[Lease] grant failed: ${(error as Error).message}`);
      return false;
    }
  }

  revoke(): boolean {
    const filePath = this.filePath;
    if (!filePath) return false;
    try {
      fs.rmSync(filePath, { force: true });
      return true;
    } catch (error) {
      logger.debug(`[Lease] revoke failed: ${(error as Error).message}`);
      return false;
    }
  }

  isCovered(command: string): boolean {
    return commandCoveredByLease(command, this.read());
  }

  /**
   * Burn exactly one matching unused entry before command dispatch. Duplicate
   * entries are intentional execution counts: two identical entries authorize
   * two executions, and the third attempt returns `already-used`.
   */
  consume(command: string, now = Date.now()): LeaseConsumptionResult {
    const lease = this.read();
    if (!lease) return 'not-covered';
    const normalizedCommand = normalizeForLeaseMatch(command);
    const matching = lease.entries
      .map((entry, index) => ({ entry, index }))
      .filter(({ entry }) => (
        normalizeForLeaseMatch(entry.content).length > 0
        && normalizeForLeaseMatch(entry.content) === normalizedCommand
      ));
    const available = matching.find(({ entry }) => entry.consumedAt === undefined);
    if (!available) return matching.length > 0 ? 'already-used' : 'not-covered';

    lease.entries[available.index] = { ...available.entry, consumedAt: now };
    return this.write(lease) ? 'approved' : 'persistence-error';
  }
}
