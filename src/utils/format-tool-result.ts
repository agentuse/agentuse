type UnknownRecord = Record<string, unknown>;

function isRecord(value: unknown): value is UnknownRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function tryParseJson(value: string): unknown | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith('{') && !trimmed.startsWith('[')) {
    return undefined;
  }

  try {
    return JSON.parse(trimmed) as unknown;
  } catch {
    return undefined;
  }
}

function stringifyUnknown(value: unknown): string {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === 'string') {
    return value;
  }

  if (value === null || value === undefined) {
    return String(value);
  }

  if (typeof value !== 'object') {
    return String(value);
  }

  const seen = new WeakSet<object>();
  try {
    return JSON.stringify(value, (_key, nestedValue: unknown) => {
      if (typeof nestedValue === 'object' && nestedValue !== null) {
        if (seen.has(nestedValue)) {
          return '[Circular]';
        }
        seen.add(nestedValue);
      }
      if (nestedValue instanceof Error) {
        return nestedValue.message;
      }
      return nestedValue;
    });
  } catch {
    return String(value);
  }
}

function extractContentText(content: unknown): string | undefined {
  if (typeof content === 'string') {
    return content;
  }

  if (!Array.isArray(content)) {
    return undefined;
  }

  const text = content
    .map(item => {
      if (typeof item === 'string') {
        return item;
      }
      if (isRecord(item) && item.type === 'text' && typeof item.text === 'string') {
        return item.text;
      }
      return undefined;
    })
    .filter((item): item is string => Boolean(item))
    .join('\n\n');

  return text || undefined;
}

function extractReadableMessage(value: unknown, preferError: boolean, seen: WeakSet<object>): string | undefined {
  if (value instanceof Error) {
    return value.message;
  }

  if (typeof value === 'string') {
    if (preferError) {
      const parsed = tryParseJson(value);
      if (parsed !== undefined) {
        return extractReadableMessage(parsed, true, seen) ?? value;
      }
    }
    return value;
  }

  if (!isRecord(value)) {
    return undefined;
  }

  if (seen.has(value)) {
    return '[Circular]';
  }
  seen.add(value);

  if (preferError && value.error !== undefined) {
    return extractReadableMessage(value.error, true, seen) ?? stringifyUnknown(value.error);
  }

  if (typeof value.message === 'string') {
    return value.message;
  }

  if (typeof value.error === 'string') {
    return value.error;
  }

  if (value.output !== undefined) {
    return extractReadableMessage(value.output, preferError, seen) ?? stringifyUnknown(value.output);
  }

  const contentText = extractContentText(value.content);
  if (contentText) {
    return contentText;
  }

  if (value.result !== undefined) {
    return extractReadableMessage(value.result, preferError, seen) ?? stringifyUnknown(value.result);
  }

  if (value.error !== undefined) {
    return extractReadableMessage(value.error, true, seen) ?? stringifyUnknown(value.error);
  }

  return undefined;
}

export function formatToolResultForDisplay(value: unknown, options: { preferError?: boolean } = {}): string {
  return extractReadableMessage(value, options.preferError === true, new WeakSet<object>()) ?? stringifyUnknown(value);
}
