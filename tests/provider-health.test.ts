import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  assertProviderRefreshAllowed, fetchWithProviderHealth, observeProviderResponse,
  providerHealthNeedsCheck, providerHealthSubject, readProviderHealth, recordProviderHealth,
  verifyProviderHealth, PROVIDER_HEALTH_TTL_MS,
} from '../src/auth/provider-health';

let root: string;
let originalDataDir: string | undefined;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'agentuse-health-'));
  originalDataDir = process.env.AGENTUSE_DATA_DIR;
  process.env.AGENTUSE_DATA_DIR = root;
});
afterEach(async () => {
  if (originalDataDir === undefined) delete process.env.AGENTUSE_DATA_DIR;
  else process.env.AGENTUSE_DATA_DIR = originalDataDir;
  await rm(root, { recursive: true, force: true });
});

const subject = () => providerHealthSubject('anthropic', 'oauth', { refresh: 'private-refresh-token' });

describe('durable provider health', () => {
  it('starts configured and caches verified checks for five minutes', async () => {
    const identity = subject();
    expect((await readProviderHealth(identity)).state).toBe('configured');
    const probe = mock(async () => 'verified' as const);
    await verifyProviderHealth(identity, probe);
    await verifyProviderHealth(identity, probe);
    expect(probe).toHaveBeenCalledTimes(1);
    const health = await readProviderHealth(identity);
    expect(providerHealthNeedsCheck(health, health.checkedAt! + PROVIDER_HEALTH_TTL_MS - 1)).toBe(false);
    expect(providerHealthNeedsCheck(health, health.checkedAt! + PROVIDER_HEALTH_TTL_MS)).toBe(true);
    await verifyProviderHealth(identity, probe, true);
    expect(probe).toHaveBeenCalledTimes(2);
  });

  it('coalesces concurrent screen opens and forced checks', async () => {
    const probe = mock(async () => { await Bun.sleep(20); return 'verified' as const; });
    await Promise.all(Array.from({ length: 5 }, () => verifyProviderHealth(subject(), probe, true)));
    expect(probe).toHaveBeenCalledTimes(1);
  });

  it('persists invalid_grant and blocks another refresh or manual recheck', async () => {
    await observeProviderResponse(subject(), Response.json({ error: 'invalid_grant', error_description: 'private-refresh-token' }, { status: 400 }), true);
    expect((await readProviderHealth(subject())).state).toBe('reconnect_required');
    await expect(assertProviderRefreshAllowed(subject())).rejects.toThrow('Reconnect');
    const probe = mock(async () => 'verified' as const);
    await verifyProviderHealth(subject(), probe, true);
    expect(probe).not.toHaveBeenCalled();
    await recordProviderHealth(subject(), 'temporarily_unavailable');
    expect((await readProviderHealth(subject())).state).toBe('reconnect_required');
  });

  it('does not treat a bare HTTP 400 as an invalid refresh token', async () => {
    await observeProviderResponse(subject(), Response.json({ error: 'invalid_request' }, { status: 400 }), true);
    await assertProviderRefreshAllowed(subject());
    expect((await readProviderHealth(subject())).state).toBe('configured');
  });

  it('allows refresh after an access-token 401', async () => {
    await observeProviderResponse(subject(), new Response('', { status: 401 }));
    await assertProviderRefreshAllowed(subject());
  });

  it('keeps timeouts, rate limits and server errors retryable', async () => {
    for (const status of [403, 429, 500, 503]) {
      const identity = providerHealthSubject('test', 'api', status);
      await observeProviderResponse(identity, new Response('', { status }));
      expect((await readProviderHealth(identity)).state).toBe('temporarily_unavailable');
      await assertProviderRefreshAllowed(identity);
    }
    await expect(fetchWithProviderHealth(subject(), 'https://example.invalid', undefined, {
      fetch: mock(async () => { throw new Error('network failure private-refresh-token'); }) as unknown as typeof fetch,
    })).rejects.toThrow();
    expect((await readProviderHealth(subject())).state).toBe('temporarily_unavailable');
  });

  it('isolates changed credentials and other authentication methods', async () => {
    await observeProviderResponse(subject(), Response.json({ error: 'invalid_grant' }, { status: 400 }), true);
    const fresh = providerHealthSubject('anthropic', 'oauth', { refresh: 'replacement' });
    const api = providerHealthSubject('anthropic', 'api', { key: 'independent-key' });
    expect((await readProviderHealth(fresh)).state).toBe('configured');
    await assertProviderRefreshAllowed(fresh);
    expect((await readProviderHealth(api)).state).toBe('configured');
  });

  it('never stores credential values or raw error bodies', async () => {
    await observeProviderResponse(subject(), Response.json({ error: 'invalid_grant', error_description: 'private-refresh-token' }, { status: 400 }), true);
    const files = await readdir(join(root, 'provider-health'));
    const content = (await Promise.all(files.map((file) => readFile(join(root, 'provider-health', file), 'utf8')))).join('');
    expect(content).not.toContain('private-refresh-token');
    expect(content).not.toContain('error_description');
  });
});
