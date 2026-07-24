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
 * Parse one shell command into argument values without executing or expanding
 * it. Any unquoted shell control operator marks the command as compound. Lease
 * payloads may match a complete argv value, never an arbitrary substring.
 */
function shellArguments(command: string): { args: string[]; compound: boolean } {
  const args: string[] = [];
  let current = '';
  let quote: "'" | '"' | null = null;
  let escaped = false;
  let compound = false;

  const push = () => {
    if (current.length > 0) args.push(current);
    current = '';
  };

  for (let i = 0; i < command.length; i++) {
    const char = command[i]!;
    if (escaped) {
      current += char;
      escaped = false;
      continue;
    }
    if (char === '\\' && quote !== "'") {
      escaped = true;
      continue;
    }
    if (quote) {
      if (char === quote) quote = null;
      else {
        // Double quotes still execute command substitutions. Single quotes do
        // not. Mark these as compound before treating the bytes as one argv
        // value, otherwise a separate effect can hide beside an approved arg.
        if (
          quote === '"'
          && (char === '`' || (char === '$' && command[i + 1] === '('))
        ) {
          compound = true;
        }
        current += char;
      }
      continue;
    }
    if (char === "'" || char === '"') {
      quote = char;
      continue;
    }
    if (/\s/.test(char)) {
      push();
      if (char === '\n' || char === '\r') compound = true;
      continue;
    }
    if (';&|<>`'.includes(char) || (char === '$' && command[i + 1] === '(')) {
      compound = true;
    }
    current += char;
  }
  if (escaped) current += '\\';
  push();
  if (quote) compound = true;
  return { args, compound };
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
 * Whether a command is covered by a lease: the normalized command equals the
 * full approved entry, or one complete shell argument equals an approved
 * payload. Arbitrary substring containment is intentionally forbidden: it let
 * `approved-effect ; unapproved-effect` inherit the first effect's grant.
 */
export function commandCoveredByLease(command: string, lease: ApprovalLease | undefined): boolean {
  if (!lease || lease.entries.length === 0) return false;
  const normalizedCommand = normalizeForLeaseMatch(command);
  const parsed = shellArguments(command);
  return lease.entries.some((entry) => {
    const normalizedContent = normalizeForLeaseMatch(entry.content);
    if (!normalizedContent) return false;
    if (normalizedCommand === normalizedContent) return true;
    if (parsed.compound) return false;
    return parsed.args.some((argument) =>
      normalizeForLeaseMatch(argument) === normalizedContent
    );
  });
}

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
