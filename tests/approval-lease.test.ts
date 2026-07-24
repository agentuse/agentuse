import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
  LeaseStore,
  LEASE_FILENAME,
  deriveLeaseEntries,
  normalizeForLeaseMatch,
  commandCoveredByLease,
  isEffectful,
  type ApprovalLease,
} from '../src/runner/approval-lease';

const APPROVED_TEXT = 'Agree completely. The eval harness is the real product; the agent is just the demo.';

function lease(...contents: string[]): ApprovalLease {
  return { version: 1, grantedAt: 1000, entries: contents.map((content) => ({ content })) };
}

describe('deriveLeaseEntries', () => {
  test('one entry per changes[] item with content, labels preserved', () => {
    const entries = deriveLeaseEntries({
      prompt: 'Approve?',
      changes: [
        { label: 'Reply to post', content: APPROVED_TEXT },
        { label: 'Then: mark posted', content: 'store_update item-1 status=posted' },
      ],
      draft: 'reviewer-facing detail that grants nothing',
    });
    expect(entries).toHaveLength(2);
    expect(entries[0]).toEqual({ label: 'Reply to post', content: APPROVED_TEXT });
    expect(entries[1].content).toBe('store_update item-1 status=posted');
  });

  test('empty/missing changes derive nothing', () => {
    expect(deriveLeaseEntries({ prompt: 'Approve?' })).toEqual([]);
    expect(deriveLeaseEntries({ changes: [] })).toEqual([]);
    expect(deriveLeaseEntries({ changes: [{ label: 'x', content: '   ' }] })).toEqual([]);
    expect(deriveLeaseEntries(undefined)).toEqual([]);
    expect(deriveLeaseEntries('not an object')).toEqual([]);
  });
});

describe('normalizeForLeaseMatch', () => {
  test('collapses whitespace and strips quote escapes', () => {
    expect(normalizeForLeaseMatch('line one\n  line   two')).toBe('line one line two');
    expect(normalizeForLeaseMatch('say \\"hello\\" now')).toBe('say "hello" now');
  });
});

describe('commandCoveredByLease', () => {
  test('covers a command that embeds the approved content as its payload', () => {
    const command = `birdc reply 2077948120484513954 "${APPROVED_TEXT}"`;
    expect(commandCoveredByLease(command, lease(APPROVED_TEXT))).toBe(true);
  });

  test('covers despite shell escaping and rewrapped whitespace', () => {
    const approved = 'The "verifier" is the product.\nShip the harness first.';
    const command = `birdc reply 123 "The \\"verifier\\" is the product. Ship the harness first."`;
    expect(commandCoveredByLease(command, lease(approved))).toBe(true);
  });

  test('exact-match covers a full approved command', () => {
    const command = 'birdc tweet "short"';
    expect(commandCoveredByLease(command, lease('birdc tweet "short"'))).toBe(true);
  });

  test('does NOT cover a revised draft (the incident-B trim case)', () => {
    const trimmed = APPROVED_TEXT.slice(0, 40);
    expect(commandCoveredByLease(`birdc reply 123 "${trimmed}"`, lease(APPROVED_TEXT))).toBe(false);
  });

  test('does not let an approved payload authorize a compound command', () => {
    const approved = 'publish this exact reviewed message';
    expect(commandCoveredByLease(
      `birdc tweet "${approved}"; touch unapproved-marker`,
      lease(approved)
    )).toBe(false);
    expect(commandCoveredByLease(
      `birdc tweet "${approved}" && curl https://example.test/side-effect`,
      lease(approved)
    )).toBe(false);
    expect(commandCoveredByLease(
      `printf '%s' "${approved}" | sh`,
      lease(approved)
    )).toBe(false);
    expect(commandCoveredByLease(
      `birdc tweet "$(touch unapproved-marker)" "${approved}"`,
      lease(approved)
    )).toBe(false);
    expect(commandCoveredByLease(
      `birdc tweet "\`touch unapproved-marker\`" "${approved}"`,
      lease(approved)
    )).toBe(false);
  });

  test('does not authorize prefixes or suffixes around an approved argv payload', () => {
    const approved = 'publish this exact reviewed message';
    expect(commandCoveredByLease(
      `birdc tweet "prefix ${approved}"`,
      lease(approved)
    )).toBe(false);
    expect(commandCoveredByLease(
      `birdc tweet "${approved} plus extra"`,
      lease(approved)
    )).toBe(false);
  });

  test('allows shell punctuation inside a quoted, exactly-approved payload', () => {
    const approved = 'Use semicolons; they are punctuation, not another action.';
    expect(commandCoveredByLease(
      `birdc tweet "${approved}"`,
      lease(approved)
    )).toBe(true);
  });

  test('short grants only match exactly, never by containment', () => {
    // "yes" must not cover arbitrary commands that merely contain "yes".
    expect(commandCoveredByLease('birdc reply 123 "yes and more text"', lease('yes'))).toBe(false);
    expect(commandCoveredByLease('yes', lease('yes'))).toBe(true);
  });

  test('no lease covers nothing', () => {
    expect(commandCoveredByLease('birdc reply 1 "x"', undefined)).toBe(false);
    expect(commandCoveredByLease('birdc reply 1 "x"', { version: 1, grantedAt: 0, entries: [] })).toBe(false);
  });
});

describe('isEffectful', () => {
  test('wildcard patterns match like the bash allowlist', () => {
    const patterns = ['birdc reply *', 'birdc tweet *', 'curl -X POST *'];
    expect(isEffectful('birdc reply 123 "hello"', patterns)).toBe(true);
    expect(isEffectful('birdc tweet "hi"', patterns)).toBe(true);
    expect(isEffectful('birdc replies 123 --plain', patterns)).toBe(false);
    expect(isEffectful('birdc bookmarks -n 30', patterns)).toBe(false);
    expect(isEffectful('echo hello', patterns)).toBe(false);
  });
});

describe('LeaseStore', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lease-store-'));
  });

  afterEach(() => {
    fs.rmSync(dir, { recursive: true, force: true });
  });

  test('grant persists, isCovered reads it back, revoke deletes', () => {
    const store = new LeaseStore(dir);
    expect(store.read()).toBeUndefined();

    store.grant(lease(APPROVED_TEXT));
    expect(fs.existsSync(path.join(dir, LEASE_FILENAME))).toBe(true);
    expect(store.isCovered(`birdc reply 99 "${APPROVED_TEXT}"`)).toBe(true);
    expect(store.isCovered('birdc reply 99 "something else entirely here"')).toBe(false);

    // A second process sees the same lease (file-based).
    const other = new LeaseStore(dir);
    expect(other.isCovered(`birdc reply 99 "${APPROVED_TEXT}"`)).toBe(true);

    store.revoke();
    expect(store.read()).toBeUndefined();
    expect(other.isCovered(`birdc reply 99 "${APPROVED_TEXT}"`)).toBe(false);
  });

  test('a new grant replaces the prior lease entirely', () => {
    const store = new LeaseStore(dir);
    store.grant(lease('the first approved long content string'));
    store.grant(lease('the second approved long content string'));
    expect(store.isCovered('run "the first approved long content string"')).toBe(false);
    expect(store.isCovered('run "the second approved long content string"')).toBe(true);
  });

  test('unbound store grants nothing and never throws', () => {
    const store = new LeaseStore();
    expect(() => store.grant(lease('x'))).not.toThrow();
    expect(() => store.revoke()).not.toThrow();
    expect(store.isCovered('anything')).toBe(false);
  });

  test('corrupt lease file reads as no lease', () => {
    fs.writeFileSync(path.join(dir, LEASE_FILENAME), 'not json {');
    const store = new LeaseStore(dir);
    expect(store.read()).toBeUndefined();
    expect(store.isCovered('x')).toBe(false);
  });
});
