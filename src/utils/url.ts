/**
 * Return the value only when it is a well-formed http/https URL, else undefined.
 * Agent-supplied artifact/draft URLs are rendered into `href` attributes; without
 * this guard a `javascript:`/`data:` scheme would survive HTML-escaping (it carries
 * no special chars to escape) and execute in the reviewer's browser on click.
 */
export function isHttpUrl(value: string): boolean {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

export function safeHttpUrl(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  return isHttpUrl(value) ? value : undefined;
}
