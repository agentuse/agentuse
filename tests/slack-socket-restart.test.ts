import { describe, expect, it, spyOn } from 'bun:test';
import { SlackApprovalSocket } from '../src/slack/approval';
import { logger } from '../src/utils/logger';

type Deferred = { promise: Promise<void>; resolve: () => void };
const deferred = (): Deferred => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => { resolve = r; });
  return { promise, resolve };
};

function fakeSocket(events: string[], name: string, hooks: { disconnect?: Deferred; start?: Deferred } = {}) {
  return {
    disconnect: async () => {
      events.push(`${name}:disconnect`);
      if (hooks.disconnect) await hooks.disconnect.promise;
    },
    start: async () => {
      events.push(`${name}:start`);
      if (hooks.start) await hooks.start.promise;
      events.push(`${name}:started`);
    },
    removeAllListeners: () => {},
  };
}

async function bridge() {
  return SlackApprovalSocket.create({
    appToken: 'xapp-test',
    botToken: 'xoxb-test',
    onDecision: async () => undefined,
  });
}

describe('Slack socket watchdog restart vs stop', () => {
  it('does not build a replacement socket when stop lands during the old socket teardown', async () => {
    const socket = await bridge();
    const events: string[] = [];
    const teardown = deferred();
    const internals = socket as unknown as { socket: unknown; buildSocket: () => unknown; restart: () => Promise<void> };
    internals.socket = fakeSocket(events, 'old', { disconnect: teardown });
    let built = 0;
    internals.buildSocket = () => { built += 1; return fakeSocket(events, 'new'); };

    const restarting = internals.restart();
    const stopping = socket.stop();
    teardown.resolve();
    await Promise.all([restarting, stopping]);

    expect(built).toBe(0);
    expect(events.some((event) => event.startsWith('new:'))).toBe(false);
  });

  it('disconnects the replacement socket when stop lands while it is starting', async () => {
    const socket = await bridge();
    const events: string[] = [];
    const starting = deferred();
    const internals = socket as unknown as { socket: unknown; buildSocket: () => unknown; restart: () => Promise<void> };
    internals.socket = fakeSocket(events, 'old');
    internals.buildSocket = () => fakeSocket(events, 'new', { start: starting });

    const restarting = internals.restart();
    while (!events.includes('new:start')) await new Promise((resolve) => setTimeout(resolve, 1));
    await socket.stop();
    starting.resolve();
    await restarting;

    expect(events.at(-1)).toBe('new:disconnect');
    expect(events.indexOf('new:started')).toBeLessThan(events.lastIndexOf('new:disconnect'));
  });

  it('still recreates the socket when nothing stops it', async () => {
    const warnSpy = spyOn(logger, 'warn').mockImplementation(() => {});
    try {
      const socket = await bridge();
      const events: string[] = [];
      const internals = socket as unknown as { socket: unknown; buildSocket: () => unknown; restart: () => Promise<void> };
      internals.socket = fakeSocket(events, 'old');
      internals.buildSocket = () => fakeSocket(events, 'new');
      await internals.restart();
      expect(events).toEqual(['old:disconnect', 'new:start', 'new:started']);
      expect(internals.socket).not.toBeNull();
    } finally {
      warnSpy.mockRestore();
    }
  });
});
