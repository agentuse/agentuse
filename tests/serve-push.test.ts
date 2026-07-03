import { describe, expect, it, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'fs';
import { join } from 'path';
import { tmpdir } from 'os';
import { createServer, type Server } from 'http';
import { encryptPayload, PushService, SERVICE_WORKER_JS } from '../src/cli/serve/push';

describe('web push encryption', () => {
  it('matches the RFC 8291 Appendix A test vector byte-for-byte', () => {
    const body = encryptPayload(
      Buffer.from('When I grow up, I want to be a watermelon'),
      Buffer.from(
        'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
        'base64url'
      ),
      Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url'),
      {
        salt: Buffer.from('DGv6ra1nlYgDCS1FRnbzlw', 'base64url'),
        privateKey: Buffer.from('yfWPiYE-n46HLnH0KqZOF1fJJU3MYrct3AELtAQ-oRw', 'base64url'),
      }
    );
    expect(body.toString('base64url')).toBe(
      'DGv6ra1nlYgDCS1FRnbzlwAAEABBBP4z9KsN6nGRTbVYI_c7VJSPQTBtkgcy27mlmlMoZIIgDll6e3vCYLocInmYWAmS6TlzAC8wEqKK6PBru3jl7A_yl95bQpu6cVPTpK4Mqgkf1CXztLVBSt2Ks3oZwbuwXPXLWyouBWLVWGNWQexSgSxsj_Qulcy4a-fN'
    );
  });

  it('uses a fresh ephemeral key and salt per message', () => {
    const p256dh = Buffer.from(
      'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4',
      'base64url'
    );
    const auth = Buffer.from('BTBZMqHH6r4Tts7J_aSIgg', 'base64url');
    const a = encryptPayload(Buffer.from('hello'), p256dh, auth);
    const b = encryptPayload(Buffer.from('hello'), p256dh, auth);
    expect(a.equals(b)).toBe(false);
  });
});

describe('PushService', () => {
  let dataDir: string;
  let service: PushService;

  const sub = (endpoint: string) => ({
    endpoint,
    keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
  });

  beforeEach(() => {
    dataDir = mkdtempSync(join(tmpdir(), 'push-test-'));
    service = new PushService(dataDir);
  });

  afterEach(() => {
    rmSync(dataDir, { recursive: true, force: true });
  });

  it('generates a VAPID keypair on first boot and reloads the same one', () => {
    const key = service.publicKey;
    expect(Buffer.from(key, 'base64url').length).toBe(65);
    expect(Buffer.from(key, 'base64url')[0]).toBe(4); // uncompressed point
    const reloaded = new PushService(dataDir);
    expect(reloaded.publicKey).toBe(key);
  });

  it('upserts subscriptions with default-off prefs and merges pref updates', () => {
    const created = service.upsert(sub('https://push.example/a'), { approvals: true });
    expect(created.prefs).toEqual({ approvals: true, sessions: false });

    const updated = service.upsert(sub('https://push.example/a'), { sessions: true });
    expect(updated.prefs).toEqual({ approvals: true, sessions: true });
    expect(service.list()).toHaveLength(1);
  });

  it('persists subscriptions across restarts and removes by endpoint', () => {
    service.upsert(sub('https://push.example/a'), { approvals: true });
    const reloaded = new PushService(dataDir);
    expect(reloaded.get('https://push.example/a')?.prefs.approvals).toBe(true);
    expect(reloaded.remove('https://push.example/a')).toBe(true);
    expect(reloaded.remove('https://push.example/a')).toBe(false);
    expect(new PushService(dataDir).list()).toHaveLength(0);
  });

  it('survives a corrupt state file by starting fresh', () => {
    const file = join(dataDir, 'agentuse', 'push', 'push-state.json');
    service.upsert(sub('https://push.example/a'), {});
    writeFileSync(file, '{nope');
    const fresh = new PushService(dataDir);
    expect(fresh.list()).toHaveLength(0);
    expect(fresh.publicKey.length).toBeGreaterThan(0);
  });
});

describe('PushService delivery against a mock push service', () => {
  let dataDir: string;
  let server: Server;
  let port: number;
  let received: Array<{ url: string; headers: Record<string, string | string[] | undefined>; bodyLength: number }>;
  let respondWith: number;

  beforeEach(async () => {
    dataDir = mkdtempSync(join(tmpdir(), 'push-mock-'));
    received = [];
    respondWith = 201;
    server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        received.push({ url: req.url ?? '', headers: req.headers, bodyLength: Buffer.concat(chunks).length });
        res.writeHead(respondWith);
        res.end();
      });
    });
    port = await new Promise<number>((resolve) => {
      server.listen(0, '127.0.0.1', () => {
        const addr = server.address();
        resolve(typeof addr === 'object' && addr ? addr.port : 0);
      });
    });
  });

  afterEach(() => {
    server.close();
    rmSync(dataDir, { recursive: true, force: true });
  });

  const realSub = (path: string, port: number) => ({
    endpoint: `http://127.0.0.1:${port}${path}`,
    keys: { p256dh: 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4', auth: 'BTBZMqHH6r4Tts7J_aSIgg' },
  });

  it('POSTs an encrypted body with VAPID auth to opted-in subscriptions only', async () => {
    const service = new PushService(dataDir);
    service.upsert(realSub('/dev-a', port), { approvals: true });
    service.upsert(realSub('/dev-b', port), { approvals: false, sessions: true });

    await service.notify('approvals', { title: 'Approval needed', body: 'agent x', url: '/approvals' });

    expect(received).toHaveLength(1);
    const req = received[0]!;
    expect(req.url).toBe('/dev-a');
    expect(req.headers['content-encoding']).toBe('aes128gcm');
    expect(req.headers['urgency']).toBe('high');
    expect(req.headers['ttl']).toBe('86400');
    const auth = req.headers['authorization'] as string;
    expect(auth).toStartWith('vapid t=');
    expect(auth).toContain(`k=${service.publicKey}`);
    // JWT audience must be the push service origin, not the full endpoint.
    const jwt = auth.match(/t=([^,]+),/)?.[1] ?? '';
    const claims = JSON.parse(Buffer.from(jwt.split('.')[1]!, 'base64url').toString());
    expect(claims.aud).toBe(`http://127.0.0.1:${port}`);
    expect(claims.exp).toBeGreaterThan(Date.now() / 1000);
    // Coding header (86) + payload + padding delimiter + GCM tag.
    expect(req.bodyLength).toBeGreaterThan(86);
  });

  it('prunes subscriptions the push service reports gone', async () => {
    respondWith = 410;
    const service = new PushService(dataDir);
    service.upsert(realSub('/dead', port), { sessions: true });
    await service.notify('sessions', { title: 't', body: 'b', url: '/' });
    expect(service.list()).toHaveLength(0);
    // Prune persisted, too.
    expect(new PushService(dataDir).list()).toHaveLength(0);
  });
});

describe('service worker source', () => {
  it('always shows a notification and deep-links on click', () => {
    expect(SERVICE_WORKER_JS).toContain('showNotification');
    expect(SERVICE_WORKER_JS).toContain('notificationclick');
    expect(SERVICE_WORKER_JS).toContain('openWindow');
  });
});
