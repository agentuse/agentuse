import { describe, expect, it } from 'bun:test';
import { connectWithTimeout } from '../src/mcp';

describe('MCP connection readiness timeout', () => {
  it('bounds HTTP tool discovery and closes an initialized client on timeout', async () => {
    let clientClosed = false;
    let transportClosed = false;
    const never = new Promise<Record<string, never>>(() => {});
    const client = {
      tools: () => never,
      close: async () => { clientClosed = true; },
    };

    await expect(connectWithTimeout(
      'stalled-http',
      { close: async () => { transportClosed = true; } },
      0.01,
      {
        preloadTools: true,
        createClient: async () => client as any,
      }
    )).rejects.toThrow(/connecting and discovering tools/);

    expect(clientClosed).toBe(true);
    expect(transportClosed).toBe(false);
  });
});
