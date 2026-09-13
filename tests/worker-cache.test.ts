import { afterEach, describe, expect, it } from 'bun:test';
import type { ApprovalInfoResponse } from '../src/worker/cache.js';
import {
  approvalInfoResponseCache,
  withApprovalInfoCache,
} from '../src/worker/cache.js';

function approvalResponse(
  id: string,
  sessionStatus: 'running' | 'completed' | 'error',
  marker: string,
): ApprovalInfoResponse {
  return {
    id,
    success: true,
    approval: { sessionId: 'session-1', sessionStatus, marker },
  } as unknown as ApprovalInfoResponse;
}

function errorResponse(id: string, message: string): ApprovalInfoResponse {
  return {
    id,
    success: false,
    error: { code: 'INTERNAL_ERROR', message },
  } as ApprovalInfoResponse;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

afterEach(() => {
  approvalInfoResponseCache.clear();
});

describe('approval-info response cache', () => {
  it('does not cache unsuccessful responses', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return errorResponse(`loader-${calls}`, 'temporary read failure');
    };

    await expect(withApprovalInfoCache('failure', 'request-1', load)).resolves.toMatchObject({
      success: false,
    });
    await expect(withApprovalInfoCache('failure', 'request-2', load)).resolves.toMatchObject({
      success: false,
    });

    expect(calls).toBe(2);
    expect(approvalInfoResponseCache.has('failure')).toBe(false);
  });

  it('does not cache successful payloads for errored sessions', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      return approvalResponse(`loader-${calls}`, 'error', `result-${calls}`);
    };

    await withApprovalInfoCache('errored-session', 'request-1', load, async () => 'signature');
    await withApprovalInfoCache('errored-session', 'request-2', load, async () => 'signature');

    expect(calls).toBe(2);
    expect(approvalInfoResponseCache.has('errored-session')).toBe(false);
  });

  it('evicts rejected loaders so a later request can retry', async () => {
    let calls = 0;
    const load = async () => {
      calls += 1;
      if (calls === 1) throw new Error('temporary loader failure');
      return approvalResponse('loader-2', 'completed', 'retry');
    };

    await expect(withApprovalInfoCache('rejection', 'request-1', load)).rejects.toThrow(
      'temporary loader failure',
    );
    await expect(withApprovalInfoCache('rejection', 'request-2', load)).resolves.toMatchObject({
      id: 'loader-2',
      success: true,
    });

    expect(calls).toBe(2);
  });

  it('retries an expired in-flight load without letting the stale result overwrite it', async () => {
    const stale = deferred<ApprovalInfoResponse>();
    const staleCall = withApprovalInfoCache('stale-loader', 'request-stale', () => stale.promise);
    const staleEntry = approvalInfoResponseCache.get('stale-loader');
    expect(staleEntry?.promise).toBe(stale.promise);
    staleEntry!.expiresAt = Date.now() - 1;

    const retry = await withApprovalInfoCache('stale-loader', 'request-retry', async () =>
      approvalResponse('loader-retry', 'completed', 'fresh'),
    );
    expect(retry).toMatchObject({
      id: 'loader-retry',
      approval: { marker: 'fresh' },
    });

    stale.resolve(approvalResponse('loader-stale', 'completed', 'stale'));
    await expect(staleCall).resolves.toMatchObject({
      id: 'loader-stale',
      approval: { marker: 'stale' },
    });

    let unexpectedReload = false;
    const cached = await withApprovalInfoCache('stale-loader', 'request-cached', async () => {
      unexpectedReload = true;
      return approvalResponse('loader-unexpected', 'completed', 'unexpected');
    });
    expect(unexpectedReload).toBe(false);
    expect(cached).toMatchObject({
      id: 'request-cached',
      approval: { marker: 'fresh' },
    });
  });

  it('coalesces with an entry populated during an asynchronous signature probe', async () => {
    const signature = deferred<string | null>();
    let waitingLoaderCalls = 0;
    let ownerLoaderCalls = 0;
    const waitingCall = withApprovalInfoCache(
      'probe-race',
      'request-waiting',
      async () => {
        waitingLoaderCalls += 1;
        return approvalResponse('loader-waiting', 'running', 'wrong');
      },
      () => signature.promise,
    );

    const ownerCall = withApprovalInfoCache(
      'probe-race',
      'request-owner',
      async () => {
        ownerLoaderCalls += 1;
        return approvalResponse('loader-owner', 'running', 'shared');
      },
      async () => 'same-signature',
    );
    signature.resolve('same-signature');

    await expect(ownerCall).resolves.toMatchObject({ approval: { marker: 'shared' } });
    await expect(waitingCall).resolves.toMatchObject({
      id: 'request-waiting',
      approval: { marker: 'shared' },
    });
    expect(ownerLoaderCalls).toBe(1);
    expect(waitingLoaderCalls).toBe(0);
  });
});
