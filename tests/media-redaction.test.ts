import { describe, it, expect } from 'bun:test';
import { redactMediaData, estimateInlineMediaTokens } from '../src/tools/media.js';
import { ContextManager } from '../src/context-manager.js';

const BIG_IMAGE_B64 = 'A'.repeat(4_000_000); // ~3MB decoded, ~4MB base64

function toolMessageWith(parts: unknown[]) {
  return {
    role: 'tool',
    content: [
      {
        type: 'tool-result',
        toolCallId: 'c1',
        toolName: 'tools__filesystem_read',
        output: { type: 'content', value: [{ type: 'text', text: '[Read image chart.png]' }, ...parts] },
      },
    ],
  };
}

describe('redactMediaData', () => {
  it('replaces nested media base64 with a short placeholder, leaving the original intact', () => {
    const msg = toolMessageWith([{ type: 'image-data', data: BIG_IMAGE_B64, mediaType: 'image/png' }]);
    const redacted = redactMediaData(msg) as any;
    const part = redacted.content[0].output.value[1];
    expect(part.data).not.toBe(BIG_IMAGE_B64);
    expect(part.data.length).toBeLessThan(60);
    expect(part.data).toContain('image/png');
    expect(part.mediaType).toBe('image/png');
    // original untouched
    expect((msg as any).content[0].output.value[1].data).toBe(BIG_IMAGE_B64);
    // whole thing is far smaller once stringified
    expect(JSON.stringify(redacted).length).toBeLessThan(500);
  });

  it('passes non-media values through unchanged', () => {
    expect(redactMediaData({ role: 'user', content: 'hi' })).toEqual({ role: 'user', content: 'hi' });
    expect(redactMediaData('plain')).toBe('plain');
  });
});

describe('estimateInlineMediaTokens', () => {
  it('counts an image as a small flat cost, not its base64 length', () => {
    const msg = toolMessageWith([{ type: 'image-data', data: BIG_IMAGE_B64, mediaType: 'image/png' }]);
    const tokens = estimateInlineMediaTokens(msg);
    expect(tokens).toBe(1600);
  });

  it('scales a PDF with its size (page estimate)', () => {
    const bigPdf = 'A'.repeat(Math.floor((200 * 1024 * 4) / 3)); // ~200KB decoded
    const tokens = estimateInlineMediaTokens(toolMessageWith([{ type: 'file-data', data: bigPdf, mediaType: 'application/pdf' }]));
    expect(tokens).toBeGreaterThan(1600); // several ~50KB pages
  });

  it('returns 0 when there is no media', () => {
    expect(estimateInlineMediaTokens({ role: 'user', content: 'hello' })).toBe(0);
  });
});

describe('ContextManager does not over-count inline media (P1 regression)', () => {
  it('estimates a 4MB base64 image at ~image tokens, not ~1M text tokens', async () => {
    const cm = new ContextManager('anthropic:claude-sonnet-5');
    await cm.initialize();
    cm.setMessages([
      { role: 'user', content: 'read the chart' } as any,
      toolMessageWith([{ type: 'image-data', data: BIG_IMAGE_B64, mediaType: 'image/png' }]) as any,
    ]);
    const active = cm.getStats().activeTokens;
    // Without the fix: ~4,000,000 / 4 = ~1,000,000 tokens. With the fix: the
    // image counts ~1600 plus a few text tokens.
    expect(active).toBeLessThan(5_000);
    expect(active).toBeGreaterThan(1_000); // media is still counted, not ~0
  });
});
