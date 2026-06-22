/**
 * Coerce any thrown/rejected value into a useful human string.
 *
 * `String(error)` on a plain object yields the useless "[object Object]", which
 * then gets persisted as a session error and surfaced in the UI. This extracts a
 * real message instead: Error.message, a string, an object's `message`/`error`
 * field, or a JSON dump as a last resort.
 */
export function toErrorMessage(error: unknown): string {
  if (error == null) return 'Unknown error';
  if (typeof error === 'string') return error;
  if (error instanceof Error) return error.message || error.name || 'Error';
  if (typeof error === 'object') {
    const obj = error as Record<string, unknown>;
    if (typeof obj.message === 'string' && obj.message) return obj.message;
    if (typeof obj.error === 'string' && obj.error) return obj.error;
    try {
      const json = JSON.stringify(error);
      if (json && json !== '{}') return json;
    } catch {
      /* fall through to String() */
    }
  }
  return String(error);
}
