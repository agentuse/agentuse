import { describe, expect, test } from 'bun:test';
import { mkdtemp, mkdir, readFile, rename, rm, utimes, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  acquireOwnershipLock,
  withOwnershipLock,
} from '../src/utils/ownership-lock';

describe('ownership lock', () => {
  test('renews a live lease so a contender cannot steal a long critical section', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentuse-owner-lock-live-'));
    const lockPath = join(root, 'lock');
    try {
      const holder = await acquireOwnershipLock(lockPath, { staleMs: 45 });
      await Bun.sleep(80);

      await expect(acquireOwnershipLock(lockPath, {
        staleMs: 45,
        retryMs: 5,
        maxWaitMs: 35,
      })).rejects.toThrow('Timed out waiting for lock');

      await holder.release();
      const next = await acquireOwnershipLock(lockPath, { staleMs: 45 });
      await next.release();
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('an old holder cannot delete a replacement lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentuse-owner-lock-release-'));
    const lockPath = join(root, 'lock');
    const displaced = join(root, 'displaced');
    try {
      const oldHolder = await acquireOwnershipLock(lockPath);
      await rename(lockPath, displaced);
      const replacement = await acquireOwnershipLock(lockPath);
      const replacementOwner = await readFile(join(lockPath, 'owner.json'), 'utf8');

      await oldHolder.release();

      expect(await readFile(join(lockPath, 'owner.json'), 'utf8')).toBe(replacementOwner);
      await replacement.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('admits exactly one writer while many contenders reclaim an abandoned lock', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentuse-owner-lock-stress-'));
    const lockPath = join(root, 'lock');
    try {
      for (let round = 0; round < 20; round++) {
        await mkdir(lockPath);
        await writeFile(join(lockPath, 'owner.json'), JSON.stringify({
          token: `dead-${round}`,
          pid: 2_147_483_647,
          acquiredAt: 1,
        }));
        const old = new Date(1);
        await utimes(join(lockPath, 'owner.json'), old, old);

        let active = 0;
        let maxActive = 0;
        await Promise.all(Array.from({ length: 8 }, (_, contender) =>
          withOwnershipLock(lockPath, async () => {
            active++;
            maxActive = Math.max(maxActive, active);
            await Promise.resolve();
            await Bun.sleep(contender % 2);
            active--;
          }, {
            staleMs: 25,
            retryMs: 1,
            maxWaitMs: 2_000,
          })
        ));
        expect(maxActive).toBe(1);
        expect(existsSync(lockPath)).toBe(false);
      }
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test('recovers a stale directory left before owner metadata was written', async () => {
    const root = await mkdtemp(join(tmpdir(), 'agentuse-owner-lock-ownerless-'));
    const lockPath = join(root, 'lock');
    try {
      await mkdir(lockPath);
      const old = new Date(1);
      await utimes(lockPath, old, old);

      const holder = await acquireOwnershipLock(lockPath, {
        staleMs: 25,
        retryMs: 1,
        maxWaitMs: 500,
      });
      expect(JSON.parse(await readFile(join(lockPath, 'owner.json'), 'utf8')).token)
        .toBe(holder.token);
      await holder.release();
      expect(existsSync(lockPath)).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
