import { afterEach, describe, expect, it } from 'bun:test';
import { chooseMachine, daemonUrl, isCloudMode, selectMachine, withMachine, type CloudMachinesPayload } from '../src/cli/serve/web/lib/cloud';
import { renderShellHtml } from '../src/cli/serve/static';

const machine = (id: string, name: string) => ({ id, name, online: true, features: ['http'], compatible: true });

describe('cloud mode machine choice', () => {
  const payload: CloudMachinesPayload = { machines: [machine('a', 'Studio'), machine('b', 'Laptop')], minApiVersion: 1 };

  it('follows a deep link, or the computer that replaced it', () => {
    expect(chooseMachine(payload, 'b', 'a')).toBe('b');
    expect(chooseMachine({ ...payload, resolved: 'a' }, 'gone', 'b')).toBe('a');
    // An unknown link with no successor asks, rather than opening another computer.
    expect(chooseMachine(payload, 'gone', 'a')).toBeUndefined();
  });

  it('otherwise reopens the last computer, else the only one, else asks', () => {
    expect(chooseMachine(payload, undefined, 'a')).toBe('a');
    expect(chooseMachine(payload, undefined, 'revoked')).toBeUndefined();
    expect(chooseMachine({ machines: [machine('only', 'Mac')], minApiVersion: 1 }, undefined, undefined)).toBe('only');
    expect(chooseMachine({ machines: [], minApiVersion: 1 }, undefined, undefined)).toBeUndefined();
  });
});

describe('daemon URLs', () => {
  const globals = globalThis as unknown as { window?: unknown; location?: unknown };
  afterEach(() => {
    delete globals.window;
    delete globals.location;
  });

  it('leaves paths alone outside cloud mode', () => {
    expect(isCloudMode()).toBe(false);
    expect(daemonUrl('/api/agents')).toBe('/api/agents');
  });

  it('prefixes the chosen computer in cloud mode, except account-owned push routes', () => {
    globals.window = { __AGENTUSE_CLOUD__: {} };
    globals.location = new URL('https://cloud.example/sessions/s1?project=p');
    selectMachine('m 1');
    expect(daemonUrl('/api/agents')).toBe('/api/m/m%201/api/agents');
    expect(daemonUrl('/sessions/s1/events')).toBe('/api/m/m%201/sessions/s1/events');
    expect(daemonUrl('/api/push/subscription?endpoint=x')).toBe('/api/push/subscription?endpoint=x');
    expect(withMachine('https://cloud.example/sessions/s1?project=p')).toBe('https://cloud.example/sessions/s1?project=p&m=m+1');
  });
});

describe('shell for a strict CSP host', () => {
  const manifest = { entry: 'main.js', css: ['main.css'], files: ['main.js', 'main.css'] };

  it('puts the nonce on every inline script and style and marks cloud mode', () => {
    const html = renderShellHtml(manifest, { nonce: 'N0NCE', cloudJson: '{"account":"a"}' });
    const inline = [...html.matchAll(/<(script|style)(?![^>]*\bsrc=)([^>]*)>/g)];
    expect(inline.length).toBe(3);
    for (const tag of inline) expect(tag[2]).toContain('nonce="N0NCE"');
    expect(html).toContain('window.__AGENTUSE_CLOUD__ = {"account":"a"};');
  });

  it('is unchanged for serve', () => {
    const html = renderShellHtml(manifest);
    expect(html).not.toContain('nonce=');
    expect(html).not.toContain('__AGENTUSE_CLOUD__');
  });
});
