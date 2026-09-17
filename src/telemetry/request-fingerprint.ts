import { createHash } from 'node:crypto';

export interface RequestFingerprint {
  sequence: number;
  allHash: string;
  prefixHash?: string;
  previousAllHash?: string;
  prefixUnchanged?: boolean;
}

function canonical(value: any): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical(value[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
const hash = (value: unknown) => createHash('sha256').update(canonical(value)).digest('hex');

/** Fingerprint final JSON bodies, retaining hashes only, never prompt text.
 * Envelope includes instructions, tool definitions, model and cache options.
 * Reset per model instance: resume/fallback begins a new comparison chain.
 */
export function createRequestFingerprinter() {
  let previous: { allHash: string; count: number } | undefined;
  let sequence = 0;
  return (body: unknown): RequestFingerprint | undefined => {
    if (typeof body !== 'string') return undefined;
    let parsed: any;
    try { parsed = JSON.parse(body); } catch { return undefined; }
    if (!parsed || typeof parsed !== 'object') return undefined;
    const field = Array.isArray(parsed.input) ? 'input' : Array.isArray(parsed.messages) ? 'messages' : undefined;
    if (!field) return undefined;
    const items = parsed[field].map(hash);
    const envelope = { ...parsed }; delete envelope[field];
    const envelopeHash = hash(envelope);
    const allHash = hash({ envelopeHash, items });
    const prefixHash = previous ? hash({ envelopeHash, items: items.slice(0, previous.count) }) : undefined;
    const result: RequestFingerprint = {
      sequence: ++sequence, allHash,
      ...(previous && prefixHash && { prefixHash, previousAllHash: previous.allHash,
        prefixUnchanged: items.length >= previous.count && prefixHash === previous.allHash }),
    };
    previous = { allHash, count: items.length };
    return result;
  };
}
