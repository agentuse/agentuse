// Deployment display nouns (#156). "Projects" is neutral at best: a founder
// thinks departments, an agency thinks clients, a larger org thinks teams.
// `serve.terms` in config.json lets a deployment rename the category words,
// render layer only: API routes, payload fields, and the CLI keep the
// technical terms, and the `agent` noun is not renameable by design.
//
// Delivery mirrors lib/brand.ts: the server injects the configured map into
// the HTML shell as `window.__AGENTUSE_TERMS__` (static.ts renderShell), so
// it is available synchronously at first render with no fetch and no flash.

declare global {
  interface Window {
    __AGENTUSE_TERMS__?: Record<string, string>;
  }
}

export type TermKey = 'project' | 'folder';

const DEFAULTS: Record<TermKey, string> = {
  project: 'project',
  folder: 'folder',
};

function configured(key: TermKey): string | undefined {
  const value = typeof window !== 'undefined' ? window.__AGENTUSE_TERMS__?.[key] : undefined;
  return typeof value === 'string' && value.trim() ? value.trim() : undefined;
}

/**
 * The deployment's word for a technical noun, e.g. `term('project')` renders
 * "department" on a config with `serve.terms.project = "department"`.
 * Plurals are `term('project', 2)`: naive "+s" unless the configured value
 * carries an explicit "singular|plural".
 */
export function term(key: TermKey, count = 1): string {
  const raw = configured(key) ?? DEFAULTS[key];
  const [singular, plural] = raw.includes('|')
    ? raw.split('|', 2).map((part) => part.trim())
    : [raw, `${raw}s`];
  const one = singular || DEFAULTS[key];
  return count === 1 ? one : (plural || `${one}s`);
}

/** `term()` with the first letter uppercased, for headings and labels. */
export function termTitle(key: TermKey, count = 1): string {
  const word = term(key, count);
  return word.charAt(0).toUpperCase() + word.slice(1);
}
