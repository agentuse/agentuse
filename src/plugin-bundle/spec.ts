import { isAbsolute } from 'path';
import type { PluginSpec } from './types';

/**
 * Parse a plugin spec string from the agent frontmatter `plugins:` array.
 *
 * Supported formats:
 *   - `./relative/path`             → local
 *   - `/absolute/path`              → local
 *   - `~/path`                      → local (home expansion happens in resolver)
 *   - `owner/repo`                  → github repo root
 *   - `owner/repo/sub/path`         → github subdirectory
 *   - `owner/repo@ref`              → github at ref
 *   - `owner/repo/sub/path@ref`     → github subdirectory at ref
 *   - `https://github.com/o/r.git`  → generic git url
 *   - `git@github.com:o/r.git`      → generic git url (ssh)
 */
export function parsePluginSpec(raw: string): PluginSpec {
  const input = raw.trim();
  if (!input) {
    throw new Error('Plugin spec is empty');
  }

  // Local paths
  if (input.startsWith('./') || input.startsWith('../') || input.startsWith('~') || isAbsolute(input)) {
    return { kind: 'local', path: input, raw: input };
  }

  // Generic git URLs (https / ssh)
  if (input.startsWith('http://') || input.startsWith('https://') || input.startsWith('git@') || input.startsWith('ssh://')) {
    const { url, ref } = splitRef(input);
    const { owner, repo } = parseGitUrl(url);
    return { kind: 'git', host: 'generic', owner, repo, url, raw: input, ...(ref ? { ref } : {}) };
  }

  // Shorthand: owner/repo[/subpath][@ref]
  const { url: shorthand, ref } = splitRef(input);
  const segments = shorthand.split('/').filter(Boolean);
  if (segments.length < 2) {
    throw new Error(`Invalid plugin spec "${raw}": expected "owner/repo[/subpath][@ref]" or a path / URL`);
  }
  const [owner, repo, ...rest] = segments;
  const subpath = rest.length > 0 ? rest.join('/') : undefined;

  if (!isValidGithubSegment(owner) || !isValidGithubSegment(repo)) {
    throw new Error(`Invalid plugin spec "${raw}": owner/repo contains invalid characters`);
  }

  return {
    kind: 'git',
    host: 'github',
    owner,
    repo,
    raw: input,
    ...(subpath ? { subpath } : {}),
    ...(ref ? { ref } : {}),
  };
}

function splitRef(input: string): { url: string; ref?: string } {
  // `@` after the last `/` is treated as ref. We must not split on `@` in user@host SSH URLs.
  const lastSlash = input.lastIndexOf('/');
  const at = input.indexOf('@', lastSlash + 1);
  if (at === -1) return { url: input };
  return { url: input.slice(0, at), ref: input.slice(at + 1) };
}

function parseGitUrl(url: string): { owner: string; repo: string } {
  // https://host/owner/repo(.git)
  // git@host:owner/repo(.git)
  // ssh://git@host/owner/repo(.git)
  const cleaned = url.replace(/\.git$/, '');
  const match =
    cleaned.match(/[:/]([^/:]+)\/([^/:]+)$/) ||
    cleaned.match(/^([^/]+)\/([^/]+)$/);
  if (!match) {
    throw new Error(`Cannot parse git URL: ${url}`);
  }
  return { owner: match[1], repo: match[2] };
}

function isValidGithubSegment(s: string): boolean {
  return /^[A-Za-z0-9._-]+$/.test(s);
}
