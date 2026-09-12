import * as fs from 'fs';
import * as path from 'path';
import { createHash, randomUUID } from 'crypto';
import { deserialize, serialize } from 'v8';
import { version as packageVersion } from '../../package.json';

/**
 * Durable canonical inputs for AI SDK needsApproval calls.
 *
 * The SDK deliberately keeps the provider's JSON input in approval history so
 * its optional approval signature remains stable. Schema transforms can produce
 * a different runtime value, however, and approved history is executed in a new
 * streamText invocation. This ledger carries that one trusted transformed value
 * across the process boundary without changing the signed history.
 */
export const APPROVAL_INPUT_LEDGER_DIR = 'approval-inputs';
export const APPROVAL_INPUT_MAX_RAW_BYTES = 256 * 1024;
export const APPROVAL_INPUT_MAX_VALUE_BYTES = 512 * 1024;
export const APPROVAL_INPUT_MAX_RECORD_BYTES = 768 * 1024;
export const APPROVAL_INPUT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
export const APPROVAL_INPUT_CLEANUP_MAX_FILES = 64;
/** Increment this whenever a change can alter how a restored canonical value
 * is interpreted, even if the package version is unchanged in development. */
export const APPROVAL_INPUT_CONTRACT_REVISION = 1;
export const APPROVAL_INPUT_RUNTIME_CONTRACT = `${packageVersion}:approval-input-ledger:${APPROVAL_INPUT_CONTRACT_REVISION}`;

type ApprovalInputRecord = {
  version: 3;
  createdAt: number;
  runtimeContract: string;
  sessionId: string;
  agentId: string;
  toolName: string;
  toolCallId: string;
  rawDigest: string;
  toolContract: string;
  value: string;
};

export class ApprovalInputLedgerError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ApprovalInputLedgerError';
  }
}

/** A record already exists for this exact session/agent/tool/call identity.
 * The original persisted input remains authoritative and must not be removed. */
export class DuplicateApprovalInputLedgerError extends ApprovalInputLedgerError {
  constructor() {
    super('Approval input restoration failed: canonical input is already persisted for this tool call');
    this.name = 'DuplicateApprovalInputLedgerError';
  }
}

export type ApprovalInputReservation = { readonly path: string; readonly token: string };

export function isDuplicateApprovalInputLedgerError(error: unknown): error is DuplicateApprovalInputLedgerError {
  return error instanceof DuplicateApprovalInputLedgerError;
}

function fail(message: string): never {
  throw new ApprovalInputLedgerError(`Approval input restoration failed: ${message}`);
}

function stableJson(value: unknown, ancestors = new Set<object>()): string {
  if (value === null) return 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) fail('provider input contains a non-finite number');
    return Object.is(value, -0) ? '0' : String(value);
  }
  if (typeof value !== 'object') fail(`provider input contains unsupported ${typeof value}`);
  if (ancestors.has(value)) fail('provider input contains a cycle');
  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      // JSON arrays have no hidden state: they are ordinary, dense arrays with
      // data properties for every index and no extra string or symbol keys.
      // `Array#map` would skip holes and ignores non-index own properties,
      // which would allow a schema transform to observe bytes the digest misses.
      if (Object.getPrototypeOf(value) !== Array.prototype) {
        fail('provider input is not an ordinary JSON array');
      }
      if (Object.getOwnPropertySymbols(value).length > 0) {
        fail('provider input contains symbol keys');
      }
      const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(value);
      const length = value.length;
      const lengthDescriptor = descriptors['length'];
      if (
        !Number.isSafeInteger(length)
        || length < 0
        || !lengthDescriptor
        || !('value' in lengthDescriptor)
        || lengthDescriptor.value !== length
      ) fail('provider input contains an invalid array length');
      for (const [key, descriptor] of Object.entries(descriptors)) {
        if (key === 'length') continue;
        const index = Number(key);
        if (
          !Number.isInteger(index)
          || index < 0
          || index >= length
          || String(index) !== key
          || !('value' in descriptor)
        ) fail('provider input contains non-index array properties');
      }
      const entries: string[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor) fail('provider input contains an array hole');
        if (!('value' in descriptor)) fail('provider input contains an accessor property');
        if (!descriptor.enumerable || !descriptor.writable || !descriptor.configurable) {
          fail('provider input contains a nonordinary array descriptor');
        }
        if (descriptor.value === undefined) fail('provider input contains undefined');
        entries.push(stableJson(descriptor.value, ancestors));
      }
      return `[${entries.join(',')}]`;
    }
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype) {
      fail('provider input is not a plain JSON object');
    }
    if (Object.getOwnPropertySymbols(value).length > 0) fail('provider input contains symbol keys');
    const descriptors = Object.getOwnPropertyDescriptors(value);
    return `{${Object.keys(descriptors).sort().map(key => {
      const descriptor = descriptors[key]!;
      if (!('value' in descriptor)) fail('provider input contains an accessor property');
      if (!descriptor.enumerable || !descriptor.writable || !descriptor.configurable) {
        fail('provider input contains a nonordinary object descriptor');
      }
      if (descriptor.value === undefined) fail('provider input contains undefined');
      return `${JSON.stringify(key)}:${stableJson(descriptor.value, ancestors)}`;
    }).join(',')}}`;
  } finally {
    ancestors.delete(value);
  }
}

export function approvalInputDigest(value: unknown): string {
  const canonical = stableJson(value);
  if (Buffer.byteLength(canonical) > APPROVAL_INPUT_MAX_RAW_BYTES) {
    fail(`provider input exceeds ${APPROVAL_INPUT_MAX_RAW_BYTES} bytes`);
  }
  return createHash('sha256').update(canonical).digest('hex');
}

/** Reject values whose identity or behavior v8 serialization cannot safely
 * restore. Date, Map, Set, RegExp, ArrayBuffer and typed arrays are supported;
 * application class instances and executable/accessor values fail explicitly. */
function assertSerializableCanonical(value: unknown, seen = new Set<object>()): void {
  if (
    value === null
    || ['string', 'boolean', 'number', 'bigint', 'undefined'].includes(typeof value)
  ) return;
  if (typeof value === 'function' || typeof value === 'symbol') {
    fail(`canonical input contains unsupported ${typeof value}`);
  }
  if (typeof value !== 'object' || seen.has(value)) return;
  seen.add(value);

  if (value instanceof WeakMap || value instanceof WeakSet || value instanceof Promise) {
    fail(`canonical input contains unsupported ${value.constructor.name}`);
  }
  const assertExactBuiltin = (expected: object, name: string) => {
    if (Object.getPrototypeOf(value) !== expected || Reflect.ownKeys(value).length > 0) {
      fail(`canonical input contains nonordinary ${name}`);
    }
  };
  if (value instanceof Date) { assertExactBuiltin(Date.prototype, 'Date'); return; }
  if (value instanceof RegExp) {
    if (Object.getPrototypeOf(value) !== RegExp.prototype) fail('canonical input contains nonordinary RegExp');
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== 'lastIndex') fail('canonical input contains RegExp properties');
    const descriptor = Object.getOwnPropertyDescriptor(value, 'lastIndex');
    if (!descriptor || descriptor.enumerable || descriptor.configurable || descriptor.writable !== true || descriptor.value !== 0) fail('canonical input contains nonordinary RegExp');
    return;
  }
  if (value instanceof ArrayBuffer) { assertExactBuiltin(ArrayBuffer.prototype, 'ArrayBuffer'); return; }
  if (ArrayBuffer.isView(value)) {
    // Typed arrays/DataView are supported only in their ordinary built-in form;
    // V8 does not preserve subclass identity or arbitrary own properties.
    const allowed = new Set<object>([
      Int8Array.prototype, Uint8Array.prototype, Uint8ClampedArray.prototype,
      Int16Array.prototype, Uint16Array.prototype, Int32Array.prototype, Uint32Array.prototype,
      Float32Array.prototype, Float64Array.prototype, BigInt64Array.prototype, BigUint64Array.prototype,
      DataView.prototype, Buffer.prototype,
    ]);
    if (!allowed.has(Object.getPrototypeOf(value))) fail('canonical input contains nonordinary typed array');
    const length = ArrayBuffer.isView(value) && !(value instanceof DataView) ? (value as any).length : 0;
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key === 'symbol') fail('canonical input contains typed-array symbol properties');
      if (!/^(0|[1-9]\d*)$/.test(key)) fail('canonical input contains typed-array properties');
      const index = Number(key);
      if (!Number.isSafeInteger(index) || index < 0 || index >= length) fail('canonical input contains typed-array properties');
    }
    return;
  }
  if (value instanceof Map) {
    assertExactBuiltin(Map.prototype, 'Map');
    for (const [key, entry] of value) {
      assertSerializableCanonical(key, seen);
      assertSerializableCanonical(entry, seen);
    }
    return;
  }
  if (value instanceof Set) {
    assertExactBuiltin(Set.prototype, 'Set');
    for (const entry of value) assertSerializableCanonical(entry, seen);
    return;
  }
  const prototype = Object.getPrototypeOf(value);
  if (Array.isArray(value) && prototype !== Array.prototype) {
    fail('canonical input contains nonordinary Array');
  }
  if (Array.isArray(value)) {
    const length = Object.getOwnPropertyDescriptor(value, 'length');
    if (!length || !('value' in length) || length.value !== value.length || length.enumerable || length.configurable || length.writable !== true) {
      fail('canonical input contains nonordinary Array length');
    }
  }
  if (!Array.isArray(value) && prototype !== Object.prototype) {
    fail(`canonical input contains unsupported class ${value.constructor?.name ?? '(anonymous)'}`);
  }
  if (Object.getOwnPropertySymbols(value).length > 0) fail('canonical input contains symbol keys');
  for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(value))) {
    if (!('value' in descriptor)) fail('canonical input contains an accessor property');
    // V8 serialization restores ordinary data properties, not seals, hidden
    // properties, or descriptor flags. Reject values whose observable shape
    // would change across the approval boundary.
    if (Array.isArray(value) && key === 'length') continue;
    if (!descriptor.enumerable || !descriptor.writable || !descriptor.configurable) {
      fail('canonical input contains a nonordinary property descriptor');
    }
    assertSerializableCanonical(descriptor.value, seen);
  }
}

function parseRecord(raw: Buffer): ApprovalInputRecord {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw.toString('utf8'));
  } catch {
    fail('ledger record is corrupt');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) fail('ledger record is corrupt');
  const record = parsed as Record<string, unknown>;
  if (
    record.version !== 3
    || typeof record.createdAt !== 'number'
    || typeof record.runtimeContract !== 'string'
    || typeof record.sessionId !== 'string'
    || typeof record.agentId !== 'string'
    || typeof record.toolName !== 'string'
    || typeof record.toolCallId !== 'string'
    || typeof record.rawDigest !== 'string'
    || typeof record.toolContract !== 'string'
    || typeof record.value !== 'string'
  ) fail('ledger record is corrupt');
  return record as ApprovalInputRecord;
}

export class ApprovalInputLedger {
  private dir: string | undefined;

  constructor(
    private readonly sessionId: string | undefined,
    private readonly agentId: string | undefined,
    sessionDir?: string,
  ) {
    this.dir = sessionDir;
    if (sessionDir) this.cleanupStale();
  }

  bind(sessionDir: string): void {
    this.dir = sessionDir;
    this.cleanupStale();
  }

  /** A ledger operation may only create a human-resumable approval after the
   * session directory, session id, and agent id are all durable bindings. */
  get isBound(): boolean {
    return Boolean(this.dir && this.sessionId && this.agentId);
  }

  /** The ledger holds resumable authority, so it may only use a private,
   * owner-controlled directory. Do not repair an existing unsafe directory:
   * another process could be relying on that path while it is being changed. */
  private ledgerDirectory(): string {
    const { dir } = this.requireBinding();
    const directory = path.join(dir, APPROVAL_INPUT_LEDGER_DIR);
    try {
      fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
      const stat = fs.lstatSync(directory);
      if (!stat.isDirectory() || stat.isSymbolicLink()) {
        fail('approval input directory is not a real directory');
      }
      if ((stat.mode & 0o077) !== 0) {
        fail('approval input directory has group or world permissions');
      }
      if (typeof process.getuid === 'function' && stat.uid !== process.getuid()) {
        fail('approval input directory is owned by another user');
      }
      return directory;
    } catch (error) {
      if (error instanceof ApprovalInputLedgerError) throw error;
      fail(`approval input directory could not be secured: ${(error as Error).message}`);
    }
  }

  /** Read a record or claim without accepting a final-path symlink or a file
   * swapped between lstat and open. O_NOFOLLOW is unavailable on a few hosts,
   * where the inode comparison still detects a pathname replacement. */
  private readPrivateRegularFile(filePath: string, label: string): Buffer {
    let before: fs.Stats;
    try {
      before = fs.lstatSync(filePath);
      if (!before.isFile() || before.isSymbolicLink()) fail(`${label} is not a regular file`);
      const noFollow = typeof fs.constants.O_NOFOLLOW === 'number' ? fs.constants.O_NOFOLLOW : 0;
      const fd = fs.openSync(filePath, fs.constants.O_RDONLY | noFollow);
      try {
        const after = fs.fstatSync(fd);
        if (!after.isFile() || after.dev !== before.dev || after.ino !== before.ino) {
          fail(`${label} changed while it was being read`);
        }
        return fs.readFileSync(fd);
      } finally {
        fs.closeSync(fd);
      }
    } catch (error) {
      if (error instanceof ApprovalInputLedgerError) throw error;
      fail(`${label} could not be read safely: ${(error as Error).message}`);
    }
  }

  private existingRegularFile(filePath: string, label: string): boolean {
    try {
      const stat = fs.lstatSync(filePath);
      if (!stat.isFile() || stat.isSymbolicLink()) fail(`${label} is not a regular file`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
      throw error;
    }
    // Re-open with O_NOFOLLOW after the existence probe. A concurrent removal
    // is an error, never a reason to treat the identity as available.
    this.readPrivateRegularFile(filePath, label);
    return true;
  }

  /** Keep cleanup work bounded even if a damaged session directory contains a
   * large number of abandoned records. Exact consumption still checks age. */
  private cleanupStale(now = Date.now()): void {
    if (!this.dir) return;
    const directory = this.ledgerDirectory();
    let handle: fs.Dir | undefined;
    try {
      handle = fs.opendirSync(directory);
      for (let scanned = 0; scanned < APPROVAL_INPUT_CLEANUP_MAX_FILES; scanned++) {
        const entry = handle.readSync();
        if (!entry) break;
        if (!entry.isFile()) continue;
        // A consumed identity is a one-shot safety boundary for the whole
        // session, not an expiring cache entry.
        if (entry.name.endsWith('.consumed')) continue;
        const candidate = path.join(directory, entry.name);
        try {
          const stat = fs.lstatSync(candidate);
          if (!stat.isFile() || stat.isSymbolicLink()) continue;
          let stale = stat.size <= 0
            || stat.size > APPROVAL_INPUT_MAX_RECORD_BYTES
            || now - stat.mtimeMs > APPROVAL_INPUT_MAX_AGE_MS;
          if (!stale && entry.name.endsWith('.json') && stat.size <= APPROVAL_INPUT_MAX_RECORD_BYTES) {
            try {
              const parsed = JSON.parse(this.readPrivateRegularFile(candidate, 'ledger record').toString('utf8')) as { createdAt?: unknown };
              stale = typeof parsed.createdAt !== 'number'
                || !Number.isFinite(parsed.createdAt)
                || now - parsed.createdAt > APPROVAL_INPUT_MAX_AGE_MS
                || parsed.createdAt > now + 5 * 60 * 1000;
            } catch {
              stale = true;
            }
          }
          if (stale) fs.rmSync(candidate, { force: true });
        } catch {
          // A concurrent consumer may already have claimed the record.
        }
      }
    } catch {
      // The directory normally does not exist until the first approval.
    } finally {
      try { handle?.closeSync(); } catch { /* best effort */ }
    }
  }

  private requireBinding(): { dir: string; sessionId: string; agentId: string } {
    if (!this.dir || !this.sessionId || !this.agentId) {
      fail('the run has no durable session binding');
    }
    return { dir: this.dir, sessionId: this.sessionId, agentId: this.agentId };
  }

  private filePath(toolName: string, toolCallId: string): string {
    const { sessionId, agentId } = this.requireBinding();
    const name = createHash('sha256')
      .update(`${sessionId}\0${agentId}\0${toolName}\0${toolCallId}`)
      .digest('hex');
    return path.join(this.ledgerDirectory(), `${name}.json`);
  }

  /** Claim an identity before any plugin, validator, or approval callback can
   * observe it. A separate private lock prevents a concurrent invalid call
   * from racing the first call to its eventual durable record. */
  reserve(toolName: string, toolCallId: string): ApprovalInputReservation {
    this.ledgerDirectory();
    const filePath = this.filePath(toolName, toolCallId);
    const lockPath = `${filePath}.lock`;
    const consumedPath = `${filePath}.consumed`;
    try {
      const fd = fs.openSync(lockPath, 'wx', 0o600);
      try { fs.writeFileSync(fd, randomUUID()); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
      if (this.existingRegularFile(filePath, 'ledger record') || this.existingRegularFile(consumedPath, 'ledger tombstone')) {
        fs.rmSync(lockPath, { force: true });
        throw new DuplicateApprovalInputLedgerError();
      }
      return { path: lockPath, token: this.readPrivateRegularFile(lockPath, 'ledger lock').toString('utf8') };
    } catch (error) {
      if (error instanceof DuplicateApprovalInputLedgerError) throw error;
      if ((error as NodeJS.ErrnoException).code === 'EEXIST') throw new DuplicateApprovalInputLedgerError();
      fail(`approval identity could not be reserved: ${(error as Error).message}`);
    }
  }

  release(reservation: ApprovalInputReservation | undefined): void {
    if (!reservation) return;
    try {
      if (this.readPrivateRegularFile(reservation.path, 'ledger lock').toString('utf8') === reservation.token) fs.rmSync(reservation.path, { force: true });
    } catch { /* another owner never gets to remove this lock */ }
  }

  store(toolName: string, toolCallId: string, rawInput: unknown, canonicalInput: unknown, now = Date.now(), toolContract = APPROVAL_INPUT_RUNTIME_CONTRACT, reservation?: ApprovalInputReservation): void {
    this.ledgerDirectory();
    const { sessionId, agentId } = this.requireBinding();
    assertSerializableCanonical(canonicalInput);
    let payload: Buffer;
    try {
      payload = serialize(canonicalInput);
    } catch (error) {
      fail(`canonical input cannot be serialized: ${(error as Error).message}`);
    }
    if (payload.byteLength > APPROVAL_INPUT_MAX_VALUE_BYTES) {
      fail(`canonical input exceeds ${APPROVAL_INPUT_MAX_VALUE_BYTES} bytes`);
    }
    const record: ApprovalInputRecord = {
      version: 3,
      createdAt: now,
      runtimeContract: APPROVAL_INPUT_RUNTIME_CONTRACT,
      sessionId,
      agentId,
      toolName,
      toolCallId,
      rawDigest: approvalInputDigest(rawInput),
      toolContract,
      value: payload.toString('base64'),
    };
    const bytes = Buffer.from(JSON.stringify(record));
    if (bytes.byteLength > APPROVAL_INPUT_MAX_RECORD_BYTES) {
      fail(`ledger record exceeds ${APPROVAL_INPUT_MAX_RECORD_BYTES} bytes`);
    }

    const filePath = this.filePath(toolName, toolCallId);
    const directory = path.dirname(filePath);
    const temporary = path.join(directory, `.${path.basename(filePath)}.${process.pid}.${randomUUID()}.tmp`);
    try {
      // Link a complete, fsynced private temp file into place. Unlike rename,
      // link refuses EEXIST, so a repeated approval identity cannot replace a
      // previously canonicalized value.
      const fd = fs.openSync(temporary, 'wx', 0o600);
      try {
        fs.writeFileSync(fd, bytes);
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      try {
        if (reservation && (this.readPrivateRegularFile(reservation.path, 'ledger lock').toString('utf8') !== reservation.token)) {
          throw new DuplicateApprovalInputLedgerError();
        }
        fs.linkSync(temporary, filePath);
        // Persist the directory entry as well as the private record before the
        // caller is allowed to suspend for human approval.
        const directoryFd = fs.openSync(directory, 'r');
        try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          throw new DuplicateApprovalInputLedgerError();
        }
        throw error;
      }
    } catch (error) {
      if (isDuplicateApprovalInputLedgerError(error)) throw error;
      fail(`ledger record could not be persisted: ${(error as Error).message}`);
    } finally {
      try { fs.rmSync(temporary, { force: true }); } catch { /* best effort */ }
    }
  }

  /** Atomically claim and consume one exact record before execution. */
  consume(toolName: string, toolCallId: string, rawInput: unknown, now = Date.now(), toolContract = APPROVAL_INPUT_RUNTIME_CONTRACT): unknown {
    this.ledgerDirectory();
    const { sessionId, agentId } = this.requireBinding();
    const filePath = this.filePath(toolName, toolCallId);
    const lockPath = `${filePath}.lock`;
    const consumedPath = `${filePath}.consumed`;
    const claimed = `${filePath}.${randomUUID()}.claim`;
    let reservation: ApprovalInputReservation | undefined;
    try {
      // Take the exact same owner-scoped lock as fresh reservation before
      // claiming the record. This closes the window where rename made the
      // identity appear unused while the approved effect was about to run.
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try { fs.writeFileSync(fd, randomUUID()); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        reservation = { path: lockPath, token: this.readPrivateRegularFile(lockPath, 'ledger lock').toString('utf8') };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          fail('canonical input is already being claimed for this tool call');
        }
        throw error;
      }
      if (this.existingRegularFile(consumedPath, 'ledger tombstone')) fail('canonical input was already consumed for this tool call');
      fs.renameSync(filePath, claimed);
    } catch (error) {
      this.release(reservation);
      fail((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'no matching canonical input was persisted'
        : `ledger record could not be claimed: ${(error as Error).message}`);
    }

    try {
      const stat = fs.lstatSync(claimed);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > APPROVAL_INPUT_MAX_RECORD_BYTES) {
        fail('ledger record has an invalid size or type');
      }
      // Persist a tombstone before validating or returning the canonical value.
      // It intentionally outlives the claim: the subsequent effect can be
      // running in another layer when this function returns.
      const tombstone = Buffer.from(JSON.stringify({ version: 1, consumedAt: now }));
      const tombstoneFd = fs.openSync(consumedPath, 'wx', 0o600);
      try { fs.writeFileSync(tombstoneFd, tombstone); fs.fsyncSync(tombstoneFd); } finally { fs.closeSync(tombstoneFd); }
      const directoryFd = fs.openSync(path.dirname(filePath), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
      const record = parseRecord(this.readPrivateRegularFile(claimed, 'ledger record'));
      if (
        record.runtimeContract !== APPROVAL_INPUT_RUNTIME_CONTRACT
      ) fail('ledger record was created by an incompatible runtime contract');
      if (record.toolContract !== toolContract) fail('ledger record was created by an incompatible tool contract');
      if (
        record.sessionId !== sessionId
        || record.agentId !== agentId
        || record.toolName !== toolName
        || record.toolCallId !== toolCallId
      ) fail('ledger record identity does not match this session and tool call');
      if (
        !Number.isFinite(record.createdAt)
        || record.createdAt > now + 5 * 60 * 1000
        || now - record.createdAt > APPROVAL_INPUT_MAX_AGE_MS
      ) fail('ledger record is stale');
      if (record.rawDigest !== approvalInputDigest(rawInput)) {
        fail('approved provider input does not match the persisted record');
      }
      if (!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(record.value)) {
        fail('ledger payload is corrupt');
      }
      const payload = Buffer.from(record.value, 'base64');
      if (payload.byteLength <= 0 || payload.byteLength > APPROVAL_INPUT_MAX_VALUE_BYTES) {
        fail('ledger payload has an invalid size');
      }
      let value: unknown;
      try {
        value = deserialize(payload);
      } catch {
        fail('ledger payload is corrupt');
      }
      assertSerializableCanonical(value);
      return value;
    } finally {
      try { fs.rmSync(claimed, { force: true }); } catch { /* fail closed on reuse */ }
      this.release(reservation);
    }
  }

  /** Permanently invalidate a pending approval without an unsafe unlink.
   * Reuse consume's identity lock and durable tombstone so a concurrent fresh
   * call cannot slip in between policy rejection and record removal. */
  invalidate(toolName: string, toolCallId: string, now = Date.now()): void {
    this.ledgerDirectory();
    const filePath = this.filePath(toolName, toolCallId);
    const lockPath = `${filePath}.lock`;
    const consumedPath = `${filePath}.consumed`;
    const claimed = `${filePath}.${randomUUID()}.claim`;
    let reservation: ApprovalInputReservation | undefined;
    try {
      try {
        const fd = fs.openSync(lockPath, 'wx', 0o600);
        try { fs.writeFileSync(fd, randomUUID()); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
        reservation = { path: lockPath, token: this.readPrivateRegularFile(lockPath, 'ledger lock').toString('utf8') };
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EEXIST') {
          fail('canonical input is already being claimed for this tool call');
        }
        throw error;
      }
      if (this.existingRegularFile(consumedPath, 'ledger tombstone')) return;
      fs.renameSync(filePath, claimed);
      const stat = fs.lstatSync(claimed);
      if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0 || stat.size > APPROVAL_INPUT_MAX_RECORD_BYTES) {
        fail('ledger record has an invalid size or type');
      }
      const tombstone = Buffer.from(JSON.stringify({ version: 1, consumedAt: now }));
      const tombstoneFd = fs.openSync(consumedPath, 'wx', 0o600);
      try { fs.writeFileSync(tombstoneFd, tombstone); fs.fsyncSync(tombstoneFd); } finally { fs.closeSync(tombstoneFd); }
      const directoryFd = fs.openSync(path.dirname(filePath), 'r');
      try { fs.fsyncSync(directoryFd); } finally { fs.closeSync(directoryFd); }
    } catch (error) {
      if (this.existingRegularFile(`${filePath}.consumed`, 'ledger tombstone')) return;
      fail((error as NodeJS.ErrnoException).code === 'ENOENT'
        ? 'no matching canonical input was persisted'
        : `ledger record could not be invalidated: ${(error as Error).message}`);
    } finally {
      try { fs.rmSync(claimed, { force: true }); } catch { /* fail closed on reuse */ }
      this.release(reservation);
    }
  }

  discard(toolName: string, toolCallId: string, reservation?: ApprovalInputReservation): void {
    // Fresh call cleanup owns only its reservation. It must never delete a
    // pending record written by an earlier caller with the same identity.
    if (reservation) { this.release(reservation); return; }
    try {
      fs.rmSync(this.filePath(toolName, toolCallId), { force: true });
    } catch {
      // Cleanup is best effort. Any surviving record still requires an exact
      // session, tool, call and raw-input match and is consumed only once.
    }
  }
}
