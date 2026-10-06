import { describe, expect, it } from 'bun:test';
import { isAllowedRequestHost, isExposedHost } from '../src/cli/serve/auth';
import { hostForUrl, serverBaseUrl } from '../src/utils/server-registry';

describe('keyless daemon host guard', () => {
  const localOnly = 'http://127.0.0.1:12233';
  const tailnet = 'https://agentuse.example.ts.net';

  it('accepts loopback names on any port', () => {
    for (const host of ['127.0.0.1:12233', 'localhost:12233', 'LOCALHOST', '[::1]:12233', 'app.localhost:12233']) {
      expect(isAllowedRequestHost(host, localOnly)).toBe(true);
    }
  });

  it('accepts the configured public URL host', () => {
    expect(isAllowedRequestHost('agentuse.example.ts.net', tailnet)).toBe(true);
    expect(isAllowedRequestHost('Agentuse.Example.ts.net:443', tailnet)).toBe(true);
  });

  it('refuses any other name, which is what a DNS-rebinding page sends', () => {
    for (const host of ['evil.example:12233', '127.0.0.1.evil.example', 'localhost.evil.example', '192.168.1.5:12233', '[']) {
      expect(isAllowedRequestHost(host, localOnly)).toBe(false);
      expect(isAllowedRequestHost(host, tailnet)).toBe(false);
    }
  });

  it('allows non-browser clients that send no Host', () => {
    expect(isAllowedRequestHost(undefined, localOnly)).toBe(true);
  });
});

describe('daemon URLs', () => {
  it('brackets IPv6 literals', () => {
    expect(hostForUrl('::1')).toBe('[::1]');
    expect(hostForUrl('[::1]')).toBe('[::1]');
    expect(hostForUrl('127.0.0.1')).toBe('127.0.0.1');
    expect(() => new URL('/', `http://${hostForUrl('::1')}:12233`)).not.toThrow();
  });

  it('reaches a wildcard bind on loopback', () => {
    expect(serverBaseUrl({ host: '0.0.0.0', port: 1 })).toBe('http://127.0.0.1:1');
    expect(serverBaseUrl({ host: '::', port: 1 })).toBe('http://127.0.0.1:1');
    expect(serverBaseUrl({ host: '::1', port: 1 })).toBe('http://[::1]:1');
  });
});

describe('isExposedHost', () => {
  it('treats IPv6 loopback as local so a keyless bind is allowed', () => {
    for (const host of ['127.0.0.1', 'localhost', '::1', '[::1]']) expect(isExposedHost(host)).toBe(false);
    for (const host of ['0.0.0.0', '::', '192.168.1.5']) expect(isExposedHost(host)).toBe(true);
  });
});
