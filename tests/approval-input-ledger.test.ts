import { afterEach, describe, expect, test } from 'bun:test';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { mkdtemp, rm } from 'fs/promises';
import {
  APPROVAL_INPUT_LEDGER_DIR,
  APPROVAL_INPUT_MAX_AGE_MS,
  APPROVAL_INPUT_MAX_VALUE_BYTES,
  APPROVAL_INPUT_RUNTIME_CONTRACT,
  ApprovalInputLedger,
  ApprovalInputLedgerError,
  DuplicateApprovalInputLedgerError,
  approvalInputDigest,
} from '../src/runner/approval-input-ledger';
import { sanitizeWALInput } from '../src/runner/effect-wal';
import { completeApprovalValueDisplay } from '../src/utils/approval-value';

describe('approval canonical-input ledger', () => {
  let root: string | undefined;

  afterEach(async () => {
    if (root) await rm(root, { recursive: true, force: true });
    root = undefined;
  });

  async function fixture(session = 'session-a', agent = 'agent-a') {
    root ??= await mkdtemp(path.join(os.tmpdir(), 'approval-input-ledger-'));
    return new ApprovalInputLedger(session, agent, root);
  }

  test('restores Date and Map values exactly once', async () => {
    const ledger = await fixture();
    const canonical = {
      at: new Date('2026-09-12T00:00:00.000Z'),
      values: new Map([['answer', 42]]),
    };
    ledger.store('publish', 'call-1', { draft: 'raw' }, canonical);

    const restored = ledger.consume('publish', 'call-1', { draft: 'raw' }) as typeof canonical;
    expect(restored.at).toBeInstanceOf(Date);
    expect(restored.at.toISOString()).toBe(canonical.at.toISOString());
    expect(restored.values).toBeInstanceOf(Map);
    expect(restored.values.get('answer')).toBe(42);
    expect(() => ledger.consume('publish', 'call-1', { draft: 'raw' })).toThrow(ApprovalInputLedgerError);
  });

  test('fails closed for missing, mismatched, stale, corrupt and oversized records', async () => {
    const ledger = await fixture();
    expect(() => ledger.consume('publish', 'missing', { draft: 'raw' })).toThrow('no matching');

    ledger.store('publish', 'mismatch', { draft: 'raw' }, { ready: true });
    expect(() => ledger.consume('publish', 'mismatch', { draft: 'changed' })).toThrow('does not match');

    ledger.store(
      'publish',
      'stale',
      { draft: 'raw' },
      { ready: true },
      Date.now() - APPROVAL_INPUT_MAX_AGE_MS - 1,
    );
    expect(() => ledger.consume('publish', 'stale', { draft: 'raw' })).toThrow('stale');

    ledger.store('publish', 'corrupt', { draft: 'raw' }, { ready: true });
    const directory = path.join(root!, APPROVAL_INPUT_LEDGER_DIR);
    const record = fs.readdirSync(directory).find(name => name.endsWith('.json'))!;
    fs.writeFileSync(path.join(directory, record), '{broken');
    expect(() => ledger.consume('publish', 'corrupt', { draft: 'raw' })).toThrow('corrupt');

    expect(() => ledger.store(
      'publish',
      'large',
      { draft: 'raw' },
      'x'.repeat(APPROVAL_INPUT_MAX_VALUE_BYTES + 1),
    )).toThrow('exceeds');
  });

  test('rejects unsupported class values and prevents cross-session or cross-tool reuse', async () => {
    class CustomInput {
      value = 'private';
    }
    const ledger = await fixture();
    expect(() => ledger.store('publish', 'custom', { draft: 'raw' }, new CustomInput())).toThrow('unsupported class');

    ledger.store('publish', 'call-1', { draft: 'raw' }, { ready: true });
    expect(() => ledger.consume('delete', 'call-1', { draft: 'raw' })).toThrow('no matching');
    const otherSession = new ApprovalInputLedger('session-b', 'agent-a', root);
    expect(() => otherSession.consume('publish', 'call-1', { draft: 'raw' })).toThrow('no matching');
    expect((ledger.consume('publish', 'call-1', { draft: 'raw' }) as any).ready).toBe(true);
  });

  test('removes abandoned stale records during bounded session startup cleanup', async () => {
    const ledger = await fixture();
    ledger.store('publish', 'abandoned', { draft: 'raw' }, { ready: true });
    const directory = path.join(root!, APPROVAL_INPUT_LEDGER_DIR);
    const file = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json'))!);
    const staleTime = new Date(Date.now() - APPROVAL_INPUT_MAX_AGE_MS - 1000);
    fs.utimesSync(file, staleTime, staleTime);

    new ApprovalInputLedger('session-a', 'agent-a', root);

    expect(fs.existsSync(file)).toBe(false);
  });

  test('rejects a symlinked or group-readable approval-input directory', async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'approval-input-ledger-'));
    const directory = path.join(root, APPROVAL_INPUT_LEDGER_DIR);
    const target = path.join(root, 'redirected-ledger');
    fs.mkdirSync(target, { mode: 0o700 });
    fs.symlinkSync(target, directory);
    expect(() => new ApprovalInputLedger('session-a', 'agent-a', root)).toThrow('not a real directory');

    fs.unlinkSync(directory);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chmodSync(directory, 0o755);
    expect(() => new ApprovalInputLedger('session-a', 'agent-a', root)).toThrow('group or world permissions');
  });

  test('rejects a foreign-owned approval-input directory when ownership can be tested', async () => {
    // Non-root processes cannot safely create a foreign-owned fixture. Skip on
    // platforms without POSIX ownership rather than turning this into a
    // platform-specific failure.
    if (typeof process.getuid !== 'function' || process.getuid() !== 0) return;
    root = await mkdtemp(path.join(os.tmpdir(), 'approval-input-ledger-'));
    const directory = path.join(root, APPROVAL_INPUT_LEDGER_DIR);
    fs.mkdirSync(directory, { mode: 0o700 });
    fs.chownSync(directory, 1, 1);
    expect(() => new ApprovalInputLedger('session-a', 'agent-a', root)).toThrow('owned by another user');
  });

  test('rejects raw arrays with metadata the JSON digest cannot represent', () => {
    const hole = ['first', , 'third'];
    const accessor = ['first'];
    Object.defineProperty(accessor, '0', { get: () => 'hidden', enumerable: true });
    const property = ['first'];
    Object.defineProperty(property, 'reviewed', { value: true, enumerable: false });
    const symbol = ['first'];
    Object.defineProperty(symbol, Symbol('reviewed'), { value: true });

    for (const input of [hole, accessor, property, symbol]) {
      expect(() => approvalInputDigest(input)).toThrow(ApprovalInputLedgerError);
    }
  });

  test('renders approval values without invoking accessors or unsupported built-in subclasses', () => {
    let invoked = 0;
    const fail = (): never => {
      invoked++;
      throw new Error('hostile approval accessor ran');
    };

    const accessorArray = ['first'];
    Object.defineProperty(accessorArray, '0', { get: fail, enumerable: true, configurable: true });

    class HostileDate extends Date {
      override getTime(): number { return fail(); }
    }
    class HostileMap extends Map<unknown, unknown> {
      override [Symbol.iterator](): MapIterator<[unknown, unknown]> { return fail(); }
    }
    class HostileSet extends Set<unknown> {
      override [Symbol.iterator](): SetIterator<unknown> { return fail(); }
    }
    class HostileRegExp extends RegExp {
      override get source(): string { return fail(); }
    }
    class HostileView extends Uint8Array {
      override get byteOffset(): number { return fail(); }
    }

    const dateWithProperty = new Date(0);
    Object.defineProperty(dateWithProperty, 'secret', { get: fail, enumerable: true });

    for (const input of [
      accessorArray,
      new HostileDate(0),
      new HostileMap([['key', 'value']]),
      new HostileSet(['value']),
      new HostileRegExp('value', 'g'),
      new HostileView([1, 2, 3]),
      dateWithProperty,
    ]) {
      expect(() => completeApprovalValueDisplay(input)).toThrow();
    }
    expect(invoked).toBe(0);
  });

  test('never overwrites a duplicate call identity and rejects incompatible runtime contracts', async () => {
    const ledger = await fixture();
    const raw = { draft: 'raw' };
    ledger.store('publish', 'duplicate', raw, { sequence: 1 });
    expect(() => ledger.store('publish', 'duplicate', raw, { sequence: 2 }))
      .toThrow(DuplicateApprovalInputLedgerError);
    expect(ledger.consume('publish', 'duplicate', raw)).toEqual({ sequence: 1 });

    ledger.store('publish', 'contract', raw, { ready: true });
    const directory = path.join(root!, APPROVAL_INPUT_LEDGER_DIR);
    const file = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.json'))!);
    const record = JSON.parse(fs.readFileSync(file, 'utf8'));
    expect(record.runtimeContract).toBe(APPROVAL_INPUT_RUNTIME_CONTRACT);
    record.runtimeContract = '0.0.0:approval-input-ledger:0';
    fs.writeFileSync(file, JSON.stringify(record));
    expect(() => ledger.consume('publish', 'contract', raw)).toThrow('incompatible runtime contract');
  });

  test('binds a restored value to its tool approval contract', async () => {
    const ledger = await fixture();
    ledger.store('publish', 'contract-version', { draft: 'raw' }, new Date(0), Date.now(), 'publish:v1');
    expect(() => ledger.consume('publish', 'contract-version', { draft: 'raw' }, Date.now(), 'publish:v2'))
      .toThrow('incompatible tool contract');
  });

  test('keeps an identity unavailable after consume so a fresh approval cannot race the active effect', async () => {
    const ledger = await fixture();
    const raw = { draft: 'one' };
    ledger.store('publish', 'consume-race', raw, { canonical: 1 });
    // Consuming atomically claims the same lock fresh callers use and leaves a
    // durable tombstone after the pending JSON is removed.
    expect(ledger.consume('publish', 'consume-race', raw)).toEqual({ canonical: 1 });
    expect(() => ledger.reserve('publish', 'consume-race')).toThrow(DuplicateApprovalInputLedgerError);
    const directory = path.join(root!, APPROVAL_INPUT_LEDGER_DIR);
    expect(fs.readdirSync(directory).some(name => name.endsWith('.consumed'))).toBe(true);
  });

  test('releases the consume lock when no pending record exists', async () => {
    const ledger = await fixture();
    expect(() => ledger.consume('publish', 'missing-lock', { draft: 'none' })).toThrow('no matching canonical input');
    const reservation = ledger.reserve('publish', 'missing-lock');
    ledger.release(reservation);
  });

  test('does not expire an aged consumed tombstone during cleanup', async () => {
    const ledger = await fixture();
    const raw = { draft: 'aged' };
    ledger.store('publish', 'aged-tombstone', raw, { canonical: true });
    ledger.consume('publish', 'aged-tombstone', raw);
    const directory = path.join(root!, APPROVAL_INPUT_LEDGER_DIR);
    const tombstone = path.join(directory, fs.readdirSync(directory).find(name => name.endsWith('.consumed'))!);
    const old = new Date(Date.now() - APPROVAL_INPUT_MAX_AGE_MS - 1_000);
    fs.utimesSync(tombstone, old, old);
    new ApprovalInputLedger('session-a', 'agent-a', root!);
    expect(() => ledger.reserve('publish', 'aged-tombstone')).toThrow(DuplicateApprovalInputLedgerError);
  });

  test('invalidates a rejected approval by scoped identity and leaves no record or lock', async () => {
    const ledger = await fixture();
    ledger.store('publish', 'rejected-call', { signed: 'provider bytes' }, { canonical: true });

    ledger.invalidate('publish', 'rejected-call');

    const directory = path.join(root!, APPROVAL_INPUT_LEDGER_DIR);
    const names = fs.readdirSync(directory);
    expect(names.filter(name => name.endsWith('.json') || name.endsWith('.lock'))).toHaveLength(0);
    expect(names.filter(name => name.endsWith('.consumed'))).toHaveLength(1);
    expect(() => ledger.reserve('publish', 'rejected-call')).toThrow(DuplicateApprovalInputLedgerError);
    expect(() => ledger.consume('publish', 'rejected-call', { signed: 'provider bytes' })).toThrow('already consumed');
  });

  test('rejects raw and canonical descriptor shapes that cannot round-trip', async () => {
    const hiddenObject: any = { title: 'x' };
    Object.defineProperty(hiddenObject, 'hidden', { value: 1, enumerable: false, writable: true, configurable: true });
    const hiddenArray: any[] = ['x'];
    Object.defineProperty(hiddenArray, '0', { value: 'x', enumerable: false, writable: true, configurable: true });
    expect(() => approvalInputDigest(hiddenObject)).toThrow(ApprovalInputLedgerError);
    expect(() => approvalInputDigest(hiddenArray)).toThrow(ApprovalInputLedgerError);
    const ledger = await fixture();
    const frozen = Object.freeze({ title: 'x' });
    const nullPrototype = Object.assign(Object.create(null), { title: 'x' });
    expect(() => ledger.store('publish', 'frozen', { title: 'x' }, frozen)).toThrow(ApprovalInputLedgerError);
    expect(() => ledger.store('publish', 'null-prototype', { title: 'x' }, nullPrototype)).toThrow(ApprovalInputLedgerError);
  });

  test('rejects built-in subclasses and custom properties that V8 cannot restore faithfully', async () => {
    const ledger = await fixture();
    class CustomDate extends Date {}
    const date = new Date(); Object.defineProperty(date, 'hidden', { value: 1 });
    const map = new Map([['x', 1]]); Object.defineProperty(map, 'hidden', { value: 1 });
    const set = new Set([1]); Object.defineProperty(set, 'hidden', { value: 1 });
    const bytes = new Uint8Array([1]); Object.defineProperty(bytes, 'hidden', { value: 1 });
    for (const [id, value] of [['date-subclass', new CustomDate()], ['date-property', date], ['map-property', map], ['set-property', set], ['view-property', bytes]] as const) {
      expect(() => ledger.store('publish', id, { id }, value)).toThrow(ApprovalInputLedgerError);
    }
    // Ordinary supported built-ins remain valid.
    expect(() => ledger.store('publish', 'ordinary-map', { id: 'ok' }, new Map([['x', 1]]))).not.toThrow();
  });

  test('rejects typed-array and Array subclasses plus noncanonical keys and RegExp state', async () => {
    const ledger = await fixture();
    class CustomBytes extends Uint8Array {}
    class CustomArray extends Array {}
    const symbolBytes = new Uint8Array([1]); Object.defineProperty(symbolBytes, Symbol('x'), { value: 1 });
    const leadingZeroBytes = new Uint8Array([1]); Object.defineProperty(leadingZeroBytes, '01', { value: 1 });
    const advanced = /x/g; advanced.lastIndex = 1;
    const cases: Array<[string, unknown]> = [
      ['view-subclass', new CustomBytes([1])], ['array-subclass', new CustomArray(1)],
      ['view-symbol', symbolBytes], ['view-leading-zero', leadingZeroBytes], ['regexp-state', advanced],
      ['frozen-array', Object.freeze([])],
    ];
    for (const [id, value] of cases) {
      expect(() => ledger.store('publish', id, { id }, value)).toThrow(ApprovalInputLedgerError);
    }
  });

  test('makes canonical special values bounded and JSON-safe for audit records', () => {
    const cyclic: any = { count: 1n, values: new Set([2]) };
    cyclic.self = cyclic;
    const audit = sanitizeWALInput({
      cyclic,
      map: new Map([['at', new Date(0)]]),
      bytes: new Uint8Array([1, 2]),
    });
    expect(() => JSON.stringify(audit)).not.toThrow();
    expect(audit).toMatchObject({
      cyclic: { count: { __type: 'BigInt', value: '1' } },
      map: { __type: 'Map' },
      bytes: { __type: 'Uint8Array' },
    });
  });
});
