#!/usr/bin/env node

import { createHash } from 'node:crypto';

const values = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const flag = process.argv[index];
  const value = process.argv[index + 1];
  if (!flag?.startsWith('--') || value === undefined) {
    throw new Error('Expected --label, --bytes, and --delay pairs');
  }
  values.set(flag.slice(2), value);
}

const label = values.get('label') ?? '';
const bytes = Number(values.get('bytes'));
const delayMs = Number(values.get('delay'));
if (!/^[a-z0-9-]+$/i.test(label)) throw new Error('label must be alphanumeric');
if (!Number.isInteger(bytes) || bytes < 0 || bytes > 120_000) throw new Error('bytes must be 0..120000');
if (!Number.isInteger(delayMs) || delayMs < 0 || delayMs > 15_000) throw new Error('delay must be 0..15000');

if (delayMs > 0) await new Promise(resolve => setTimeout(resolve, delayMs));

const seed = `${label}|`;
const payload = seed.repeat(Math.ceil(bytes / seed.length)).slice(0, bytes);
const sha256 = createHash('sha256').update(payload).digest('hex');
process.stdout.write(JSON.stringify({ label, bytes, delayMs, sha256, payload }));
