/**
 * Web Push for the serve daemon: home-screen-installed clients (iOS 16.4+
 * standalone web apps, Android/desktop Chrome) subscribe via the Push API and
 * get notified about pending approvals and session completions.
 *
 * The Web Push protocol is implemented here directly on node:crypto — payload
 * encryption per RFC 8291 (aes128gcm) and VAPID auth per RFC 8292 — so the
 * daemon stays dependency-free. Encryption is verified against the RFC 8291
 * Appendix A test vector in tests/serve-push.test.ts.
 */

import {
  createCipheriv,
  createECDH,
  createHmac,
  createPrivateKey,
  createSign,
  generateKeyPairSync,
  randomBytes,
  type JsonWebKey,
  type KeyObject,
} from "crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "fs";
import { dirname, join } from "path";

export type PushCategory = "approvals" | "sessions";

export interface PushPrefs {
  approvals: boolean;
  sessions: boolean;
}

export interface PushSubscriptionRecord {
  endpoint: string;
  keys: { p256dh: string; auth: string };
  prefs: PushPrefs;
  createdAt: string;
  userAgent?: string;
}

export interface PushPayload {
  title: string;
  body: string;
  /**
   * Absolute URL to open on tap. Must be absolute: it is sent as the
   * Declarative Web Push `navigate` field, which iOS handles at the OS level
   * with no page context to resolve a relative path against.
   */
  url: string;
  /** Notifications with the same tag replace each other on the device. */
  tag?: string;
  /** Sets the installed app's icon badge (iOS 16.4+/Android/desktop PWAs). */
  appBadge?: number;
}

interface VapidKeys {
  /** Private key as a JWK, the only portable serialization node offers. */
  privateJwk: JsonWebKey;
  /** Uncompressed P-256 public point (65 bytes), base64url. */
  publicKey: string;
}

const b64url = (buf: Buffer): string => buf.toString("base64url");
const fromB64url = (s: string): Buffer => Buffer.from(s, "base64url");

function hmac(key: Buffer, data: Buffer): Buffer {
  return createHmac("sha256", key).update(data).digest();
}

/** HKDF-SHA256 limited to one output block (all Web Push derivations need ≤32 bytes). */
function hkdf(salt: Buffer, ikm: Buffer, info: Buffer, length: number): Buffer {
  const prk = hmac(salt, ikm);
  return hmac(prk, Buffer.concat([info, Buffer.from([1])])).subarray(0, length);
}

/**
 * Encrypts a payload for a subscription per RFC 8291 (single record,
 * aes128gcm content coding). Returns the complete request body including the
 * coding header (salt, record size, sender public key).
 */
export function encryptPayload(plaintext: Buffer, p256dh: Buffer, auth: Buffer, seed?: { salt: Buffer; privateKey: Buffer }): Buffer {
  const sender = createECDH("prime256v1");
  if (seed) {
    sender.setPrivateKey(seed.privateKey);
  } else {
    sender.generateKeys();
  }
  const senderPub = sender.getPublicKey();
  const sharedSecret = sender.computeSecret(p256dh);
  const salt = seed?.salt ?? randomBytes(16);

  const keyInfo = Buffer.concat([Buffer.from("WebPush: info\0"), p256dh, senderPub]);
  const ikm = hkdf(auth, sharedSecret, keyInfo, 32);
  const cek = hkdf(salt, ikm, Buffer.from("Content-Encoding: aes128gcm\0"), 16);
  const nonce = hkdf(salt, ikm, Buffer.from("Content-Encoding: nonce\0"), 12);

  // Single record: plaintext, then 0x02 marking the final record.
  const cipher = createCipheriv("aes-128-gcm", cek, nonce);
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.concat([plaintext, Buffer.from([2])])),
    cipher.final(),
    cipher.getAuthTag(),
  ]);

  const header = Buffer.alloc(21);
  salt.copy(header, 0);
  header.writeUInt32BE(4096, 16); // record size
  header.writeUInt8(senderPub.length, 20);
  return Buffer.concat([header, senderPub, ciphertext]);
}

function publicKeyFromJwk(jwk: JsonWebKey): Buffer {
  return Buffer.concat([Buffer.from([4]), fromB64url(jwk.x!), fromB64url(jwk.y!)]);
}

/** Signs a VAPID JWT (ES256) for the given push-service origin, RFC 8292. */
export function vapidAuthHeader(keys: VapidKeys, privateKey: KeyObject, audience: string, subject: string, nowSeconds?: number): string {
  const now = nowSeconds ?? Math.floor(Date.now() / 1000);
  const header = b64url(Buffer.from(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64url(Buffer.from(JSON.stringify({ aud: audience, exp: now + 12 * 3600, sub: subject })));
  const signingInput = `${header}.${claims}`;
  const signature = createSign("SHA256")
    .update(signingInput)
    .sign({ key: privateKey, dsaEncoding: "ieee-p1363" });
  return `vapid t=${signingInput}.${b64url(signature)}, k=${keys.publicKey}`;
}

interface StoreShape {
  vapid?: VapidKeys;
  subscriptions: PushSubscriptionRecord[];
}

/**
 * Push state for one daemon: VAPID keypair (generated on first use) and the
 * device subscriptions, persisted as one JSON file under the XDG data dir.
 * The daemon is a singleton (server registry enforces this) so plain
 * read-modify-write with an atomic rename is sufficient.
 */
export class PushService {
  private readonly file: string;
  private vapid: VapidKeys;
  private vapidPrivate: KeyObject;
  private subscriptions: PushSubscriptionRecord[];
  /** Contact for push services to reach the operator of this sender, per RFC 8292. */
  private readonly subject = "https://agentuse.io";
  private readonly log: (message: string) => void;

  constructor(dataDir: string, log: (message: string) => void = () => {}) {
    this.file = join(dataDir, "agentuse", "push", "push-state.json");
    this.log = log;
    const state = this.load();
    this.subscriptions = state.subscriptions;
    if (state.vapid) {
      this.vapid = state.vapid;
    } else {
      const { privateKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
      const jwk = privateKey.export({ format: "jwk" });
      this.vapid = { privateJwk: jwk, publicKey: b64url(publicKeyFromJwk(jwk)) };
      this.persist();
    }
    this.vapidPrivate = createPrivateKey({ key: this.vapid.privateJwk, format: "jwk" });
  }

  private load(): StoreShape {
    try {
      if (existsSync(this.file)) {
        const parsed = JSON.parse(readFileSync(this.file, "utf-8")) as StoreShape;
        return { subscriptions: parsed.subscriptions ?? [], ...(parsed.vapid && { vapid: parsed.vapid }) };
      }
    } catch (error) {
      this.log(`push: state file unreadable, starting fresh: ${error instanceof Error ? error.message : error}`);
    }
    return { subscriptions: [] };
  }

  private persist(): void {
    mkdirSync(dirname(this.file), { recursive: true });
    const tmp = `${this.file}.tmp`;
    writeFileSync(tmp, JSON.stringify({ vapid: this.vapid, subscriptions: this.subscriptions }, null, 2));
    renameSync(tmp, this.file);
  }

  get publicKey(): string {
    return this.vapid.publicKey;
  }

  list(): PushSubscriptionRecord[] {
    return [...this.subscriptions];
  }

  get(endpoint: string): PushSubscriptionRecord | undefined {
    return this.subscriptions.find((s) => s.endpoint === endpoint);
  }

  upsert(sub: { endpoint: string; keys: { p256dh: string; auth: string } }, prefs: Partial<PushPrefs>, userAgent?: string): PushSubscriptionRecord {
    const existing = this.get(sub.endpoint);
    if (existing) {
      existing.keys = sub.keys;
      existing.prefs = { ...existing.prefs, ...prefs };
      if (userAgent) existing.userAgent = userAgent;
      this.persist();
      return existing;
    }
    const record: PushSubscriptionRecord = {
      endpoint: sub.endpoint,
      keys: sub.keys,
      prefs: { approvals: false, sessions: false, ...prefs },
      createdAt: new Date().toISOString(),
      ...(userAgent && { userAgent }),
    };
    this.subscriptions.push(record);
    this.persist();
    return record;
  }

  remove(endpoint: string): boolean {
    const before = this.subscriptions.length;
    this.subscriptions = this.subscriptions.filter((s) => s.endpoint !== endpoint);
    if (this.subscriptions.length !== before) {
      this.persist();
      return true;
    }
    return false;
  }

  /**
   * Sends one push message. Returns the push service's status code; 404/410
   * mean the subscription is dead and the caller should prune it.
   */
  async send(sub: PushSubscriptionRecord, payload: PushPayload, urgency: "normal" | "high"): Promise<number> {
    // Declarative Web Push format (RFC-8030 homage marker). On iOS 18.4+ the
    // OS shows the notification and performs `navigate` on tap natively —
    // crucial because iOS does not reliably run notificationclick when a
    // killed home-screen app is launched from a notification. Browsers
    // without declarative support fire the regular push event and the
    // service worker renders the same fields imperatively.
    //
    // app_badge is emitted at BOTH levels deliberately: iOS 18.7 (verified
    // on-device 2026-07) only honors the explainer's top-level placement and
    // ignores the nested one from the WebKit launch blog; the nested copy
    // stays for implementations that follow the blog format.
    const message = {
      web_push: 8030,
      ...(payload.appBadge !== undefined && { app_badge: payload.appBadge }),
      notification: {
        title: payload.title,
        body: payload.body,
        navigate: payload.url,
        ...(payload.tag && { tag: payload.tag }),
        ...(payload.appBadge !== undefined && { app_badge: payload.appBadge }),
      },
    };
    const body = encryptPayload(
      Buffer.from(JSON.stringify(message)),
      fromB64url(sub.keys.p256dh),
      fromB64url(sub.keys.auth)
    );
    const audience = new URL(sub.endpoint).origin;
    const res = await fetch(sub.endpoint, {
      method: "POST",
      headers: {
        Authorization: vapidAuthHeader(this.vapid, this.vapidPrivate, audience, this.subject),
        "Content-Encoding": "aes128gcm",
        "Content-Type": "application/octet-stream",
        TTL: "86400",
        Urgency: urgency,
      },
      body: new Uint8Array(body),
    });
    // Push services want the response body consumed even though it's empty.
    await res.arrayBuffer().catch(() => {});
    return res.status;
  }

  /**
   * Fans a notification out to every subscription opted into the category.
   * Fire-and-forget: failures are logged, dead subscriptions pruned.
   */
  async notify(category: PushCategory, payload: PushPayload): Promise<void> {
    const targets = this.subscriptions.filter((s) => s.prefs[category]);
    if (targets.length === 0) return;
    const urgency = category === "approvals" ? "high" : "normal";
    const dead: string[] = [];
    await Promise.all(
      targets.map(async (sub) => {
        try {
          const status = await this.send(sub, payload, urgency);
          if (status === 404 || status === 410) {
            dead.push(sub.endpoint);
          } else if (status >= 400) {
            this.log(`push: ${new URL(sub.endpoint).host} rejected notification (${status})`);
          }
        } catch (error) {
          this.log(`push: send failed: ${error instanceof Error ? error.message : error}`);
        }
      })
    );
    if (dead.length > 0) {
      this.subscriptions = this.subscriptions.filter((s) => !dead.includes(s.endpoint));
      this.persist();
      this.log(`push: pruned ${dead.length} expired subscription(s)`);
    }
  }
}

/**
 * The service worker, served at /sw.js (root scope). Kept minimal: display
 * every push (iOS revokes subscriptions that receive silent pushes) and
 * deep-link to the payload URL on tap.
 *
 * The tap handler cannot rely on clients.openWindow(url) alone: iOS launches
 * a cold web app at start_url and ignores the requested URL. So the target is
 * parked in the Cache API first, and the app finishes the jump on boot (see
 * web/lib/push-nav.ts). Warm windows are focused and told to navigate via
 * postMessage.
 */
export const SERVICE_WORKER_JS = `const NAV_CACHE = "agentuse-push-nav";
const ASSET_CACHE = "agentuse-assets-v1";
const SHELL_KEY = "/__app_shell";
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil((async () => {
  // Drop caches from older SW versions; keep the push-nav cache and the
  // current asset cache (bump ASSET_CACHE's version to force a cold refill).
  const keep = new Set([NAV_CACHE, ASSET_CACHE]);
  for (const name of await caches.keys()) {
    if (!keep.has(name)) await caches.delete(name);
  }
  await clients.claim();
})()));
self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;
  let url;
  try { url = new URL(req.url); } catch { return; }
  if (url.origin !== self.location.origin) return;
  // Never intercept server-sent event streams.
  if ((req.headers.get("accept") || "").includes("text/event-stream")) return;

  // Hashed, immutable build assets: cache-first, served offline once seen.
  if (url.pathname.startsWith("/assets/")) {
    event.respondWith((async () => {
      const cache = await caches.open(ASSET_CACHE);
      const hit = await cache.match(req);
      if (hit) return hit;
      const res = await fetch(req);
      if (res && res.ok) cache.put(req, res.clone());
      return res;
    })());
    return;
  }

  // SPA navigations: network-first so the shell always points at the latest
  // asset hashes; fall back to the last good shell when offline.
  if (req.mode === "navigate") {
    event.respondWith((async () => {
      try {
        const res = await fetch(req);
        if (res && res.ok) {
          const cache = await caches.open(ASSET_CACHE);
          cache.put(SHELL_KEY, res.clone());
        }
        return res;
      } catch (err) {
        const cache = await caches.open(ASSET_CACHE);
        const shell = await cache.match(SHELL_KEY);
        if (shell) return shell;
        throw err;
      }
    })());
    return;
  }
});
self.addEventListener("push", (event) => {
  let data = { title: "AgentUse", body: "", url: "/" };
  try {
    const raw = event.data.json();
    // Payloads are Declarative Web Push JSON (web_push: 8030); on platforms
    // that fire this event instead of handling it natively, render the
    // declared notification imperatively.
    const n = raw && raw.web_push === 8030 ? raw.notification : raw;
    data = { ...data, ...n, url: (n && (n.navigate || n.url)) || "/" };
    if (raw && typeof raw.app_badge !== "undefined") data.app_badge = raw.app_badge;
  } catch {}
  event.waitUntil((async () => {
    if (typeof data.app_badge !== "undefined" && self.navigator.setAppBadge) {
      try { await self.navigator.setAppBadge(Number(data.app_badge) || 0); } catch {}
    }
    await self.registration.showNotification(data.title, {
      body: data.body,
      tag: data.tag,
      icon: "/icon-192.png",
      badge: "/icon-192.png",
      data: { url: data.url },
    });
  })());
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const data = event.notification.data || {};
  const url = new URL(data.url || "/", self.location.origin);
  event.waitUntil((async () => {
    try {
      const cache = await caches.open(NAV_CACHE);
      await cache.put("/pending-navigation", new Response(JSON.stringify({ url: url.href, at: Date.now() })));
    } catch {}
    const wins = await clients.matchAll({ type: "window", includeUncontrolled: true });
    // Prefer a window already on this session (query differences ignored),
    // else reuse any open window rather than stacking a new one.
    const existing = wins.find((w) => new URL(w.url).pathname === url.pathname) || wins[0];
    if (existing) {
      await existing.focus();
      existing.postMessage({ type: "push-navigate", url: url.href });
      return;
    }
    await clients.openWindow(url.href);
  })());
});
`;
