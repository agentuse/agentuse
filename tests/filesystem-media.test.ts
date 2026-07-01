import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import * as fs from 'fs/promises';
import { realpathSync } from 'fs';
import * as os from 'os';
import * as path from 'path';
import { createReadTool } from '../src/tools/filesystem.js';
import {
  sniffMediaType,
  MAX_IMAGE_BYTES,
  isMediaToolOutput,
  stripInlineMediaData,
} from '../src/tools/media.js';
import { clampToolResultForModel } from '../src/tools/tool-output-limits.js';
import type { FilesystemPathConfig } from '../src/tools/types.js';
import type { PathResolverContext } from '../src/tools/path-validator.js';

// --- Minimal but signature-correct media buffers (magic bytes + filler) ---
const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('png-body-bytes')]);
const JPEG = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.from('jpeg-body')]);
const GIF = Buffer.concat([Buffer.from('GIF89a'), Buffer.from('gif-body')]);
const WEBP = Buffer.concat([Buffer.from('RIFF'), Buffer.from([0x00, 0x00, 0x00, 0x00]), Buffer.from('WEBP'), Buffer.from('webp-body')]);
const PDF = Buffer.from('%PDF-1.4\n1 0 obj\n<<>>\nendobj\n');
const TEXT_MISNAMED = Buffer.from('this is plain text, not really a png\nline two\n');

let dir: string;

async function write(name: string, bytes: Buffer): Promise<string> {
  const p = path.join(dir, name);
  await fs.writeFile(p, bytes);
  return p;
}

function makeTool(
  modelInputModalities: string[] | undefined,
  mediaToolResultSupport?: { image: boolean; pdf: boolean }
) {
  const configs: FilesystemPathConfig[] = [{ path: dir, permissions: ['read'] }];
  const ctx: PathResolverContext = {
    projectRoot: dir,
    modelId: 'anthropic:test-model',
    modelInputModalities,
    ...(mediaToolResultSupport ? { mediaToolResultSupport } : {}),
  };
  return createReadTool(configs, ctx) as any;
}

beforeAll(async () => {
  dir = realpathSync(await fs.mkdtemp(path.join(os.tmpdir(), 'agentuse-media-')));
});

afterAll(async () => {
  await fs.rm(dir, { recursive: true, force: true });
});

describe('sniffMediaType', () => {
  it('detects png/jpeg/gif/webp/pdf by magic bytes', () => {
    expect(sniffMediaType(PNG)).toEqual({ mediaType: 'image/png', kind: 'image' });
    expect(sniffMediaType(JPEG)).toEqual({ mediaType: 'image/jpeg', kind: 'image' });
    expect(sniffMediaType(GIF)).toEqual({ mediaType: 'image/gif', kind: 'image' });
    expect(sniffMediaType(WEBP)).toEqual({ mediaType: 'image/webp', kind: 'image' });
    expect(sniffMediaType(PDF)).toEqual({ mediaType: 'application/pdf', kind: 'pdf' });
  });

  it('returns null for a text file (even if misnamed .png)', () => {
    expect(sniffMediaType(TEXT_MISNAMED)).toBeNull();
    expect(sniffMediaType(Buffer.alloc(0))).toBeNull();
  });
});

describe('filesystem_read media path (vision-capable model)', () => {
  it('reads a PNG as a base64 image media part', async () => {
    const tool = makeTool(['text', 'image', 'pdf']);
    const p = await write('chart.png', PNG);
    const result = await tool.execute({ file_path: p });

    expect(isMediaToolOutput(result)).toBe(true);
    expect(result._media.mediaType).toBe('image/png');
    expect(result._media.kind).toBe('image');
    // base64 round-trips to the exact bytes
    expect(Buffer.from(result._media.data, 'base64').equals(PNG)).toBe(true);
    expect(typeof result.output).toBe('string');
    expect(result.output).toContain('chart.png');

    const modelOut = await tool.toModelOutput({ output: result });
    expect(modelOut.type).toBe('content');
    const parts = modelOut.value;
    expect(parts[0]).toEqual({ type: 'text', text: result.output });
    expect(parts[1]).toEqual({ type: 'image-data', data: result._media.data, mediaType: 'image/png' });
  });

  it('reads a PDF as a file-data part with filename', async () => {
    const tool = makeTool(['text', 'image', 'pdf']);
    const p = await write('doc.pdf', PDF);
    const result = await tool.execute({ file_path: p });

    expect(result._media.kind).toBe('pdf');
    const modelOut = await tool.toModelOutput({ output: result });
    expect(modelOut.value[1]).toEqual({
      type: 'file-data',
      data: result._media.data,
      mediaType: 'application/pdf',
      filename: 'doc.pdf',
    });
  });

  it('notes that offset/limit are ignored for media', async () => {
    const tool = makeTool(['text', 'image', 'pdf']);
    const p = await write('with-paging.png', PNG);
    const result = await tool.execute({ file_path: p, offset: 5, limit: 10 });
    expect(result.output).toContain('offset/limit ignored');
  });

  it('rejects a file over the image size cap with a text error', async () => {
    const tool = makeTool(['text', 'image', 'pdf']);
    const big = Buffer.alloc(MAX_IMAGE_BYTES + 1);
    // stamp PNG signature so it sniffs as an image
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).copy(big);
    const p = await write('huge.png', big);
    const result = await tool.execute({ file_path: p });

    expect(isMediaToolOutput(result)).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('exceeds');
  });
});

describe('filesystem_read capability gate (text-only model)', () => {
  it('returns a text error instead of a media part when the model lacks image input', async () => {
    const tool = makeTool(['text']);
    const p = await write('chart2.png', PNG);
    const result = await tool.execute({ file_path: p });

    expect(isMediaToolOutput(result)).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('does not accept image input');
    // toModelOutput falls back to the default json shape for the error envelope
    const modelOut = await tool.toModelOutput({ output: result });
    expect(modelOut.type).toBe('json');
  });

  it('still attempts media when the model is unknown (no modalities)', async () => {
    const tool = makeTool(undefined);
    const p = await write('chart3.png', PNG);
    const result = await tool.execute({ file_path: p });
    expect(isMediaToolOutput(result)).toBe(true);
  });
});

describe('filesystem_read transport gate', () => {
  it('returns a text error when the transport cannot deliver images (e.g. OpenAI chat / OpenRouter)', async () => {
    const tool = makeTool(['text', 'image', 'pdf'], { image: false, pdf: false });
    const p = await write('chart-transport.png', PNG);
    const result = await tool.execute({ file_path: p });

    expect(isMediaToolOutput(result)).toBe(false);
    const parsed = JSON.parse(result.output);
    expect(parsed.success).toBe(false);
    expect(parsed.error).toContain('cannot deliver');
  });

  it('allows images but rejects PDFs when transport supports image only (e.g. Bedrock)', async () => {
    const tool = makeTool(['text', 'image', 'pdf'], { image: true, pdf: false });
    const png = await write('ok.png', PNG);
    const pngResult = await tool.execute({ file_path: png });
    expect(isMediaToolOutput(pngResult)).toBe(true);

    const pdf = await write('blocked.pdf', PDF);
    const pdfResult = await tool.execute({ file_path: pdf });
    expect(isMediaToolOutput(pdfResult)).toBe(false);
    expect(JSON.parse(pdfResult.output).error).toContain('cannot deliver');
  });
});

describe('filesystem_read text path is unchanged', () => {
  it('returns line-numbered text for a plain file (incl. misnamed .png)', async () => {
    const tool = makeTool(['text', 'image', 'pdf']);
    const p = await write('notes.png', TEXT_MISNAMED); // misnamed, but sniffs as text
    const result = await tool.execute({ file_path: p });

    expect(isMediaToolOutput(result)).toBe(false);
    expect(result._media).toBeUndefined();
    // cat -n style: right-padded line numbers, tab, content
    expect(result.output).toBe(
      '1\tthis is plain text, not really a png\n2\tline two\n3\t'
    );

    const modelOut = await tool.toModelOutput({ output: result });
    expect(modelOut).toEqual({ type: 'json', value: result });
  });
});

describe('stripInlineMediaData', () => {
  it('removes base64 but keeps a reference, without mutating the original', async () => {
    const tool = makeTool(['text', 'image', 'pdf']);
    const p = await write('strip.png', PNG);
    const result = await tool.execute({ file_path: p });

    const stripped = stripInlineMediaData(result) as any;
    expect(stripped._media.data).toBeUndefined();
    expect(stripped._media.mediaType).toBe('image/png');
    expect(stripped._media.bytes).toBe(PNG.length);
    // original object still has its bytes (SDK toModelOutput relies on this)
    expect(result._media.data).toBeDefined();
    expect(stripped).not.toBe(result);
  });

  it('passes non-media results through untouched', () => {
    const textResult = { output: 'hello' };
    expect(stripInlineMediaData(textResult)).toBe(textResult);
  });
});

describe('clamp preserves inline media (load-bearing invariant)', () => {
  // The model-facing output clamp (limitModelFacingToolOutputs) runs on the
  // execute return BEFORE toModelOutput. It must only touch `.output` and leave
  // the `_media` sibling (the base64) intact, or media reads silently break.
  it('leaves the _media base64 untouched when output is a short caption', () => {
    const media = { kind: 'image', mediaType: 'image/png', data: 'AQID', bytes: 3, filename: 'x.png', path: '/x.png' };
    const clamped = clampToolResultForModel({ output: '[Read image x.png]', _media: media });
    expect(clamped.truncated).toBe(false);
    expect((clamped.value as any)._media).toEqual(media);
    expect(isMediaToolOutput(clamped.value)).toBe(true);
  });
});
