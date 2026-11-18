import { createServer, type Server } from 'node:http';

/** Where ChatGPT sends the browser after sign-in: the address Codex registered, so the same for every app using its client. */
export const CHATGPT_CALLBACK_PORT = 1455;
const CALLBACK_PATH = '/auth/callback';
const LISTEN_MS = 10 * 60_000;

export interface OAuthCallbackListener {
  /** The full callback address, once the browser arrives with the matching state. */
  address: Promise<string>;
  close(): void;
}

const page = (title: string, text: string): string =>
  `<!doctype html><meta charset="utf-8"><title>${title}</title><body style="font:16px system-ui;margin:4rem auto;max-width:28rem;text-align:center"><h1 style="font-size:1.25rem">${title}</h1><p>${text}</p></body>`;

function listen(server: Server, host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    server.once('error', () => resolve(false));
    server.listen(port, host, () => resolve(true));
  });
}

/**
 * Catches ChatGPT's redirect to localhost:1455 so nobody has to copy the
 * address from an error page. Undefined when the port is taken (Codex signing
 * in at the same moment): the caller falls back to pasting the address.
 * Only the sign-in this app started counts: the state must match.
 */
export async function listenForOAuthCallback(
  expectedState: string,
  port = CHATGPT_CALLBACK_PORT,
  timeoutMs = LISTEN_MS,
): Promise<OAuthCallbackListener | undefined> {
  let settle!: { resolve: (address: string) => void; reject: (error: Error) => void };
  const address = new Promise<string>((resolve, reject) => { settle = { resolve, reject }; });
  const handler = (req: import('node:http').IncomingMessage, res: import('node:http').ServerResponse) => {
    const url = new URL(req.url ?? '/', `http://localhost:${port}`);
    if (url.pathname !== CALLBACK_PATH) {
      res.writeHead(404).end();
      return;
    }
    if (url.searchParams.get('state') !== expectedState) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' })
        .end(page('This sign-in is out of date', 'Go back to AgentUse and start signing in again.'));
      return;
    }
    const error = url.searchParams.get('error_description') ?? url.searchParams.get('error');
    if (error) {
      res.writeHead(400, { 'Content-Type': 'text/html; charset=utf-8' }).end(page('ChatGPT sign-in stopped', 'Go back to AgentUse and try again.'));
      settle.reject(new Error(`ChatGPT sign-in stopped: ${error}`));
      return;
    }
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
      .end(page('Signed in to ChatGPT', 'You can close this tab and go back to AgentUse.'));
    settle.resolve(url.toString());
  };

  const ipv4 = createServer(handler);
  if (!await listen(ipv4, '127.0.0.1', port)) return undefined;
  // Browsers may try ::1 for localhost first; serve it too when we can.
  const ipv6 = createServer(handler);
  const hasIpv6 = await listen(ipv6, '::1', port);

  const timer = setTimeout(() => settle.reject(new Error('ChatGPT sign-in timed out. Try again.')), timeoutMs);
  timer.unref?.();
  const close = () => {
    clearTimeout(timer);
    ipv4.close();
    if (hasIpv6) ipv6.close();
  };
  address.then(close, close);
  return { address, close };
}
