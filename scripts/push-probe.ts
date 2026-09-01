/**
 * Web Push diagnostics for the serve daemon. Run with bun.
 *
 *   bun scripts/push-probe.ts state
 *     Show the daemon's persisted VAPID key + device subscriptions
 *     (~/.local/share/agentuse/push/push-state.json by default;
 *      AGENTUSE_DATA_DIR and XDG_DATA_HOME aware).
 *
 *   bun scripts/push-probe.ts capture [--daemon http://127.0.0.1:12233] [--port 39299]
 *     Subscribe a decryptable mock device to a LIVE daemon, then print every
 *     push it fans out, decrypted, until Ctrl-C (which unsubscribes). Use to
 *     see exactly what payload real devices received.
 *
 *   bun scripts/push-probe.ts send --title "Probe" [--body ...] [--url ...] [--badge N]
 *        [--placement both|top|nested|legacy] [--endpoint-match apple]
 *     Craft one push and send it DIRECTLY to a real subscription (default:
 *     the first web.push.apple.com one) using the daemon's own VAPID keys.
 *     Use to A/B payload shapes against a physical device.
 *
 * Field notes from on-device debugging (iOS 18.7, 2026-07):
 *   - Declarative pushes (web_push: 8030) are displayed natively by iOS; the
 *     service worker's push/notificationclick handlers never run for them.
 *   - iOS 18.7 honors `app_badge` only at the TOP LEVEL of the envelope; it
 *     ignores the nested notification.app_badge shown in the WebKit launch
 *     blog. The daemon sends both placements (--placement both).
 *   - `legacy` (no web_push marker) forces the service-worker path on every
 *     platform — useful to test SW rendering and SW-side setAppBadge.
 *   - A fixture agent that suspends immediately on await_human lives at
 *     agentuse-internal/tmp/push-badge-test.agentuse for end-to-end runs.
 *
 * The mock subscription uses the RFC 8291 Appendix A keypair, so captures
 * decrypt with the published receiver private key below. Never reuse those
 * keys for a real device.
 */

import { createServer } from 'http';
import { readFileSync } from 'fs';
import { join } from 'path';
import { createDecipheriv, createECDH, createHmac, createPrivateKey } from 'crypto';
import { encryptPayload, vapidAuthHeader } from '../src/cli/serve/push';
import { getAgentuseDataDir } from '../src/utils/data-dir';

// RFC 8291 Appendix A keys — public test vector material, safe to commit.
const RFC_P256DH = 'BCVxsr7N_eNgVRqvHtD0zTZsEc6-VV-JvLexhqUzORcxaOzi6-AYWXvTBHm4bjyPjs7Vd8pZGH6SRpkNtoIAiw4';
const RFC_AUTH = 'BTBZMqHH6r4Tts7J_aSIgg';
const RFC_RECEIVER_PRIVATE = 'q1dXpw3UpT5VOmu_cf_v6ih07Aems3njxI-JWgLcM94';

const args = process.argv.slice(2);
const mode = args[0];

function flag(name: string, fallback?: string): string | undefined {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : fallback;
}

function statePath(): string {
  return join(getAgentuseDataDir(), 'push', 'push-state.json');
}

function loadState(): { vapid: { privateJwk: JsonWebKey; publicKey: string }; subscriptions: Array<{ endpoint: string; keys: { p256dh: string; auth: string }; prefs: Record<string, boolean>; userAgent?: string }> } {
  return JSON.parse(readFileSync(statePath(), 'utf-8'));
}

function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = createHmac('sha256', salt).update(ikm).digest();
  return createHmac('sha256', prk).update(Buffer.concat([info, Buffer.from([1])])).digest().subarray(0, length);
}

/** Receiver side of RFC 8291 — what a browser's push stack does. */
function decryptPayload(body: Buffer, receiverPrivate: Buffer, auth: Buffer): Buffer {
  const salt = body.subarray(0, 16);
  const idlen = body.readUInt8(20);
  const senderPub = body.subarray(21, 21 + idlen);
  const ciphertext = body.subarray(21 + idlen, body.length - 16);
  const tag = body.subarray(body.length - 16);
  const receiver = createECDH('prime256v1');
  receiver.setPrivateKey(receiverPrivate);
  const shared = receiver.computeSecret(senderPub);
  const keyInfo = Buffer.concat([Buffer.from('WebPush: info\0'), receiver.getPublicKey(), senderPub]);
  const ikm = hkdf(auth, shared, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from('Content-Encoding: aes128gcm\0'), 16);
  const nonce = hkdf(salt, ikm, Buffer.from('Content-Encoding: nonce\0'), 12);
  const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
  decipher.setAuthTag(tag);
  const padded = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  return padded.subarray(0, padded.lastIndexOf(2));
}

async function main(): Promise<void> {
  if (mode === 'state') {
    const state = loadState();
    console.log('state file:', statePath());
    console.log('vapid public key:', state.vapid.publicKey);
    for (const sub of state.subscriptions) {
      console.log(`- ${sub.endpoint}\n    prefs: ${JSON.stringify(sub.prefs)}  ua: ${(sub.userAgent ?? '').slice(0, 70)}`);
    }
    return;
  }

  if (mode === 'capture') {
    const daemon = flag('daemon', 'http://127.0.0.1:12233')!;
    const port = Number(flag('port', '39299'));
    const endpoint = `http://127.0.0.1:${port}/push-probe`;

    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c));
      req.on('end', () => {
        const body = Buffer.concat(chunks);
        res.writeHead(201);
        res.end();
        try {
          const plain = decryptPayload(body, Buffer.from(RFC_RECEIVER_PRIVATE, 'base64url'), Buffer.from(RFC_AUTH, 'base64url'));
          console.log(`\n[${new Date().toISOString()}] push captured (${body.length}B), decrypted:`);
          console.log(JSON.stringify(JSON.parse(plain.toString()), null, 2));
        } catch (error) {
          console.log('capture decrypt failed:', (error as Error).message);
        }
      });
    });
    await new Promise<void>((resolve) => server.listen(port, '127.0.0.1', resolve));

    const res = await fetch(`${daemon}/api/push/subscription`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        subscription: { endpoint, keys: { p256dh: RFC_P256DH, auth: RFC_AUTH } },
        prefs: { approvals: true, sessions: true },
      }),
    });
    if (!res.ok) throw new Error(`subscribe failed: ${res.status} ${await res.text()}`);
    console.log(`mock device subscribed to ${daemon} (both categories); waiting for pushes — Ctrl-C to stop`);

    const cleanup = async () => {
      await fetch(`${daemon}/api/push/unsubscribe`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ endpoint }),
      }).catch(() => {});
      console.log('\nmock device unsubscribed');
      process.exit(0);
    };
    process.on('SIGINT', cleanup);
    process.on('SIGTERM', cleanup);
    return;
  }

  if (mode === 'send') {
    const state = loadState();
    const match = flag('endpoint-match', 'web.push.apple.com')!;
    const sub = state.subscriptions.find((s) => s.endpoint.includes(match));
    if (!sub) throw new Error(`no subscription matching "${match}" — run: bun scripts/push-probe.ts state`);

    const title = flag('title', 'push-probe')!;
    const body = flag('body', `sent ${new Date().toLocaleTimeString()}`)!;
    const url = flag('url', 'https://example.invalid/probe')!;
    const tag = flag('tag');
    const badge = flag('badge') !== undefined ? Number(flag('badge')) : undefined;
    const placement = flag('placement', 'both');

    let message: Record<string, unknown>;
    if (placement === 'legacy') {
      message = { title, body, url, ...(tag && { tag }), ...(badge !== undefined && { app_badge: badge }) };
    } else {
      message = {
        web_push: 8030,
        ...((placement === 'top' || placement === 'both') && badge !== undefined && { app_badge: badge }),
        notification: {
          title,
          body,
          navigate: url,
          ...(tag && { tag }),
          ...((placement === 'nested' || placement === 'both') && badge !== undefined && { app_badge: badge }),
        },
      };
    }

    const encrypted = encryptPayload(
      Buffer.from(JSON.stringify(message)),
      Buffer.from(sub.keys.p256dh, 'base64url'),
      Buffer.from(sub.keys.auth, 'base64url')
    );
    const priv = createPrivateKey({ key: state.vapid.privateJwk as never, format: 'jwk' });
    const res = await fetch(sub.endpoint, {
      method: 'POST',
      headers: {
        Authorization: vapidAuthHeader(state.vapid as never, priv, new URL(sub.endpoint).origin, 'https://agentuse.io'),
        'Content-Encoding': 'aes128gcm',
        'Content-Type': 'application/octet-stream',
        TTL: '300',
        Urgency: 'high',
      },
      body: new Uint8Array(encrypted),
    });
    console.log('sent:', JSON.stringify(message));
    console.log('push service response:', res.status);
    return;
  }

  console.log('usage: bun scripts/push-probe.ts state|capture|send  (see header for options)');
  process.exit(mode ? 1 : 0);
}

main().catch((error) => {
  console.error((error as Error).message);
  process.exit(1);
});
