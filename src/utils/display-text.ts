/**
 * Repair model-side double escaping in human-facing approval fields. A string
 * that arrives with literal "\n" sequences but no real newline was almost
 * certainly JSON-escaped twice by the model (typical on revise loops, where it
 * reconstructs a field from its own earlier tool call seen escaped in the
 * transcript). Unescape the common sequences for display; any string that
 * already contains a real newline is left untouched.
 */
export function repairEscapedText(value: string): string {
  if (value.includes('\n') || !/\\[nrt"]/.test(value)) return value;
  return value
    .replace(/\\r\\n/g, '\n')
    .replace(/\\n/g, '\n')
    .replace(/\\t/g, '\t')
    .replace(/\\"/g, '"');
}
