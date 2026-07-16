import { describe, expect, it } from 'bun:test';
import {
  FAVICON_SVG,
  TOUCH_ICON_180_PNG_BASE64,
  ICON_192_PNG_BASE64,
  ICON_512_PNG_BASE64,
  WEB_MANIFEST_JSON,
  webManifestJson,
} from '../src/cli/serve/brand';

const TOUCH_ICON_180_PNG = Buffer.from(TOUCH_ICON_180_PNG_BASE64, 'base64');
const ICON_192_PNG = Buffer.from(ICON_192_PNG_BASE64, 'base64');
const ICON_512_PNG = Buffer.from(ICON_512_PNG_BASE64, 'base64');

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

// PNG stores the IHDR width/height as big-endian u32s at fixed offsets.
function pngDimensions(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

describe('brand install assets', () => {
  it('ships valid PNG icons at the advertised sizes', () => {
    for (const [png, size] of [
      [TOUCH_ICON_180_PNG, 180],
      [ICON_192_PNG, 192],
      [ICON_512_PNG, 512],
    ] as const) {
      expect(png.subarray(0, 8).equals(PNG_MAGIC)).toBe(true);
      expect(pngDimensions(png)).toEqual({ width: size, height: size });
    }
  });

  it('web manifest is valid JSON wired to the served icon routes', () => {
    const manifest = JSON.parse(WEB_MANIFEST_JSON);
    expect(manifest.name).toBe('AgentUse');
    expect(manifest.display).toBe('standalone');
    expect(manifest.start_url).toBe('/');
    const srcs = manifest.icons.map((i: { src: string }) => i.src);
    expect(srcs).toContain('/icon-192.png');
    expect(srcs).toContain('/icon-512.png');
    expect(srcs).toContain('/apple-touch-icon.png');
  });

  it('web manifest carries a configured brand name', () => {
    const manifest = JSON.parse(webManifestJson('Kettlebase'));
    expect(manifest.name).toBe('Kettlebase');
    expect(manifest.short_name).toBe('Kettlebase');
    expect(manifest.description).toBe('Kettlebase agent dashboard');
    expect(JSON.parse(webManifestJson()).name).toBe('AgentUse');
  });

  it('favicon remains theme-aware SVG', () => {
    expect(FAVICON_SVG).toContain('prefers-color-scheme:dark');
  });
});
