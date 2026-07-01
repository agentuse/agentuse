/**
 * Media detection and multimodal tool-result plumbing for filesystem_read.
 *
 * filesystem_read historically returned utf-8 text only, so a PNG/PDF came back
 * as mojibake and the model never saw the pixels/pages. This module lets the
 * read tool detect real image/PDF bytes (by magic number, not by extension) and
 * hand them to the model as a multimodal tool result.
 *
 * The base64 bytes ride on a sibling field (`_media`) of the tool result rather
 * than inside `.output`. This matters for two reasons:
 *   1. The model-facing output clamp (clampToolResultForModel) only truncates a
 *      `.output` string and spreads sibling fields untouched, so a multi-MB blob
 *      survives to `toModelOutput` intact.
 *   2. AgentUse persists the tool result's raw value to the session store; the
 *      base64 must be stripped from that copy (see stripInlineMediaData) so the
 *      store keeps a small reference, not megabytes of base64.
 */

import * as path from 'path';

/**
 * Raw-byte caps enforced BEFORE base64 (which inflates ~33%). These mirror the
 * Anthropic provider limits: images ~5MB, PDFs ~32MB (~100 pages). Oversized
 * files return an actionable text error rather than a truncated blob.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_PDF_BYTES = 32 * 1024 * 1024;

export type MediaKind = 'image' | 'pdf';

export interface SniffedMedia {
  mediaType: string;
  kind: MediaKind;
}

/**
 * Inline media payload carried on the tool result for the model path only.
 * `data` is base64. Stripped to a {@link MediaRef} before session persistence.
 */
export interface InlineMedia {
  kind: MediaKind;
  mediaType: string;
  /** base64-encoded file bytes */
  data: string;
  /** raw byte length (pre-base64) */
  bytes: number;
  filename: string;
  /** absolute path the bytes were read from */
  path: string;
}

/** Reference left in the persisted tool result once the base64 is stripped. */
export type MediaRef = Omit<InlineMedia, 'data'>;

/** Sibling field name that carries {@link InlineMedia} on a read tool result. */
export const MEDIA_FIELD = '_media' as const;

/**
 * Tool-result content-part `type`s that carry inline base64 media (per the AI
 * SDK ToolResultOutput union). Shared by the session media cache and the
 * context-manager redaction below.
 */
export const MEDIA_CONTENT_PART_TYPES: ReadonlySet<string> = new Set(['image-data', 'file-data', 'media']);

/** Approximate raw byte length of a base64 string (ignoring padding). */
function base64ByteLength(b64: string): number {
  return Math.floor((b64.length * 3) / 4);
}

// Token weights used to estimate how much context an inline media part occupies.
// Providers tokenize the decoded pixels/pages, NOT the base64 string, so the
// base64 length is a ~1000x overestimate. An image is a small flat cost; a PDF
// scales with its (byte-estimated) page count.
const IMAGE_TOKEN_ESTIMATE = 1600; // ~Anthropic's per-image cap
const PDF_BYTES_PER_PAGE = 50 * 1024; // rough average page weight

function isInlineMediaContentPart(v: unknown): v is Record<string, unknown> {
  return (
    typeof v === 'object' &&
    v !== null &&
    typeof (v as Record<string, unknown>).type === 'string' &&
    MEDIA_CONTENT_PART_TYPES.has((v as Record<string, unknown>).type as string) &&
    typeof (v as Record<string, unknown>).data === 'string' &&
    typeof (v as Record<string, unknown>).mediaType === 'string'
  );
}

/**
 * Deep-copy a value with every inline media part's base64 `data` replaced by a
 * short placeholder. Use before stringifying messages for token estimation or
 * for the compaction summarizer, so a multi-MB image is neither counted as ~1.3M
 * text tokens nor sent to the summarizer as raw base64.
 */
export function redactMediaData(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactMediaData);
  if (value && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    if (isInlineMediaContentPart(obj)) {
      const rawBytes = base64ByteLength(obj.data as string);
      return { ...obj, data: `[${obj.mediaType} ${humanBytes(rawBytes)} omitted]` };
    }
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(obj)) out[k] = redactMediaData(v);
    return out;
  }
  return value;
}

/**
 * Estimate the model-facing token cost of any inline media parts nested in a
 * value (image ~1600, PDF ~1600 per ~50KB page). Added to the char-based text
 * estimate so redacted media is not under-counted to ~zero.
 */
export function estimateInlineMediaTokens(value: unknown): number {
  let total = 0;
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) {
      v.forEach(walk);
      return;
    }
    if (v && typeof v === 'object') {
      const obj = v as Record<string, unknown>;
      if (isInlineMediaContentPart(obj)) {
        const rawBytes = base64ByteLength(obj.data as string);
        const isPdf = obj.type === 'file-data' || obj.mediaType === 'application/pdf';
        total += isPdf
          ? Math.max(1, Math.ceil(rawBytes / PDF_BYTES_PER_PAGE)) * IMAGE_TOKEN_ESTIMATE
          : IMAGE_TOKEN_ESTIMATE;
        return; // do not descend into the media part itself
      }
      Object.values(obj).forEach(walk);
    }
  };
  walk(value);
  return total;
}

export interface MediaToolOutput {
  output: string;
  metadata?: Record<string, unknown>;
  [MEDIA_FIELD]: InlineMedia;
}

/**
 * A single content part in a multimodal tool result. A structural subset of the
 * AI SDK's ToolResultOutput `content` value union (text + image-data/file-data),
 * so a `{ type: 'content', value: MediaContentPart[] }` literal type-checks
 * against the SDK's `toModelOutput` return without importing internal types.
 */
export type MediaContentPart =
  | { type: 'text'; text: string }
  | { type: 'image-data'; data: string; mediaType: string }
  | { type: 'file-data'; data: string; mediaType: string; filename?: string };

/**
 * Detect a supported media type from a file's leading bytes. Returns null for
 * anything else (including a text file with a misleading extension), so the
 * caller falls back to the normal utf-8 text path. Extension is never trusted;
 * only the magic number decides.
 */
export function sniffMediaType(buf: Buffer): SniffedMedia | null {
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (
    buf.length >= 8 &&
    buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47 &&
    buf[4] === 0x0d && buf[5] === 0x0a && buf[6] === 0x1a && buf[7] === 0x0a
  ) {
    return { mediaType: 'image/png', kind: 'image' };
  }
  // JPEG: FF D8 FF
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) {
    return { mediaType: 'image/jpeg', kind: 'image' };
  }
  // GIF: "GIF87a" or "GIF89a"
  if (
    buf.length >= 6 &&
    buf[0] === 0x47 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x38 &&
    (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61
  ) {
    return { mediaType: 'image/gif', kind: 'image' };
  }
  // WebP: "RIFF" .... "WEBP"
  if (
    buf.length >= 12 &&
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) {
    return { mediaType: 'image/webp', kind: 'image' };
  }
  // PDF: "%PDF-"
  if (
    buf.length >= 5 &&
    buf[0] === 0x25 && buf[1] === 0x50 && buf[2] === 0x44 && buf[3] === 0x46 && buf[4] === 0x2d
  ) {
    return { mediaType: 'application/pdf', kind: 'pdf' };
  }
  return null;
}

/** Raw-byte cap for a media kind. */
export function mediaByteCap(kind: MediaKind): number {
  return kind === 'pdf' ? MAX_PDF_BYTES : MAX_IMAGE_BYTES;
}

/** Human-readable byte size for error/response text. */
export function humanBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

/** File extension (without dot) for a media type, used to name cache files. */
export function extForMediaType(mediaType: string): string {
  switch (mediaType) {
    case 'image/png': return 'png';
    case 'image/jpeg': return 'jpg';
    case 'image/gif': return 'gif';
    case 'image/webp': return 'webp';
    case 'application/pdf': return 'pdf';
    default: return 'bin';
  }
}

/** Type guard: a read tool result carrying inline media. */
export function isMediaToolOutput(value: unknown): value is MediaToolOutput {
  return (
    typeof value === 'object' &&
    value !== null &&
    MEDIA_FIELD in value &&
    typeof (value as Record<string, unknown>)[MEDIA_FIELD] === 'object' &&
    (value as MediaToolOutput)[MEDIA_FIELD] !== null &&
    typeof (value as MediaToolOutput)[MEDIA_FIELD].data === 'string'
  );
}

/**
 * Build the multimodal content-part array the model sees: a short text caption
 * followed by the image/PDF part. Images use `image-data`, PDFs use `file-data`
 * (the current AI SDK variants; the older `media` type is deprecated).
 */
export function buildMediaContentValue(media: InlineMedia, caption: string): MediaContentPart[] {
  const mediaPart: MediaContentPart =
    media.kind === 'pdf'
      ? { type: 'file-data', data: media.data, mediaType: media.mediaType, filename: media.filename }
      : { type: 'image-data', data: media.data, mediaType: media.mediaType };
  return [{ type: 'text', text: caption }, mediaPart];
}

/**
 * Drop the base64 from a tool result before it is persisted to the session
 * store / traces, leaving a lightweight {@link MediaRef}. Returns a shallow
 * copy so the original object the AI SDK holds (and later hands to
 * `toModelOutput`) keeps its bytes. Non-media results pass through untouched.
 */
export function stripInlineMediaData(output: unknown): unknown {
  if (!isMediaToolOutput(output)) return output;
  const { data: _data, ...ref } = output[MEDIA_FIELD];
  return { ...output, [MEDIA_FIELD]: ref satisfies MediaRef };
}

/** Basename helper shared by the read tool and tests. */
export function mediaFilename(filePath: string): string {
  return path.basename(filePath);
}
