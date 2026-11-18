import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { listenForOAuthCallback } from '../src/auth/oauth-callback';

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('ChatGPT sign-in callback', () => {
  it('hands back the address when the browser returns with the matching state', async () => {
    const port = await freePort();
    const listener = await listenForOAuthCallback('state-1', port);
    expect(listener).toBeDefined();
    const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=state-1`);
    expect(response.status).toBe(200);
    const address = await listener!.address;
    expect(new URL(address).searchParams.get('code')).toBe('abc');
  });

  it('ignores a callback from another sign-in', async () => {
    const port = await freePort();
    const listener = await listenForOAuthCallback('state-1', port);
    const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=other`);
    expect(response.status).toBe(400);
    listener!.close();
  });

  it('stops when ChatGPT reports an error', async () => {
    const port = await freePort();
    const listener = await listenForOAuthCallback('state-1', port);
    const settled = listener!.address.then(() => 'resolved', (error: Error) => error.message);
    await fetch(`http://127.0.0.1:${port}/auth/callback?error=access_denied&state=state-1`);
    expect(await settled).toContain('access_denied');
  });

  it('gives up the port to whoever holds it, so the caller can fall back to pasting', async () => {
    const port = await freePort();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      expect(await listenForOAuthCallback('state-1', port)).toBeUndefined();
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
