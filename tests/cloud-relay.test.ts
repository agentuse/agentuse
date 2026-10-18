import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server, ServerWebSocket } from 'bun';
import { writeCloudConnection } from '../src/cloud/config';
import {
  appendRelayAudit,
  dashboardPath,
  isKnownRelayRole,
  isRelayablePath,
  relayedActionName,
  relayedSessionId,
  RELAY_SECRET_HEADER,
  requestActor,
} from '../src/cloud/relay';
import { CloudTunnel, TUNNEL_API_VERSION } from '../src/cloud/tunnel';

const savedConfigDir = process.env.AGENTUSE_CONFIG_DIR;
let configDir: string;

beforeEach(async () => {
  configDir = await mkdtemp(join(tmpdir(), 'cloud-relay-'));
  process.env.AGENTUSE_CONFIG_DIR = configDir;
});

afterEach(async () => {
  if (savedConfigDir === undefined) delete process.env.AGENTUSE_CONFIG_DIR;
  else process.env.AGENTUSE_CONFIG_DIR = savedConfigDir;
  await rm(configDir, { recursive: true, force: true });
});

describe('relay paths', () => {
  it('relays the data routes the dashboard calls and nothing else', () => {
    for (const path of [
      '/api', '/api/agents', '/api/sessions', '/sessions/events', '/sessions/s1/status', '/sessions/s1/events',
      '/sessions/s1/decision', '/sessions/s1/artifacts/out/report.html', '/sessions/s1/learnings/l1/discard',
      '/approvals/s1/status', '/approvals/s1/decision', '/agent-revisions/r1', '/agent-revisions/r1/test-run',
    ]) expect(isRelayablePath(path)).toBe(true);
    for (const path of [
      '/', '/mcp', '/mcp/oauth/callback', '/sessions', '/sessions/s1', '/approvals/s1', '/assets/app.js',
      '/sw.js', '/apix', '/sessions/s1/started', '/sessions/s1/finished',
    ]) expect(isRelayablePath(path)).toBe(false);
  });

  it('names the relayed actions worth recording', () => {
    expect(relayedActionName('POST', '/sessions/s1/decision')).toBe('decision');
    expect(relayedActionName('POST', '/approvals/s1/continue')).toBe('continue');
    expect(relayedActionName('POST', '/api/run')).toBe('run');
    expect(relayedActionName('GET', '/api/run')).toBeUndefined();
    expect(relayedActionName('POST', '/api/agents')).toBeUndefined();
    expect(relayedSessionId('/sessions/a%20b/decision')).toBe('a b');
    expect(dashboardPath('http://127.0.0.1:12233/sessions/s1?project=p#x')).toBe('/sessions/s1?project=p#x');
  });

  it('believes the person headers only with this process secret', () => {
    expect(requestActor({ 'x-agentuse-user': 'mallory', 'x-agentuse-role': 'owner' })).toEqual({ role: 'owner', via: 'local' });
    expect(requestActor({ [RELAY_SECRET_HEADER]: 'guess', 'x-agentuse-user': 'mallory' })).toEqual({ role: 'owner', via: 'local' });
    expect(isKnownRelayRole('owner')).toBe(true);
    expect(isKnownRelayRole('viewer')).toBe(false);
  });

  it('appends one audit line per action', async () => {
    const file = join(configDir, 'cloud', 'relay-audit.jsonl');
    appendRelayAudit(file, { at: 't1', user: 'u1', role: 'owner', action: 'decision', sessionId: 's1', status: 200 });
    appendRelayAudit(file, { at: 't2', role: 'owner', action: 'run', status: 202 });
    const lines = (await readFile(file, 'utf8')).trim().split('\n').map((line) => JSON.parse(line));
    expect(lines.map((line) => line.action)).toEqual(['decision', 'run']);
  });
});

describe('tunnel dashboard frames', () => {
  let cloud: Server;
  let local: Server;
  let cloudSocket: ServerWebSocket<unknown> | undefined;
  let tunnel: CloudTunnel | undefined;
  let releaseStream: (() => void) | undefined;
  let streamCancelled = false;
  const frames: Array<Record<string, unknown>> = [];

  beforeEach(() => {
    frames.length = 0;
    streamCancelled = false;
    local = Bun.serve({
      port: 0,
      fetch: async (request) => {
        const url = new URL(request.url);
        if (url.pathname === '/sessions/events') {
          // A live stream that stays open until the test ends it or the tunnel cancels it.
          const stream = new ReadableStream<Uint8Array>({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('event: sessions\ndata: {}\n\n'));
              releaseStream = () => { try { controller.close(); } catch { /* already cancelled */ } };
            },
            cancel() { streamCancelled = true; },
          });
          return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
        }
        return Response.json({
          method: request.method,
          path: `${url.pathname}${url.search}`,
          body: await request.text(),
          actor: requestActor(Object.fromEntries(request.headers)),
          authorization: request.headers.get('authorization'),
          origin: request.headers.get('origin'),
          cookie: request.headers.get('cookie'),
        }, { headers: { 'Set-Cookie': 'x=1', 'Cache-Control': 'no-store' } });
      },
    });
    cloud = Bun.serve({
      port: 0,
      fetch(request, server) {
        return server.upgrade(request) ? undefined : new Response('no', { status: 400 });
      },
      websocket: {
        open(socket) { cloudSocket = socket; },
        message(_socket, message) { frames.push(JSON.parse(String(message))); },
      },
    });
  });

  afterEach(() => {
    releaseStream?.();
    releaseStream = undefined;
    tunnel?.stop();
    cloud.stop(true);
    local.stop(true);
  });

  const until = async (check: () => boolean) => {
    for (let i = 0; i < 150 && !check(); i += 1) await Bun.sleep(20);
    expect(check()).toBe(true);
  };

  const connect = async () => {
    writeCloudConnection({
      url: `http://127.0.0.1:${cloud.port}`,
      machineId: 'm1',
      machineToken: 'auc_test',
      name: 'Test Mac',
      mcpUrl: `http://127.0.0.1:${cloud.port}/mcp`,
      connectedAt: new Date().toISOString(),
    });
    tunnel = new CloudTunnel({ selfUrl: `http://127.0.0.1:${local.port}`, apiKey: 'operator-key', version: '9.9.9', log: () => {}, watchConfig: false });
    tunnel.start();
    await until(() => tunnel!.state.status === 'connected' && frames.some((frame) => frame.type === 'hello'));
  };

  const answerFor = (id: string) => {
    const start = frames.find((frame) => frame.type === 'http_start' && frame.id === id);
    const body = frames
      .filter((frame) => frame.type === 'http_chunk' && frame.id === id)
      .map((frame) => Buffer.from(String(frame.data), 'base64').toString('utf8'))
      .join('');
    return { start, body, ended: frames.some((frame) => frame.type === 'http_end' && frame.id === id) };
  };

  it('says hello with its version, api version and features', async () => {
    await connect();
    expect(frames.find((frame) => frame.type === 'hello')).toEqual({
      type: 'hello', version: '9.9.9', apiVersion: TUNNEL_API_VERSION, features: ['http', 'notify', 'update'],
    });
    expect(tunnel!.machineId).toBe('m1');
  });

  it('replays a data request with the operator key and relay secret, dropping browser headers', async () => {
    await connect();
    cloudSocket!.send(JSON.stringify({
      type: 'http', id: 'h1', method: 'POST', path: '/api/run?project=p',
      headers: { 'content-type': 'application/json', origin: 'https://evil.example', cookie: 'session=1', 'x-agentuse-user': 'user-1', 'x-agentuse-role': 'owner' },
      body: Buffer.from('{"agent":"a"}').toString('base64'),
    }));
    await until(() => answerFor('h1').ended);
    const { start, body } = answerFor('h1');
    expect(start).toMatchObject({ status: 200 });
    expect((start!.headers as Record<string, string>)['set-cookie']).toBeUndefined();
    expect((start!.headers as Record<string, string>)['cache-control']).toBe('no-store');
    expect(JSON.parse(body)).toEqual({
      method: 'POST', path: '/api/run?project=p', body: '{"agent":"a"}',
      actor: { user: 'user-1', role: 'owner', via: 'cloud' },
      authorization: 'Bearer operator-key', origin: null, cookie: null,
    });
  });

  it('answers 404 for anything that is not a data route', async () => {
    await connect();
    for (const [id, path] of [['p1', '/mcp'], ['p2', '/'], ['p3', 'http://169.254.169.254/latest'], ['p4', '//evil.example/api/x']]) {
      cloudSocket!.send(JSON.stringify({ type: 'http', id, method: 'GET', path }));
    }
    await until(() => ['p1', 'p2', 'p3', 'p4'].every((id) => answerFor(id).ended));
    for (const id of ['p1', 'p2', 'p3', 'p4']) expect(answerFor(id).start).toMatchObject({ status: 404 });
  });

  it('streams a live response and stops it when Cloud cancels', async () => {
    await connect();
    cloudSocket!.send(JSON.stringify({ type: 'http', id: 's1', method: 'GET', path: '/sessions/events', headers: { accept: 'text/event-stream' } }));
    await until(() => answerFor('s1').body.includes('event: sessions'));
    expect(answerFor('s1').start).toMatchObject({ status: 200, headers: { 'content-type': 'text/event-stream' } });
    cloudSocket!.send(JSON.stringify({ type: 'http_cancel', id: 's1' }));
    await until(() => streamCancelled);
    expect(answerFor('s1').ended).toBe(false);
  });

  it('hands notifications to Cloud only after Cloud says it delivers them', async () => {
    await connect();
    const note = { category: 'approvals' as const, title: 'Approve?', body: 'Deploy', url: '/sessions/s1' };
    expect(tunnel!.notify(note)).toBe(false);
    cloudSocket!.send(JSON.stringify({ type: 'hello_ack', features: ['http', 'notify'] }));
    await until(() => tunnel!.deliversNotifications);
    expect(tunnel!.notify(note)).toBe(true);
    await until(() => frames.some((frame) => frame.type === 'notify'));
    expect(frames.find((frame) => frame.type === 'notify')).toEqual({ type: 'notify', ...note });
  });

  it('passes an update request to its owner', async () => {
    let updates = 0;
    writeCloudConnection({
      url: `http://127.0.0.1:${cloud.port}`, machineId: 'm1', machineToken: 'auc_test', name: 'Test Mac',
      mcpUrl: `http://127.0.0.1:${cloud.port}/mcp`, connectedAt: new Date().toISOString(),
    });
    tunnel = new CloudTunnel({ selfUrl: `http://127.0.0.1:${local.port}`, log: () => {}, watchConfig: false, onUpdate: () => { updates += 1; } });
    tunnel.start();
    await until(() => tunnel!.state.status === 'connected');
    cloudSocket!.send(JSON.stringify({ type: 'update' }));
    await until(() => updates === 1);
  });
});
