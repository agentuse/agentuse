import { afterEach, beforeEach, describe, expect, it, spyOn } from 'bun:test';
import {
  ApiRequestError,
  createManagedProject,
  fetchAgents,
  fetchSessionArtifacts,
} from '../src/cli/serve/web/lib/api';

const originalLocation = Object.getOwnPropertyDescriptor(globalThis, 'location');
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, 'fetch'>>;

beforeEach(() => {
  Object.defineProperty(globalThis, 'location', {
    configurable: true,
    value: { origin: 'http://localhost:12233' },
  });
  fetchSpy = spyOn(globalThis, 'fetch');
});

afterEach(() => {
  fetchSpy.mockRestore();
  if (originalLocation) Object.defineProperty(globalThis, 'location', originalLocation);
  else Reflect.deleteProperty(globalThis, 'location');
});

describe('dashboard read recovery', () => {
  it('recovers when a daemon becomes reachable during the short retry window', async () => {
    const payload = { success: true, agents: [], errors: [] };
    fetchSpy.mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(Response.json(payload));

    expect(await fetchAgents()).toEqual(payload);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    for (const [url, options] of fetchSpy.mock.calls) {
      expect(String(url)).toBe('http://localhost:12233/api/agents');
      expect(options?.method).toBeUndefined();
    }
  });

  it('surfaces a persistent network failure after three attempts', async () => {
    const failure = new TypeError('Failed to fetch');
    fetchSpy.mockRejectedValue(failure);
    await expect(fetchAgents()).rejects.toBe(failure);
    expect(fetchSpy).toHaveBeenCalledTimes(3);
  });

  it('surfaces HTTP errors immediately', async () => {
    fetchSpy.mockResolvedValue(Response.json({ error: { code: 'UNAUTHORIZED', message: 'Sign in' } }, { status: 401 }));
    await expect(fetchAgents()).rejects.toMatchObject({ status: 401, code: 'UNAUTHORIZED' });
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('does not retry other request errors', async () => {
    fetchSpy.mockRejectedValue(new ApiRequestError(0, 'OTHER', 'Request failed'));
    await expect(fetchAgents()).rejects.toThrow('Request failed');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
  });

  it('cancels a pending retry when the caller aborts', async () => {
    const controller = new AbortController();
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    const request = fetchSessionArtifacts('session-1', undefined, undefined, controller.signal);
    const timer = setTimeout(() => controller.abort(), 10);
    try {
      await expect(request).rejects.toMatchObject({ name: 'AbortError' });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
    } finally {
      clearTimeout(timer);
    }
  });

  it('never replays a write whose response was lost', async () => {
    fetchSpy.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(createManagedProject('Support')).rejects.toThrow('Failed to fetch');
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[1]?.method).toBe('POST');
  });
});
