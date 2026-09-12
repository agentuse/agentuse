import { createHash } from 'crypto';

export interface CompleteApprovalValueDisplay {
  text: string;
  sha256: string;
}

const dateGetTime = Date.prototype.getTime;
const dateToISOString = Date.prototype.toISOString;
const regexpSource = Object.getOwnPropertyDescriptor(RegExp.prototype, 'source')?.get;
const regexpFlags = Object.getOwnPropertyDescriptor(RegExp.prototype, 'flags')?.get;
const mapForEach = Map.prototype.forEach;
const setForEach = Set.prototype.forEach;
const typedArrayPrototype = Object.getPrototypeOf(Int8Array.prototype);
const typedArrayByteOffset = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteOffset')?.get;
const typedArrayByteLength = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'byteLength')?.get;
const typedArrayBuffer = Object.getOwnPropertyDescriptor(typedArrayPrototype, 'buffer')?.get;
const dataViewByteOffset = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteOffset')?.get;
const dataViewByteLength = Object.getOwnPropertyDescriptor(DataView.prototype, 'byteLength')?.get;
const dataViewBuffer = Object.getOwnPropertyDescriptor(DataView.prototype, 'buffer')?.get;

const viewNames = new Map<object, string>([
  [Int8Array.prototype, 'Int8Array'],
  [Uint8Array.prototype, 'Uint8Array'],
  [Uint8ClampedArray.prototype, 'Uint8ClampedArray'],
  [Int16Array.prototype, 'Int16Array'],
  [Uint16Array.prototype, 'Uint16Array'],
  [Int32Array.prototype, 'Int32Array'],
  [Uint32Array.prototype, 'Uint32Array'],
  [Float32Array.prototype, 'Float32Array'],
  [Float64Array.prototype, 'Float64Array'],
  [BigInt64Array.prototype, 'BigInt64Array'],
  [BigUint64Array.prototype, 'BigUint64Array'],
  [DataView.prototype, 'DataView'],
  [Buffer.prototype, 'Buffer'],
]);

function apply<T>(fn: ((...args: any[]) => T) | undefined, receiver: unknown, args: unknown[] = []): T {
  if (!fn) throw new Error('Approval value cannot be inspected in this runtime');
  return Reflect.apply(fn, receiver, args);
}

function isOrdinaryDataDescriptor(
  descriptor: PropertyDescriptor | undefined,
): descriptor is PropertyDescriptor & { value: unknown } {
  return Boolean(
    descriptor
    && 'value' in descriptor
    && descriptor.enumerable
    && descriptor.writable
    && descriptor.configurable,
  );
}

function assertNoOwnProperties(value: object, label: string): void {
  if (Reflect.ownKeys(value).length > 0) {
    throw new Error(`Approval value contains nonordinary ${label}`);
  }
}

/**
 * Render an approval value without truncation or JSON's lossy treatment of
 * supported transformed values. Ordinary JSON stays ordinary; richer values
 * use explicit tags and reference ids so Maps, Sets, binary data, BigInts, and
 * shared/cyclic object identity remain visible to the reviewer.
 *
 * Descriptor inspection happens before reading any transformed object. This
 * keeps accessors and unsupported subclasses from running code while an
 * approval prompt is being prepared.
 */
export function completeApprovalValueDisplay(value: unknown): CompleteApprovalValueDisplay {
  const plainSeen = new WeakSet<object>();
  const projectPlainJson = (current: unknown): { plain: true; value: unknown } | { plain: false } => {
    if (current === null || typeof current === 'string' || typeof current === 'boolean') {
      return { plain: true, value: current };
    }
    if (typeof current === 'number') {
      return Number.isFinite(current) && !Object.is(current, -0)
        ? { plain: true, value: current }
        : { plain: false };
    }
    if (typeof current !== 'object' || plainSeen.has(current)) return { plain: false };
    plainSeen.add(current);

    if (Array.isArray(current)) {
      if (Object.getPrototypeOf(current) !== Array.prototype || Object.getOwnPropertySymbols(current).length > 0) {
        return { plain: false };
      }
      const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(current);
      const lengthDescriptor = descriptors.length;
      if (
        !lengthDescriptor
        || !('value' in lengthDescriptor)
        || !Number.isSafeInteger(lengthDescriptor.value)
        || lengthDescriptor.value < 0
        || lengthDescriptor.enumerable
        || lengthDescriptor.configurable
        || lengthDescriptor.writable !== true
      ) return { plain: false };
      const length = lengthDescriptor.value as number;
      if (Object.keys(descriptors).some((key) => {
        if (key === 'length') return false;
        const index = Number(key);
        return !Number.isInteger(index) || index < 0 || index >= length || String(index) !== key;
      })) return { plain: false };

      const projected: unknown[] = [];
      for (let index = 0; index < length; index++) {
        const descriptor = descriptors[String(index)];
        if (!isOrdinaryDataDescriptor(descriptor)) return { plain: false };
        const entry = projectPlainJson(descriptor.value);
        if (!entry.plain) return entry;
        projected.push(entry.value);
      }
      return { plain: true, value: projected };
    }

    if (Object.getPrototypeOf(current) !== Object.prototype || Object.getOwnPropertySymbols(current).length > 0) {
      return { plain: false };
    }
    const projected: Record<string, unknown> = {};
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(current))) {
      if (!isOrdinaryDataDescriptor(descriptor)) return { plain: false };
      const entry = projectPlainJson(descriptor.value);
      if (!entry.plain) return entry;
      Object.defineProperty(projected, key, {
        value: entry.value,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return { plain: true, value: projected };
  };

  const plain = projectPlainJson(value);
  let projected: unknown = plain.plain ? plain.value : value;
  if (!plain.plain) {
    const references = new Map<object, number>();
    let nextId = 1;
    const convert = (current: unknown): unknown => {
      if (current === null || typeof current === 'string' || typeof current === 'boolean') return current;
      if (typeof current === 'number') {
        return Number.isFinite(current) && !Object.is(current, -0)
          ? current
          : { __type: 'Number', value: Object.is(current, -0) ? '-0' : String(current) };
      }
      if (typeof current === 'bigint') return { __type: 'BigInt', value: current.toString() };
      if (typeof current === 'undefined') return { __type: 'Undefined' };
      if (typeof current === 'symbol' || typeof current === 'function') {
        throw new Error(`Approval value contains unsupported ${typeof current}`);
      }
      if (typeof current !== 'object') return String(current);
      const prior = references.get(current);
      if (prior !== undefined) return { __type: 'Reference', id: prior };
      const id = nextId++;
      references.set(current, id);

      const prototype = Object.getPrototypeOf(current);
      if (prototype === Date.prototype) {
        assertNoOwnProperties(current, 'Date');
        const timestamp = apply<number>(dateGetTime, current);
        return Number.isFinite(timestamp)
          ? { __type: 'Date', id, value: apply<string>(dateToISOString, current) }
          : { __type: 'Date', id, invalid: true };
      }
      if (prototype === RegExp.prototype) {
        const keys = Reflect.ownKeys(current);
        const lastIndex = Object.getOwnPropertyDescriptor(current, 'lastIndex');
        if (
          keys.length !== 1
          || keys[0] !== 'lastIndex'
          || !lastIndex
          || !('value' in lastIndex)
          || lastIndex.value !== 0
          || lastIndex.enumerable
          || lastIndex.configurable
          || lastIndex.writable !== true
        ) throw new Error('Approval value contains nonordinary RegExp');
        return {
          __type: 'RegExp',
          id,
          source: apply<string>(regexpSource, current),
          flags: apply<string>(regexpFlags, current),
        };
      }
      if (prototype === Map.prototype) {
        assertNoOwnProperties(current, 'Map');
        const entries: unknown[] = [];
        apply<void>(mapForEach, current, [(entry: unknown, key: unknown) => {
          entries.push([convert(key), convert(entry)]);
        }]);
        return { __type: 'Map', id, entries };
      }
      if (prototype === Set.prototype) {
        assertNoOwnProperties(current, 'Set');
        const values: unknown[] = [];
        apply<void>(setForEach, current, [(entry: unknown) => { values.push(convert(entry)); }]);
        return { __type: 'Set', id, values };
      }
      if (prototype === ArrayBuffer.prototype) {
        assertNoOwnProperties(current, 'ArrayBuffer');
        return { __type: 'ArrayBuffer', id, base64: Buffer.from(current as ArrayBuffer).toString('base64') };
      }
      const viewName = viewNames.get(prototype);
      if (viewName && ArrayBuffer.isView(current)) {
        for (const key of Reflect.ownKeys(current)) {
          if (typeof key === 'symbol' || !/^(0|[1-9]\d*)$/.test(key)) {
            throw new Error('Approval value contains nonordinary typed-array properties');
          }
        }
        const dataView = prototype === DataView.prototype;
        const byteOffset = apply<number>(dataView ? dataViewByteOffset : typedArrayByteOffset, current);
        const byteLength = apply<number>(dataView ? dataViewByteLength : typedArrayByteLength, current);
        const buffer = apply<ArrayBuffer>(dataView ? dataViewBuffer : typedArrayBuffer, current);
        return { __type: viewName, id, byteOffset, byteLength, buffer: convert(buffer) };
      }
      if (Array.isArray(current)) {
        if (prototype !== Array.prototype || Object.getOwnPropertySymbols(current).length > 0) {
          throw new Error('Approval value contains nonordinary Array');
        }
        const descriptors: Record<string, PropertyDescriptor> = Object.getOwnPropertyDescriptors(current);
        const lengthDescriptor = descriptors.length;
        if (
          !lengthDescriptor
          || !('value' in lengthDescriptor)
          || !Number.isSafeInteger(lengthDescriptor.value)
          || lengthDescriptor.value < 0
          || lengthDescriptor.enumerable
          || lengthDescriptor.configurable
          || lengthDescriptor.writable !== true
        ) throw new Error('Approval value contains nonordinary Array length');
        const length = lengthDescriptor.value as number;
        const values: unknown[] = [];
        const properties: unknown[] = [];
        for (const [key, descriptor] of Object.entries(descriptors)) {
          if (key === 'length') continue;
          if (!isOrdinaryDataDescriptor(descriptor)) {
            throw new Error('Approval value contains a nonordinary array property');
          }
          const index = Number(key);
          if (!Number.isInteger(index) || index < 0 || index >= length || String(index) !== key) {
            properties.push([key, convert(descriptor.value)]);
          }
        }
        for (let index = 0; index < length; index++) {
          const descriptor = descriptors[String(index)];
          if (!descriptor) {
            values.push({ __type: 'Hole' });
          } else {
            if (!isOrdinaryDataDescriptor(descriptor)) {
              throw new Error('Approval value contains a nonordinary array property');
            }
            values.push(convert(descriptor.value));
          }
        }
        return { __type: 'Array', id, values, ...(properties.length > 0 && { properties }) };
      }
      if (prototype !== Object.prototype || Object.getOwnPropertySymbols(current).length > 0) {
        throw new Error('Approval value contains an unsupported object prototype');
      }
      const entries = Object.entries(Object.getOwnPropertyDescriptors(current)).map(([key, descriptor]) => {
        if (!isOrdinaryDataDescriptor(descriptor)) {
          throw new Error('Approval value contains a nonordinary property');
        }
        return [key, convert(descriptor.value)];
      });
      return { __type: 'Object', id, entries };
    };
    projected = convert(value);
  }

  const text = value === undefined
    ? JSON.stringify({ __type: 'Undefined' }, null, 2)
    : JSON.stringify(projected, null, 2);
  if (text === undefined) throw new Error('Approval value cannot be rendered');
  return {
    text,
    sha256: createHash('sha256').update(text).digest('hex'),
  };
}
