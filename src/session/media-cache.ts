/**
 * Session-owned media cache for context snapshots.
 *
 * When filesystem_read hands an image/PDF to the model, the AI SDK records the
 * base64 bytes inside the tool-result part of the canonical message history. On
 * suspension that history is persisted to `<sessionDir>/context` for resume. A
 * few multi-MB PDFs would bloat that JSON (and it is rewritten whole on every
 * suspension), so before writing we externalize each media part's bytes to a
 * content-addressed file the session owns, and leave a small reference in the
 * snapshot. On resume we read the bytes back and restore the inline part.
 *
 * Referencing a session-owned copy (not the user's original path) keeps resume
 * reliable: the copy is immutable and lives and dies with the session, so it
 * cannot drift or disappear while a human-in-the-loop approval is pending.
 */

import * as fs from 'fs/promises';
import * as path from 'path';
import { createHash } from 'crypto';
import type { ContextSnapshot } from './types.js';
import { extForMediaType, MEDIA_CONTENT_PART_TYPES } from '../tools/media.js';
import { logger } from '../utils/logger.js';

/** Subdirectory (relative to the session dir) holding externalized media. */
const MEDIA_DIR = 'media';
/** Key that marks a media part whose bytes live in the cache, not inline. */
const REF_KEY = '__mediaCacheRef';

/** Tool-result content parts that carry base64 media (per the AI SDK union). */
const MEDIA_PART_TYPES = MEDIA_CONTENT_PART_TYPES;

type Obj = Record<string, unknown>;

function isObj(v: unknown): v is Obj {
  return typeof v === 'object' && v !== null;
}

/** A media content part with inline base64 (dehydrate input). */
function isInlineMediaPart(part: unknown): part is Obj {
  return (
    isObj(part) &&
    typeof part.type === 'string' &&
    MEDIA_PART_TYPES.has(part.type) &&
    typeof part.data === 'string' &&
    typeof part.mediaType === 'string'
  );
}

/** A media content part whose bytes were externalized (rehydrate input). */
function isRefMediaPart(part: unknown): part is Obj {
  return (
    isObj(part) &&
    typeof part.type === 'string' &&
    MEDIA_PART_TYPES.has(part.type) &&
    typeof part[REF_KEY] === 'string'
  );
}

/** Tool-result part with a multimodal `content` output holding a `value` array. */
function toolResultValue(part: unknown): unknown[] | null {
  if (!isObj(part) || part.type !== 'tool-result') return null;
  const output = part.output;
  if (!isObj(output) || output.type !== 'content' || !Array.isArray(output.value)) return null;
  return output.value;
}

/** Cheap pre-scan: does any message contain a part matching `pred`? */
function hasMatchingPart(messages: unknown[], pred: (part: unknown) => boolean): boolean {
  for (const msg of messages) {
    if (!isObj(msg) || !Array.isArray(msg.content)) continue;
    for (const part of msg.content) {
      const value = toolResultValue(part);
      if (value && value.some(pred)) return true;
    }
  }
  return false;
}

/**
 * Whether any message still carries an inline (un-externalized) media part.
 * Used to decide, at end of a run, whether a context snapshot must be persisted
 * so a later continue-session can replay the image/PDF.
 */
export function messagesContainInlineMedia(messages: unknown[]): boolean {
  return hasMatchingPart(messages, isInlineMediaPart);
}

/**
 * Transform every media part in a snapshot's messages via `mapPart`, cloning
 * only the branches that change. Messages without media are returned by
 * reference. `mapPart` returns the replacement part (or the original to skip).
 */
async function mapMediaParts(
  messages: unknown[],
  mapPart: (part: Obj) => Promise<unknown>
): Promise<unknown[]> {
  return Promise.all(
    messages.map(async (msg) => {
      if (!isObj(msg) || !Array.isArray(msg.content)) return msg;
      let contentChanged = false;
      const newContent = await Promise.all(
        msg.content.map(async (part) => {
          const value = toolResultValue(part);
          if (!value) return part;
          let valueChanged = false;
          const newValue = await Promise.all(
            value.map(async (vp) => {
              const mapped = await mapPart(vp as Obj);
              if (mapped !== vp) valueChanged = true;
              return mapped;
            })
          );
          if (!valueChanged) return part;
          contentChanged = true;
          const p = part as Obj;
          return { ...p, output: { ...(p.output as Obj), value: newValue } };
        })
      );
      if (!contentChanged) return msg;
      return { ...msg, content: newContent };
    })
  );
}

/**
 * Externalize inline media bytes to `<sessionDir>/media/<sha256>.<ext>` and
 * replace them with a reference. Content-addressed, so re-reading the same file
 * dedupes. Defensive: if writing a cache file fails, the part is left inline
 * (base64 in the snapshot) rather than losing the whole snapshot.
 */
export async function dehydrateSnapshotMedia(
  snapshot: ContextSnapshot,
  sessionPath: string
): Promise<ContextSnapshot> {
  const messages = snapshot.messages ?? [];
  if (!hasMatchingPart(messages, isInlineMediaPart)) return snapshot;

  const mediaDir = path.join(sessionPath, MEDIA_DIR);
  const newMessages = await mapMediaParts(messages, async (part) => {
    if (!isInlineMediaPart(part)) return part;
    try {
      const bytes = Buffer.from(part.data as string, 'base64');
      const hash = createHash('sha256').update(bytes).digest('hex');
      const rel = `${MEDIA_DIR}/${hash}.${extForMediaType(part.mediaType as string)}`;
      const abs = path.join(sessionPath, rel);
      await fs.mkdir(mediaDir, { recursive: true });
      // Content-addressed and immutable: only write if not already present.
      try {
        await fs.access(abs);
      } catch {
        await fs.writeFile(abs, bytes);
      }
      const { data: _data, ...rest } = part;
      return { ...rest, [REF_KEY]: rel };
    } catch (err) {
      logger.debug(`[media-cache] Failed to externalize media, leaving inline: ${(err as Error).message}`);
      return part;
    }
  });

  return { ...snapshot, messages: newMessages };
}

/**
 * Restore externalized media bytes back inline so the messages are valid AI SDK
 * ModelMessages for the next streamText call. If a cache file is missing/
 * unreadable, the media part degrades to a text note so the message stays valid
 * and resume still proceeds.
 */
export async function rehydrateSnapshotMedia(
  snapshot: ContextSnapshot,
  sessionPath: string
): Promise<ContextSnapshot> {
  const messages = snapshot.messages ?? [];
  if (!hasMatchingPart(messages, isRefMediaPart)) return snapshot;

  const newMessages = await mapMediaParts(messages, async (part) => {
    if (!isRefMediaPart(part)) return part;
    const rel = part[REF_KEY] as string;
    const { [REF_KEY]: _ref, ...rest } = part;
    try {
      const bytes = await fs.readFile(path.join(sessionPath, rel));
      return { ...rest, data: bytes.toString('base64') };
    } catch (err) {
      logger.debug(`[media-cache] Missing cached media ${rel} on resume: ${(err as Error).message}`);
      return { type: 'text', text: '[media unavailable on resume]' };
    }
  });

  return { ...snapshot, messages: newMessages };
}
