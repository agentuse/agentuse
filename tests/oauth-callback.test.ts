import { describe, expect, it } from 'bun:test';
import { createServer } from 'node:http';
import { listenForOAuthCallback } from '../src/auth/oauth-callback';

const saveNothing = async (address: string) => address;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as { port: number }).port;
  await new Promise((resolve) => server.close(resolve));
  return port;
}

describe('ChatGPT sign-in callback', () => {
  it('says Signed in only after the login is saved', async () => {
    const port = await freePort();
    let saved = false;
    const listener = await listenForOAuthCallback('state-1', async (address) => {
      saved = true;
      return new URL(address).searchParams.get('code');
    }, port);
    expect(listener).toBeDefined();
    const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=state-1`);
    expect(saved).toBe(true);
    expect(response.status).toBe(200);
    expect(await response.text()).toContain('Signed in to ChatGPT');
    expect(await listener!.done).toBe('abc');
  });

  it('tells the browser and the caller when saving the login fails', async () => {
    const port = await freePort();
    const listener = await listenForOAuthCallback('state-1', async () => {
      throw new Error('Token exchange failed');
    }, port);
    const settled = listener!.done.then(() => 'resolved', (error: Error) => error.message);
    const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=state-1`);
    expect(response.status).toBe(500);
    const body = await response.text();
    expect(body).not.toContain('Signed in');
    expect(body).toContain('Try again');
    expect(await settled).toBe('Token exchange failed');
  });

  it('ignores a callback from another sign-in', async () => {
    const port = await freePort();
    const listener = await listenForOAuthCallback('state-1', saveNothing, port);
    const response = await fetch(`http://127.0.0.1:${port}/auth/callback?code=abc&state=other`);
    expect(response.status).toBe(400);
    listener!.close();
  });

  it('stops when ChatGPT reports an error', async () => {
    const port = await freePort();
    const listener = await listenForOAuthCallback('state-1', saveNothing, port);
    const settled = listener!.done.then(() => 'resolved', (error: Error) => error.message);
    await fetch(`http://127.0.0.1:${port}/auth/callback?error=access_denied&state=state-1`);
    expect(await settled).toContain('access_denied');
  });

  it('gives up the port to whoever holds it, so the caller can fall back to pasting', async () => {
    const port = await freePort();
    const holder = createServer();
    await new Promise<void>((resolve) => holder.listen(port, '127.0.0.1', resolve));
    try {
      expect(await listenForOAuthCallback('state-1', saveNothing, port)).toBeUndefined();
    } finally {
      await new Promise((resolve) => holder.close(resolve));
    }
  });
});
