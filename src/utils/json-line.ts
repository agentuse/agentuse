/**
 * Serialize one value for a newline-delimited JSON transport.
 *
 * JSON permits U+2028 (line separator) and U+2029 (paragraph separator) inside
 * strings, and JSON.stringify leaves them literal. Node's readline transport
 * treats those characters as record boundaries, so an otherwise valid worker
 * response can be split into several invalid messages. Escape them explicitly
 * before appending the one ASCII newline that frames the record.
 */
export function stringifyJsonLine(value: unknown): string {
  const json = JSON.stringify(value);
  if (json === undefined) {
    throw new TypeError('JSON-line value is not serializable');
  }
  return `${json.replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029')}\n`;
}
