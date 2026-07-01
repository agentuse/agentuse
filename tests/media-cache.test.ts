import { describe, it, expect, beforeEach, afterEach } from 'bun:test';
import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { dehydrateSnapshotMedia, rehydrateSnapshotMedia, messagesContainInlineMedia } from '../src/session/media-cache.js';
import type { ContextSnapshot } from '../src/session/types.js';

const IMG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4, 5]);
const IMG_B64 = IMG.toString('base64');

let dir: string;

function snapshotWith(mediaParts: unknown[]): ContextSnapshot {
  return {
    version: 1,
    updatedAt: 42,
    messages: [
      { role: 'user', content: 'hi' },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 'c1',
            toolName: 'tools__filesystem_read',
            output: {
              type: 'content',
              value: [{ type: 'text', text: '[Read image chart.png]' }, ...mediaParts],
            },
          },
        ],
      },
    ],
    usage: {} as ContextSnapshot['usage'],
  };
}

function firstToolValue(snap: ContextSnapshot): any[] {
  return (snap.messages[1] as any).content[0].output.value;
}

beforeEach(async () => {
  dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-mediacache-')));
});

afterEach(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('media-cache dehydrate/rehydrate', () => {
  it('externalizes inline media to a cache file and restores it identically', async () => {
    const original = snapshotWith([{ type: 'image-data', data: IMG_B64, mediaType: 'image/png' }]);

    const lean = await dehydrateSnapshotMedia(original, dir);
    const leanPart = firstToolValue(lean)[1];
    expect(leanPart.data).toBeUndefined();
    expect(typeof leanPart.__mediaCacheRef).toBe('string');
    expect(leanPart.mediaType).toBe('image/png');

    // The bytes now live in a session-owned cache file.
    const cached = await fs.readdir(path.join(dir, 'media'));
    expect(cached.length).toBe(1);
    expect(cached[0].endsWith('.png')).toBe(true);

    const restored = await rehydrateSnapshotMedia(lean, dir);
    const restoredPart = firstToolValue(restored)[1];
    expect(restoredPart.__mediaCacheRef).toBeUndefined();
    expect(restoredPart.data).toBe(IMG_B64);
    // The whole tool-result value round-trips to the original.
    expect(firstToolValue(restored)).toEqual(firstToolValue(original));
  });

  it('returns the snapshot unchanged (by reference) when there is no media', async () => {
    const snap = snapshotWith([]); // only a text part
    const lean = await dehydrateSnapshotMedia(snap, dir);
    expect(lean).toBe(snap);
    const back = await rehydrateSnapshotMedia(snap, dir);
    expect(back).toBe(snap);
    // no media dir was created
    let mediaDirExists = true;
    try {
      await fs.readdir(path.join(dir, 'media'));
    } catch {
      mediaDirExists = false;
    }
    expect(mediaDirExists).toBe(false);
  });

  it('dedupes identical media into a single cache file', async () => {
    const snap = snapshotWith([
      { type: 'image-data', data: IMG_B64, mediaType: 'image/png' },
      { type: 'image-data', data: IMG_B64, mediaType: 'image/png' },
    ]);
    await dehydrateSnapshotMedia(snap, dir);
    const cached = await fs.readdir(path.join(dir, 'media'));
    expect(cached.length).toBe(1);
  });

  it('messagesContainInlineMedia detects inline media (drives the end-of-run snapshot)', async () => {
    const withMedia = snapshotWith([{ type: 'image-data', data: IMG_B64, mediaType: 'image/png' }]);
    expect(messagesContainInlineMedia(withMedia.messages)).toBe(true);
    const textOnly = snapshotWith([]);
    expect(messagesContainInlineMedia(textOnly.messages)).toBe(false);
    // once externalized, it no longer looks "inline"
    const lean = await dehydrateSnapshotMedia(withMedia, dir);
    expect(messagesContainInlineMedia(lean.messages)).toBe(false);
  });

  it('degrades a missing cache file to a text note on resume', async () => {
    const original = snapshotWith([{ type: 'image-data', data: IMG_B64, mediaType: 'image/png' }]);
    const lean = await dehydrateSnapshotMedia(original, dir);
    // simulate the cache file being gone
    await fs.rm(path.join(dir, 'media'), { recursive: true, force: true });

    const restored = await rehydrateSnapshotMedia(lean, dir);
    const part = firstToolValue(restored)[1];
    expect(part).toEqual({ type: 'text', text: '[media unavailable on resume]' });
  });
});
