import type { ProviderReadiness } from '../plugin/provider-runtime';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { getAgentuseDataDir } from '../utils/data-dir';
import { withOwnershipLock } from '../utils/ownership-lock';

export type ProviderHealthState = 'configured' | 'verified' | 'reconnect_required' | 'temporarily_unavailable';
export interface ProviderHealth {
  state: ProviderHealthState;
  checkedAt?: number;
  message?: string;
  readiness?: ProviderReadiness;
}

/** Private identity: never returned in provider status or written with credentials. */
export interface ProviderHealthSubject { key: string }
export const PROVIDER_HEALTH_TTL_MS = 5 * 60_000;

export function providerHealthSubject(provider: string, source: string, credential: unknown): ProviderHealthSubject {
  return { key: createHash('sha256').update(JSON.stringify([provider, source, credential])).digest('hex') };
}

function healthPath(subject: ProviderHealthSubject): string {
  return join(getAgentuseDataDir(), 'provider-health', `${subject.key}.json`);
}

const messages: Record<ProviderHealthState, string> = {
  configured: 'Connection configured. Not currently verified with the provider.',
  verified: 'Connection verified.',
  reconnect_required: 'The provider rejected this credential. Reconnect to continue.',
  temporarily_unavailable: 'Verification could not complete. Try again later.',
};

export async function readProviderHealth(subject: ProviderHealthSubject): Promise<ProviderHealth> {
  try {
    const record = JSON.parse(await readFile(healthPath(subject), 'utf8')) as ProviderHealth;
    if (Object.hasOwn(messages, record.state) && typeof record.checkedAt === 'number') {
      // Only our fixed messages cross the API boundary, never provider response bodies.
      return { state: record.state, checkedAt: record.checkedAt, message: messages[record.state], ...(record.readiness && { readiness: record.readiness }) };
    }
  } catch { /* Missing/unreadable cache is unverified, never a credential failure. */ }
  return { state: 'configured', message: messages.configured };
}

export function providerHealthNeedsCheck(health: ProviderHealth, now = Date.now()): boolean {
  return health.state !== 'reconnect_required'
    && (health.checkedAt === undefined || now - health.checkedAt >= PROVIDER_HEALTH_TTL_MS);
}

/** Best effort: health reporting must never break an otherwise successful run. */
export async function recordProviderHealth(
  subject: ProviderHealthSubject,
  state: ProviderHealthState,
  observedAt = Date.now(),
  options: { readiness?: ProviderReadiness; blockRefresh?: boolean; force?: boolean } = {},
): Promise<void> {
  const file = healthPath(subject);
  try {
    await mkdir(dirname(file), { recursive: true });
    await withOwnershipLock(`${file}.lock`, async () => {
      const previous = await readProviderHealth(subject);
      if ((previous.checkedAt ?? 0) > observedAt) return;
      // A definitive rejection is sticky for this exact credential. A new login
      // or token rotation creates a different identity and starts clean.
      if (previous.state === 'reconnect_required' && (state !== 'reconnect_required' || !options.blockRefresh)) return;
      if (!options.force && state === 'verified' && previous.state === state && !providerHealthNeedsCheck(previous)) return;
      const temporary = `${file}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, JSON.stringify({ state, checkedAt: observedAt, ...((options.readiness ?? (previous.state === state ? previous.readiness : undefined)) && { readiness: options.readiness ?? (previous.state === state ? previous.readiness : undefined) }), ...(options.blockRefresh && { blockRefresh: true }) }), { mode: 0o600 });
        await rename(temporary, file);
      } finally {
        await rm(temporary, { force: true }).catch(() => {});
      }
    }, { maxWaitMs: 1_000 });
  } catch { /* Credential usage is independent of health-cache availability. */ }
}

export class ProviderReconnectRequiredError extends Error {
  constructor() { super('Provider credentials were rejected. Reconnect before retrying.'); }
}

export async function assertProviderRefreshAllowed(subject: ProviderHealthSubject): Promise<void> {
  const record = await readFile(healthPath(subject), 'utf8').then((raw) => JSON.parse(raw)).catch(() => undefined);
  if (record?.blockRefresh === true) throw new ProviderReconnectRequiredError();
}

/** Inspect only auth codes, never retain or expose the response body. */
export async function observeProviderResponse(
  subject: ProviderHealthSubject,
  response: Response,
  oauth = false,
  observedAt = Date.now(),
): Promise<void> {
  if (response.ok) {
    // Refresh payloads must be validated and stored by the auth implementation
    // before the replacement credential is considered verified.
    if (!oauth) await recordProviderHealth(subject, 'verified', observedAt);
    return;
  }
  let invalidGrant = false;
  if (oauth && response.status === 400) {
    try {
      const body = await response.clone().json() as { error?: string | { type?: string } };
      invalidGrant = body.error === 'invalid_grant'
        || (typeof body.error === 'object' && body.error?.type === 'invalid_grant');
    } catch { /* A bare 400 does not establish invalid credentials. */ }
  }
  if (invalidGrant || response.status === 401) {
    await recordProviderHealth(subject, 'reconnect_required', observedAt, { blockRefresh: invalidGrant });
  } else if (response.status === 403 || response.status === 429 || response.status >= 500) {
    await recordProviderHealth(subject, 'temporarily_unavailable', observedAt);
  }
}

/** Shared by actual requests and explicit lightweight checks. */
export async function fetchWithProviderHealth(
  subject: ProviderHealthSubject | undefined,
  input: RequestInfo | URL,
  init?: RequestInit,
  options: { fetch?: typeof fetch; oauth?: boolean } = {},
): Promise<Response> {
  const startedAt = Date.now();
  try {
    const response = await (options.fetch ?? fetch)(input, init);
    if (subject) await observeProviderResponse(subject, response, options.oauth, startedAt);
    return response;
  } catch (error) {
    if (subject && !init?.signal?.aborted) await recordProviderHealth(subject, 'temporarily_unavailable', startedAt);
    throw error;
  }
}

const checks = new Map<string, Promise<ProviderHealth>>();
/** Coalesce screen opens/Recheck requests, and consult the durable worker cache. */
export async function verifyProviderHealth(
  subject: ProviderHealthSubject,
  verify: () => Promise<ProviderHealthState>,
  force = false,
): Promise<ProviderHealth> {
  const cacheKey = healthPath(subject);
  const pending = checks.get(cacheKey);
  if (pending) return pending;
  const operation = (async () => {
    const cached = await readProviderHealth(subject);
    if (cached.state === 'reconnect_required' || (!force && !providerHealthNeedsCheck(cached))) return cached;
    const startedAt = Date.now();
    try {
      await recordProviderHealth(subject, await verify(), startedAt, { force: true });
    } catch {
      await recordProviderHealth(subject, 'temporarily_unavailable', startedAt);
    }
    return readProviderHealth(subject);
  })();
  checks.set(cacheKey, operation);
  try { return await operation; } finally { checks.delete(cacheKey); }
}
