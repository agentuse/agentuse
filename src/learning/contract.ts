import { createHash } from 'crypto';
import { LEARNED_BLOCK_END, LEARNED_BLOCK_START } from './graduate';

/**
 * The agent's effective contract, split into the author's own instructions and
 * the machine-managed graduated block.
 *
 * One implementation for the two places that need the split: the capture
 * evaluator (which shows the permanent rules in full, separately from the
 * body) and the instruction hash below.
 */
export function splitInstructions(instructions: string): { body: string; permanentText: string } {
  const blockStart = instructions.indexOf(LEARNED_BLOCK_START);
  const blockEnd = instructions.indexOf(LEARNED_BLOCK_END);
  const hasBlock = blockStart !== -1 && blockEnd > blockStart;
  const permanentText = hasBlock
    ? instructions.slice(blockStart + LEARNED_BLOCK_START.length, blockEnd).trim()
    : '';
  const body = hasBlock
    ? `${instructions.slice(0, blockStart)}${instructions.slice(blockEnd + LEARNED_BLOCK_END.length)}`
    : instructions;
  return { body, permanentText };
}

/**
 * Hash of the contract a learning is captured — and vetted — against.
 *
 * Covers the complete effective contract, including permanent learned rules.
 * Tidy explicitly re-stamps staged rules when it changes that managed block;
 * any other edit therefore means a human changed the contract and must trigger
 * re-vetting rather than silently leaving conflicting rules fresh.
 *
 * Truncated sha256: this is a change detector, not a security boundary, and a
 * 12-hex token keeps the metadata line readable in the corrections file.
 */
export function hashInstructions(instructions: string): string {
  const { body, permanentText } = splitInstructions(instructions);
  return createHash('sha256')
    .update(`${body.trim()}\n${permanentText}`)
    .digest('hex')
    .slice(0, 12);
}

/** Active entries whose recorded contract differs from the current one. Absent
 *  hashes are NOT stale: they are legacy entries that predate provenance and
 *  stay injectable until the first capture or tidy backfills them. */
export function isStaleAgainst(currentHash: string, instructionsHash: string | undefined): boolean {
  return instructionsHash !== undefined && instructionsHash !== currentHash;
}
