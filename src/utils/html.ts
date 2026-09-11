/**
 * HTML escaping shared by every surface that builds markup as a string: the
 * serve web bundle and the benchmark report generator. Dependency-free on
 * purpose — it is imported by both browser and node code, so it must never
 * reach for a platform API.
 */

/** Escape untrusted text before inserting it into an HTML string. */
export function escapeHtml(value: unknown): string {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}
