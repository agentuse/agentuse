import { readFile, stat } from "fs/promises";
import { join } from "path";
import * as YAML from "yaml";

/**
 * `ABOUT.md` describes the directory it sits in (#156). At a project root it
 * names the project; in a folder inside a project it names that folder. All
 * fields are optional, and the file itself is optional: no file means the UI
 * keeps rendering directory names and paths.
 *
 * Labels, never behavior: nothing here may acquire runtime effects. Anything
 * that *does* something belongs in `.agentuse` files, which is also why this
 * one is `.md` (the extension announces the blast radius of editing it).
 */
export interface AboutInfo {
  /** Display name replacing the directory name / path in the UI. */
  name?: string;
  /** One-line subtitle rendered where the absolute path used to be. */
  description?: string;
  /** Display-only owner label. Must never route notifications. */
  owner?: string;
  /** Markdown after the frontmatter, rendered on the detail surface. */
  body?: string;
}

/** Caps keep a runaway file from bloating list payloads it rides along on. */
const NAME_MAX = 120;
const LINE_MAX = 500;
const BODY_MAX = 32_768;

function cleanLine(value: unknown, max: number): string | undefined {
  if (typeof value !== "string" && typeof value !== "number") return undefined;
  const text = String(value).trim().replace(/\s+/g, " ");
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * Parse raw `ABOUT.md` content. Frontmatter is strict: it only counts when the
 * file starts with a `---` line, a closing `---` line exists, and the block
 * parses to a YAML mapping. Anything else (including a leading horizontal
 * rule in a plain about page) falls through to the body untouched.
 */
export function parseAbout(raw: string): AboutInfo {
  const normalized = raw.replace(/^﻿/, "");
  let body = normalized;
  let meta: Record<string, unknown> | null = null;

  const match = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*(?:\r?\n|$)/.exec(normalized);
  if (match) {
    try {
      const parsed: unknown = YAML.parse(match[1]);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        meta = parsed as Record<string, unknown>;
        body = normalized.slice(match[0].length);
      }
    } catch {
      // Malformed YAML between rules: treat the whole file as body.
    }
  }

  const name = meta ? cleanLine(meta.name, NAME_MAX) : undefined;
  const description = meta ? cleanLine(meta.description, LINE_MAX) : undefined;
  const owner = meta ? cleanLine(meta.owner, LINE_MAX) : undefined;
  const trimmedBody = body.trim();
  return {
    ...(name && { name }),
    ...(description && { description }),
    ...(owner && { owner }),
    ...(trimmedBody && { body: trimmedBody.slice(0, BODY_MAX) }),
  };
}

type CachedAbout = { mtimeMs: number; size: number; about: AboutInfo | null };
const aboutCache = new Map<string, CachedAbout>();

/**
 * Read `<dir>/ABOUT.md`, returning null when absent or unreadable. Cached by
 * mtime+size so list endpoints can call it per request; edits show up live.
 */
export async function readAbout(dir: string): Promise<AboutInfo | null> {
  const filePath = join(dir, "ABOUT.md");
  let fileStat;
  try {
    fileStat = await stat(filePath);
  } catch {
    aboutCache.delete(filePath);
    return null;
  }
  const cached = aboutCache.get(filePath);
  if (cached && cached.mtimeMs === fileStat.mtimeMs && cached.size === fileStat.size) {
    return cached.about;
  }
  let about: AboutInfo | null = null;
  try {
    const parsed = parseAbout(await readFile(filePath, "utf8"));
    about = Object.keys(parsed).length > 0 ? parsed : null;
  } catch {
    about = null;
  }
  aboutCache.set(filePath, { mtimeMs: fileStat.mtimeMs, size: fileStat.size, about });
  return about;
}
